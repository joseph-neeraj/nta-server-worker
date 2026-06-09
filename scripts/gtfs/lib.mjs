// Pure functions shared between generate-sql.mjs and the unit-test suite.
// No side effects, no I/O — safe to import in tests.
import { createHash } from 'crypto';

export const ROWS_PER_INSERT = 500;

// ── CSV parser ────────────────────────────────────────────────────

export function parseCSV(text) {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim().split('\n');
  const headers = parseLine(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const vals = parseLine(lines[i]);
    const row = {};
    headers.forEach((h, j) => { row[h] = vals[j] ?? ''; });
    rows.push(row);
  }
  return rows;
}

// Generator variant — yields rows one at a time so we never hold the full
// new-file array in memory while the oldIndex Map is still live.
export function* streamCSV(text) {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim().split('\n');
  const headers = parseLine(lines[0]);
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const vals = parseLine(lines[i]);
    const row = {};
    headers.forEach((h, j) => { row[h] = vals[j] ?? ''; });
    yield row;
  }
}

export function parseLine(line) {
  const result = [];
  let cur = '', inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { cur += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) { result.push(cur); cur = ''; }
    else cur += ch;
  }
  result.push(cur);
  return result;
}

// ── SQL helpers ───────────────────────────────────────────────────

export function lit(val) {
  if (val === '' || val == null) return 'NULL';
  return "'" + String(val).replace(/'/g, "''") + "'";
}

// Full-mode: insert into shadow *_new table
export function writeInserts(stream, table, columns, rows) {
  const colList = columns.join(',');
  for (let i = 0; i < rows.length; i += ROWS_PER_INSERT) {
    const batch = rows.slice(i, i + ROWS_PER_INSERT);
    const values = batch.map(r => `(${columns.map(c => lit(r[c])).join(',')})`).join(',\n  ');
    stream.write(`INSERT INTO ${table}_new (${colList}) VALUES\n  ${values};\n`);
  }
}

// Diff-mode: upsert directly into live table
export function writeUpserts(stream, table, columns, rows) {
  const colList = columns.join(',');
  for (let i = 0; i < rows.length; i += ROWS_PER_INSERT) {
    const batch = rows.slice(i, i + ROWS_PER_INSERT);
    const values = batch.map(r => `(${columns.map(c => lit(r[c])).join(',')})`).join(',\n  ');
    stream.write(`INSERT OR REPLACE INTO ${table} (${colList}) VALUES\n  ${values};\n`);
  }
}

export function writeDeletes(stream, table, pks, rows) {
  if (rows.length === 0) return;
  for (let i = 0; i < rows.length; i += ROWS_PER_INSERT) {
    const batch = rows.slice(i, i + ROWS_PER_INSERT);
    if (pks.length === 1) {
      const pk = pks[0];
      stream.write(`DELETE FROM ${table} WHERE ${pk} IN (${batch.map(r => lit(r[pk])).join(', ')});\n`);
    } else {
      // SQLite supports tuple IN: WHERE (a,b) IN ((v1,v2), ...)
      const tuples = batch.map(r => `(${pks.map(pk => lit(r[pk])).join(',')})`).join(', ');
      stream.write(`DELETE FROM ${table} WHERE (${pks.join(',')}) IN (${tuples});\n`);
    }
  }
}

// ── Diff logic ────────────────────────────────────────────────────

// Row-level diff between oldRows (array) and newText (raw CSV string).
//
// Memory strategy: build a compact Map(pkKey → joinedValues) from old rows,
// then clear the row objects. Stream new rows one at a time via the generator.
// Delete from the Map as each new-row key is seen — whatever remains after the
// loop are deleted rows. Peak memory ≈ oldIndex (~1-2 GB for stop_times) plus
// the raw new CSV text string. No full new-rows array is ever materialised.
//
// transformRow: optional fn(row) → row applied to each new row before comparison.
// Used by trips to normalise shape_id through the shape rename map so trips that
// only changed because their shape was renamed don't appear as updates.
export function computeDiff(oldRows, newText, pks, columns, transformRow = null) {
  const makeKey = row => pks.map(pk => row[pk]).join('\0');
  const makeVal = row => columns.map(c => row[c]).join('\0');

  const oldIndex = new Map();
  for (const row of oldRows) oldIndex.set(makeKey(row), makeVal(row));
  oldRows.length = 0; // free row objects so GC can reclaim before we process new text

  const toUpsert = [];

  for (const row of streamCSV(newText)) {
    const effectiveRow = transformRow ? transformRow(row) : row;
    const key = makeKey(effectiveRow);
    const oldVal = oldIndex.get(key);
    oldIndex.delete(key); // mark seen; entries remaining after full scan = deleted
    if (oldVal === undefined || oldVal !== makeVal(effectiveRow)) {
      toUpsert.push(effectiveRow);
    }
  }

  // Keys still in oldIndex were absent from new file → deleted rows
  const toDelete = [];
  for (const [key] of oldIndex) {
    const pkVals = key.split('\0');
    const row = {};
    pks.forEach((pk, i) => { row[pk] = pkVals[i]; });
    toDelete.push(row);
  }

  return { toUpsert, toDelete };
}

// ── Shape geometry fingerprinting ─────────────────────────────────
// NTA renames shape_ids daily without changing GPS points. These functions
// detect geometry-identical renames so the ~882K wasteful row writes they
// would otherwise cause are skipped.

// Reads shapes.txt from a zip and returns:
//   idToHash: Map<shape_id, geoHash>  (fingerprint of sorted lat/lon sequence)
//   hashToId: Map<geoHash, shape_id>  (reverse lookup)
// Hash covers lat/lon only — shape_dist_traveled is excluded so minor
// distance recalculations don't trigger false "new geometry" classifications.
export function buildGeoHashIndex(zip) {
  const entry = zip.getEntry('shapes.txt');
  if (!entry) return { idToHash: new Map(), hashToId: new Map() };

  const byId = new Map(); // shape_id → [{ seq, lat, lon }]
  for (const row of streamCSV(entry.getData().toString('utf8'))) {
    if (!byId.has(row.shape_id)) byId.set(row.shape_id, []);
    byId.get(row.shape_id).push({
      seq: parseInt(row.shape_pt_sequence, 10),
      lat: row.shape_pt_lat,
      lon: row.shape_pt_lon,
    });
  }

  const idToHash = new Map();
  const hashToId = new Map();
  for (const [shapeId, pts] of byId) {
    pts.sort((a, b) => a.seq - b.seq);
    const payload = pts.map(p => `${p.lat},${p.lon}`).join('|');
    const hash = createHash('sha256').update(payload).digest('hex').slice(0, 16);
    idToHash.set(shapeId, hash);
    hashToId.set(hash, shapeId);
  }
  byId.clear();
  return { idToHash, hashToId };
}

// Returns Map<newShapeId, oldShapeId> for shapes whose shape_id changed between
// feeds but whose geometry (lat/lon sequence) is identical.
//
// Only maps newId → oldId when oldId is absent from the new feed. If oldId still
// exists in the new feed under the same name, that shape must be compared normally
// rather than excluded from the oldIndex.
export function buildRenameMap(oldIndex, newIndex) {
  const renameMap = new Map();
  for (const [newId, newHash] of newIndex.idToHash) {
    if (oldIndex.idToHash.has(newId)) continue; // same ID in old feed — not a rename
    const oldId = oldIndex.hashToId.get(newHash);
    if (oldId && !newIndex.idToHash.has(oldId)) {
      // oldId is gone from new feed — its geometry now lives under newId
      renameMap.set(newId, oldId);
    }
  }
  return renameMap;
}

// Shape-specific diff that skips geometry-identical renames.
//   toUpsert: only shapes with genuinely new/changed geometry
//   toDelete: only shapes whose geometry no longer appears anywhere in the new feed
export function computeShapeDiff(oldRows, newText, columns, renameMap) {
  const makeKey = row => `${row.shape_id}\0${row.shape_pt_sequence}`;
  const makeVal = row => columns.map(c => row[c]).join('\0');

  // Old shape_ids that are being "kept": their geometry still exists in the new
  // feed under a new name, so their D1 rows must not be deleted.
  const keptOldIds = new Set(renameMap.values());

  const oldIndex = new Map();
  for (const row of oldRows) {
    if (!keptOldIds.has(row.shape_id)) oldIndex.set(makeKey(row), makeVal(row));
  }
  oldRows.length = 0;

  const toUpsert = [];
  for (const row of streamCSV(newText)) {
    if (renameMap.has(row.shape_id)) continue; // geometry already in D1 under old name
    const key = makeKey(row);
    const oldVal = oldIndex.get(key);
    oldIndex.delete(key);
    if (oldVal === undefined || oldVal !== makeVal(row)) toUpsert.push(row);
  }

  const toDelete = [];
  for (const [key] of oldIndex) {
    const [shape_id, shape_pt_sequence] = key.split('\0');
    toDelete.push({ shape_id, shape_pt_sequence });
  }

  return { toUpsert, toDelete };
}

export function getFeedVersion(zip) {
  const entry = zip.getEntry('feed_info.txt');
  if (!entry) return null;
  const rows = parseCSV(entry.getData().toString('utf8'));
  return rows[0]?.feed_version ?? null;
}
