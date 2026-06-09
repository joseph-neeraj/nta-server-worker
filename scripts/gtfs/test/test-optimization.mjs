#!/usr/bin/env node
// Compares old vs new diff counts for shapes and trips between two GTFS zips.
// Runs both the unoptimised diff and the optimised (shape-rename-aware) diff
// and shows the savings side by side. Does NOT write any SQL or modify state.
//
// Usage (from project root):
//   node scripts/gtfs/test/test-optimization.mjs [old.zip] [new.zip]
//
// Defaults to the sample zips in this directory:
//   scripts/gtfs/test/old.zip  (baseline feed)
//   scripts/gtfs/test/new.zip  (updated feed)

import AdmZip from 'adm-zip';
import { createHash } from 'crypto';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const [,, arg1, arg2] = process.argv;
const oldZipPath = arg1 ?? resolve(__dirname, 'old.zip');
const newZipPath = arg2 ?? resolve(__dirname, 'new.zip');

// ── CSV helpers (copied from generate-sql.mjs) ────────────────────

function parseLine(line) {
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

function parseCSV(text) {
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

function* streamCSV(text) {
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

// ── Diff functions (same logic as generate-sql.mjs) ───────────────

function computeDiff(oldRows, newText, pks, columns, transformRow = null) {
  const makeKey = row => pks.map(pk => row[pk]).join('\0');
  const makeVal = row => columns.map(c => row[c]).join('\0');

  const oldIndex = new Map();
  for (const row of oldRows) oldIndex.set(makeKey(row), makeVal(row));
  oldRows.length = 0;

  const toUpsert = [];
  for (const row of streamCSV(newText)) {
    const effectiveRow = transformRow ? transformRow(row) : row;
    const key = makeKey(effectiveRow);
    const oldVal = oldIndex.get(key);
    oldIndex.delete(key);
    if (oldVal === undefined || oldVal !== makeVal(effectiveRow)) toUpsert.push(effectiveRow);
  }

  const toDelete = [];
  for (const [key] of oldIndex) {
    const pkVals = key.split('\0');
    const row = {};
    pks.forEach((pk, i) => { row[pk] = pkVals[i]; });
    toDelete.push(row);
  }
  return { toUpsert, toDelete };
}

function buildGeoHashIndex(zip) {
  const entry = zip.getEntry('shapes.txt');
  if (!entry) return { idToHash: new Map(), hashToId: new Map() };

  const byId = new Map();
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

function buildRenameMap(oldIndex, newIndex) {
  const renameMap = new Map();
  for (const [newId, newHash] of newIndex.idToHash) {
    if (oldIndex.idToHash.has(newId)) continue;
    const oldId = oldIndex.hashToId.get(newHash);
    if (oldId && !newIndex.idToHash.has(oldId)) {
      // Only remap when oldId is gone from new feed — otherwise compare normally
      renameMap.set(newId, oldId);
    }
  }
  return renameMap;
}

function computeShapeDiff(oldRows, newText, columns, renameMap) {
  const makeKey = row => `${row.shape_id}\0${row.shape_pt_sequence}`;
  const makeVal = row => columns.map(c => row[c]).join('\0');
  const keptOldIds = new Set(renameMap.values());

  const oldIndex = new Map();
  for (const row of oldRows) {
    if (!keptOldIds.has(row.shape_id)) oldIndex.set(makeKey(row), makeVal(row));
  }
  oldRows.length = 0;

  const toUpsert = [];
  for (const row of streamCSV(newText)) {
    if (renameMap.has(row.shape_id)) continue;
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

// ── Table definitions (shapes + trips only — the affected tables) ─

const SHAPES = {
  table: 'shapes', file: 'shapes.txt',
  pks: ['shape_id', 'shape_pt_sequence'],
  columns: ['shape_id', 'shape_pt_lat', 'shape_pt_lon', 'shape_pt_sequence', 'shape_dist_traveled'],
};
const TRIPS = {
  table: 'trips', file: 'trips.txt',
  pks: ['trip_id'],
  columns: ['route_id', 'service_id', 'trip_id', 'trip_headsign', 'trip_short_name', 'direction_id', 'block_id', 'shape_id'],
};

// ── Main ──────────────────────────────────────────────────────────

console.log(`\nComparing:`);
console.log(`  old: ${oldZipPath}`);
console.log(`  new: ${newZipPath}\n`);

const oldZip = new AdmZip(oldZipPath);
const newZip = new AdmZip(newZipPath);

// Step 1: build geo hash indexes FIRST while memory is clean.
// Each index is only ~5K entries (one per shape), so this is cheap.
process.stdout.write('Building shape geometry fingerprints... ');
const oldShapeIndex = buildGeoHashIndex(oldZip);
const newShapeIndex = buildGeoHashIndex(newZip);
const renameMap = buildRenameMap(oldShapeIndex, newShapeIndex);
console.log(`done (${renameMap.size} renames detected)\n`);

// Step 2: run each diff in its own block so results can be GC'd before
// the next diff runs. Only the final counts are kept.
let counts = {};

process.stdout.write('Unoptimised shapes diff... ');
{
  const oldRows = parseCSV(oldZip.getEntry(SHAPES.file).getData().toString('utf8'));
  const newText = newZip.getEntry(SHAPES.file).getData().toString('utf8');
  const diff = computeDiff(oldRows, newText, SHAPES.pks, SHAPES.columns);
  counts.beforeShapesUpsert = diff.toUpsert.length;
  counts.beforeShapesDelete = diff.toDelete.length;
}
console.log(`${counts.beforeShapesUpsert.toLocaleString()} upserts, ${counts.beforeShapesDelete.toLocaleString()} deletes`);

process.stdout.write('Optimised shapes diff... ');
{
  const oldRows = parseCSV(oldZip.getEntry(SHAPES.file).getData().toString('utf8'));
  const newText = newZip.getEntry(SHAPES.file).getData().toString('utf8');
  const diff = computeShapeDiff(oldRows, newText, SHAPES.columns, renameMap);
  counts.afterShapesUpsert = diff.toUpsert.length;
  counts.afterShapesDelete = diff.toDelete.length;
}
console.log(`${counts.afterShapesUpsert.toLocaleString()} upserts, ${counts.afterShapesDelete.toLocaleString()} deletes`);

process.stdout.write('Unoptimised trips diff... ');
{
  const oldRows = parseCSV(oldZip.getEntry(TRIPS.file).getData().toString('utf8'));
  const newText = newZip.getEntry(TRIPS.file).getData().toString('utf8');
  const diff = computeDiff(oldRows, newText, TRIPS.pks, TRIPS.columns);
  counts.beforeTripsUpsert = diff.toUpsert.length;
  counts.beforeTripsDelete = diff.toDelete.length;
}
console.log(`${counts.beforeTripsUpsert.toLocaleString()} upserts, ${counts.beforeTripsDelete.toLocaleString()} deletes`);

process.stdout.write('Optimised trips diff... ');
{
  const oldRows = parseCSV(oldZip.getEntry(TRIPS.file).getData().toString('utf8'));
  const newText = newZip.getEntry(TRIPS.file).getData().toString('utf8');
  const diff = computeDiff(oldRows, newText, TRIPS.pks, TRIPS.columns,
    row => renameMap.has(row.shape_id) ? { ...row, shape_id: renameMap.get(row.shape_id) } : row);
  counts.afterTripsUpsert = diff.toUpsert.length;
  counts.afterTripsDelete = diff.toDelete.length;
}
console.log(`${counts.afterTripsUpsert.toLocaleString()} upserts, ${counts.afterTripsDelete.toLocaleString()} deletes`);

// ── Results ───────────────────────────────────────────────────────
function pct(saved, total) {
  return total === 0 ? '0' : ((saved / total) * 100).toFixed(1);
}

const fmt = n => n.toLocaleString().padStart(10);

console.log(`\n${'─'.repeat(70)}`);
console.log(`${'Table'.padEnd(14)} ${'Before'.padStart(10)} ${'After'.padStart(10)} ${'Saved'.padStart(10)}  %`);
console.log(`${'─'.repeat(70)}`);

const rows = [
  ['shapes upsert', counts.beforeShapesUpsert, counts.afterShapesUpsert],
  ['shapes delete', counts.beforeShapesDelete, counts.afterShapesDelete],
  ['trips upsert',  counts.beforeTripsUpsert,  counts.afterTripsUpsert],
  ['trips delete',  counts.beforeTripsDelete,  counts.afterTripsDelete],
];

for (const [label, before, after] of rows) {
  const saved = before - after;
  console.log(`${label.padEnd(14)}${fmt(before)}${fmt(after)}${fmt(saved)}  ${pct(saved, before)}%`);
}

const totalBefore = rows.reduce((s, [, b]) => s + b, 0);
const totalAfter  = rows.reduce((s, [,, a]) => s + a, 0);
const totalSaved  = totalBefore - totalAfter;

console.log(`${'─'.repeat(70)}`);
console.log(`${'TOTAL'.padEnd(14)}${fmt(totalBefore)}${fmt(totalAfter)}${fmt(totalSaved)}  ${pct(totalSaved, totalBefore)}%`);
console.log(`${'─'.repeat(70)}\n`);

console.log(`Sample renames (${renameMap.size} total):`);
let shown = 0;
for (const [newId, oldId] of renameMap) {
  if (shown++ >= 5) { console.log(`  ... and ${renameMap.size - 5} more`); break; }
  console.log(`  ${newId}  →  ${oldId}`);
}
console.log('');
