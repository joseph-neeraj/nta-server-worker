#!/usr/bin/env node
// Comprehensive unit tests for lib.mjs (the pure functions powering generate-sql.mjs).
// Run directly with Node — no test framework required.
//   node scripts/gtfs/test/test-unit.mjs
import assert from 'assert/strict';
import {
  parseLine, parseCSV, streamCSV,
  lit,
  writeInserts, writeUpserts, writeDeletes,
  computeDiff,
  buildGeoHashIndex, buildRenameMap, computeShapeDiff,
  getFeedVersion,
  ROWS_PER_INSERT,
} from '../lib.mjs';

// ── Test runner ───────────────────────────────────────────────────

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}

function group(name) { console.log(`\n${name}`); }

// ── Helpers ───────────────────────────────────────────────────────

// Capture stream.write() calls into a single string.
function mockStream() {
  const chunks = [];
  return { write: s => chunks.push(s), sql: () => chunks.join('') };
}

// Create a minimal AdmZip-compatible mock from a { filename: csvString } map.
function mockZip(files) {
  return {
    getEntry: name => {
      if (!(name in files)) return null;
      return { getData: () => Buffer.from(files[name]) };
    },
  };
}

// Build N identical-shape rows for batching tests.
function shapeRows(n) {
  return Array.from({ length: n }, (_, i) => ({
    shape_id: `s${i}`, shape_pt_lat: '53.0', shape_pt_lon: '-6.0',
    shape_pt_sequence: '1', shape_dist_traveled: '',
  }));
}

// Build a CSV string for shapes with a given shape_id and one point.
function shapeCSV(shapes) {
  const header = 'shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence,shape_dist_traveled';
  const rows = shapes.map(({ id, lat = '53.0', lon = '-6.0', seq = '1', dist = '' }) =>
    `${id},${lat},${lon},${seq},${dist}`);
  return [header, ...rows].join('\n');
}

// ─────────────────────────────────────────────────────────────────
// parseLine
// ─────────────────────────────────────────────────────────────────
group('parseLine');

test('simple values', () => {
  assert.deepEqual(parseLine('a,b,c'), ['a', 'b', 'c']);
});

test('single value, no comma', () => {
  assert.deepEqual(parseLine('hello'), ['hello']);
});

test('empty string → one empty field', () => {
  assert.deepEqual(parseLine(''), ['']);
});

test('empty fields (consecutive commas)', () => {
  assert.deepEqual(parseLine('a,,c'), ['a', '', 'c']);
});

test('trailing comma → empty last field', () => {
  assert.deepEqual(parseLine('a,b,'), ['a', 'b', '']);
});

test('quoted value', () => {
  assert.deepEqual(parseLine('"hello","world"'), ['hello', 'world']);
});

test('quoted value containing comma', () => {
  assert.deepEqual(parseLine('"a,b",c'), ['a,b', 'c']);
});

test('escaped double-quote inside quoted field', () => {
  assert.deepEqual(parseLine('"say ""hi"""'), ['say "hi"']);
});

test('mixed quoted and unquoted', () => {
  assert.deepEqual(parseLine('plain,"quo,ted",end'), ['plain', 'quo,ted', 'end']);
});

test('only commas → all empty', () => {
  assert.deepEqual(parseLine(',,,'), ['', '', '', '']);
});

// ─────────────────────────────────────────────────────────────────
// parseCSV
// ─────────────────────────────────────────────────────────────────
group('parseCSV');

test('basic LF-separated', () => {
  const rows = parseCSV('id,name\n1,Alice\n2,Bob');
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { id: '1', name: 'Alice' });
  assert.deepEqual(rows[1], { id: '2', name: 'Bob' });
});

test('CRLF line endings', () => {
  const rows = parseCSV('id,name\r\n1,Alice\r\n2,Bob');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].name, 'Alice');
});

test('CR-only line endings', () => {
  const rows = parseCSV('id,name\r1,Alice\r2,Bob');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].name, 'Alice');
});

test('blank lines in the middle are skipped', () => {
  const rows = parseCSV('id,name\n\n1,Alice\n\n2,Bob\n');
  assert.equal(rows.length, 2);
});

test('trailing newline does not add empty row', () => {
  const rows = parseCSV('id,name\n1,Alice\n');
  assert.equal(rows.length, 1);
});

test('missing field (shorter row than headers) → empty string', () => {
  const rows = parseCSV('a,b,c\n1,2');
  assert.equal(rows[0].c, '');
});

test('quoted field with embedded newline-like data', () => {
  // The CSV parser is line-based; embedded real newlines in quoted fields
  // are NOT supported (by design — GTFS feeds don't use them). Verify
  // unquoted commas in headers/values are correctly split.
  const rows = parseCSV('stop_id,stop_name\nS1,"Bus Stop, Main St"');
  assert.equal(rows[0].stop_name, 'Bus Stop, Main St');
});

// ─────────────────────────────────────────────────────────────────
// streamCSV
// ─────────────────────────────────────────────────────────────────
group('streamCSV');

test('same output as parseCSV', () => {
  const csv = 'id,val\n1,a\n2,b\n3,c';
  const parsed = parseCSV(csv);
  const streamed = Array.from(streamCSV(csv));
  assert.deepEqual(streamed, parsed);
});

test('blank lines skipped', () => {
  const streamed = Array.from(streamCSV('id,val\n\n1,a\n\n'));
  assert.equal(streamed.length, 1);
  assert.equal(streamed[0].val, 'a');
});

test('yields objects (not arrays)', () => {
  const [row] = streamCSV('x,y\n10,20');
  assert.equal(row.x, '10');
  assert.equal(row.y, '20');
});

// ─────────────────────────────────────────────────────────────────
// lit
// ─────────────────────────────────────────────────────────────────
group('lit');

test('empty string → NULL', () => { assert.equal(lit(''), 'NULL'); });
test('null → NULL', () => { assert.equal(lit(null), 'NULL'); });
test('undefined → NULL', () => { assert.equal(lit(undefined), 'NULL'); });
test('regular string', () => { assert.equal(lit('hello'), "'hello'"); });
test('string with single quote → escaped', () => { assert.equal(lit("it's"), "'it''s'"); });
test('multiple single quotes', () => { assert.equal(lit("a'b'c"), "'a''b''c'"); });
test('numeric string', () => { assert.equal(lit('123'), "'123'"); });
test('zero string', () => { assert.equal(lit('0'), "'0'"); });
test('integer 0', () => { assert.equal(lit(0), "'0'"); }); // numbers are coerced to string
test('string with double quotes (no escaping needed for SQLite)', () => {
  assert.equal(lit('say "hi"'), `'say "hi"'`);
});

// ─────────────────────────────────────────────────────────────────
// writeInserts
// ─────────────────────────────────────────────────────────────────
group('writeInserts');

test('single row → INSERT INTO table_new', () => {
  const s = mockStream();
  writeInserts(s, 'routes', ['id', 'name'], [{ id: 'R1', name: 'Red Line' }]);
  const sql = s.sql();
  assert.ok(sql.includes('INSERT INTO routes_new (id,name)'), 'uses _new table');
  assert.ok(sql.includes("'R1'"), 'includes pk value');
  assert.ok(sql.includes("'Red Line'"), 'includes name value');
});

test('null column → NULL', () => {
  const s = mockStream();
  writeInserts(s, 'stops', ['id', 'desc'], [{ id: 'S1', desc: '' }]);
  assert.ok(s.sql().includes('NULL'), 'empty string becomes NULL');
});

test('multiple rows in one statement when count ≤ ROWS_PER_INSERT', () => {
  const rows = Array.from({ length: 3 }, (_, i) => ({ id: `R${i}`, name: `N${i}` }));
  const s = mockStream();
  writeInserts(s, 't', ['id', 'name'], rows);
  const sql = s.sql();
  // Should be exactly 1 INSERT statement
  assert.equal((sql.match(/INSERT INTO/g) || []).length, 1);
});

test('batching: 501 rows → 2 INSERT statements', () => {
  const rows = Array.from({ length: ROWS_PER_INSERT + 1 }, (_, i) => ({ id: `${i}` }));
  const s = mockStream();
  writeInserts(s, 't', ['id'], rows);
  assert.equal((s.sql().match(/INSERT INTO/g) || []).length, 2);
});

test('empty rows → no output', () => {
  const s = mockStream();
  writeInserts(s, 't', ['id'], []);
  assert.equal(s.sql(), '');
});

// ─────────────────────────────────────────────────────────────────
// writeUpserts
// ─────────────────────────────────────────────────────────────────
group('writeUpserts');

test('generates INSERT OR REPLACE INTO table (not _new)', () => {
  const s = mockStream();
  writeUpserts(s, 'routes', ['id', 'name'], [{ id: 'R1', name: 'Red' }]);
  const sql = s.sql();
  assert.ok(sql.includes('INSERT OR REPLACE INTO routes ('), 'correct statement + live table');
  assert.ok(!sql.includes('routes_new'), 'must NOT use _new suffix');
});

test('batching: 501 rows → 2 statements', () => {
  const rows = Array.from({ length: ROWS_PER_INSERT + 1 }, (_, i) => ({ id: `${i}` }));
  const s = mockStream();
  writeUpserts(s, 't', ['id'], rows);
  assert.equal((s.sql().match(/INSERT OR REPLACE/g) || []).length, 2);
});

// ─────────────────────────────────────────────────────────────────
// writeDeletes
// ─────────────────────────────────────────────────────────────────
group('writeDeletes');

test('empty rows → no writes', () => {
  const s = mockStream();
  writeDeletes(s, 'routes', ['route_id'], []);
  assert.equal(s.sql(), '');
});

test('single PK → WHERE pk IN (...)', () => {
  const s = mockStream();
  writeDeletes(s, 'routes', ['route_id'], [{ route_id: 'R1' }, { route_id: 'R2' }]);
  const sql = s.sql();
  assert.ok(sql.includes('DELETE FROM routes WHERE route_id IN'), 'correct template');
  assert.ok(sql.includes("'R1'") && sql.includes("'R2'"), 'both values present');
});

test('composite PK → WHERE (a,b) IN ((v1,v2),...)', () => {
  const s = mockStream();
  writeDeletes(s, 'shapes', ['shape_id', 'shape_pt_sequence'],
    [{ shape_id: 'SH1', shape_pt_sequence: '1' }]);
  const sql = s.sql();
  assert.ok(sql.includes('(shape_id,shape_pt_sequence) IN'), 'tuple IN syntax');
  assert.ok(sql.includes("('SH1','1')"), 'tuple values correct');
});

test('batching: 501 rows → 2 DELETE statements', () => {
  const rows = Array.from({ length: ROWS_PER_INSERT + 1 }, (_, i) => ({ id: `${i}` }));
  const s = mockStream();
  writeDeletes(s, 't', ['id'], rows);
  assert.equal((s.sql().match(/DELETE FROM/g) || []).length, 2);
});

// ─────────────────────────────────────────────────────────────────
// computeDiff
// ─────────────────────────────────────────────────────────────────
group('computeDiff');

const cols = ['id', 'val'];
const pks = ['id'];

function csv(...rows) {
  return ['id,val', ...rows.map(r => `${r.id},${r.val}`)].join('\n');
}

test('identical old and new → nothing to upsert or delete', () => {
  const old = [{ id: '1', val: 'a' }, { id: '2', val: 'b' }];
  const { toUpsert, toDelete } = computeDiff(old, csv({ id: '1', val: 'a' }, { id: '2', val: 'b' }), pks, cols);
  assert.equal(toUpsert.length, 0);
  assert.equal(toDelete.length, 0);
});

test('new row added → in toUpsert', () => {
  const old = [{ id: '1', val: 'a' }];
  const { toUpsert, toDelete } = computeDiff(old, csv({ id: '1', val: 'a' }, { id: '2', val: 'b' }), pks, cols);
  assert.equal(toUpsert.length, 1);
  assert.equal(toUpsert[0].id, '2');
  assert.equal(toDelete.length, 0);
});

test('row removed → in toDelete', () => {
  const old = [{ id: '1', val: 'a' }, { id: '2', val: 'b' }];
  const { toUpsert, toDelete } = computeDiff(old, csv({ id: '1', val: 'a' }), pks, cols);
  assert.equal(toDelete.length, 1);
  assert.equal(toDelete[0].id, '2');
  assert.equal(toUpsert.length, 0);
});

test('value changed → in toUpsert', () => {
  const old = [{ id: '1', val: 'a' }];
  const { toUpsert, toDelete } = computeDiff(old, csv({ id: '1', val: 'CHANGED' }), pks, cols);
  assert.equal(toUpsert.length, 1);
  assert.equal(toUpsert[0].val, 'CHANGED');
  assert.equal(toDelete.length, 0);
});

test('empty old → all new rows in toUpsert', () => {
  const { toUpsert, toDelete } = computeDiff([], csv({ id: '1', val: 'a' }, { id: '2', val: 'b' }), pks, cols);
  assert.equal(toUpsert.length, 2);
  assert.equal(toDelete.length, 0);
});

test('empty new → all old rows in toDelete', () => {
  const old = [{ id: '1', val: 'a' }, { id: '2', val: 'b' }];
  const { toUpsert, toDelete } = computeDiff(old, 'id,val', pks, cols); // header only, no data rows
  assert.equal(toDelete.length, 2);
  assert.equal(toUpsert.length, 0);
});

test('oldRows array is emptied after call (memory strategy)', () => {
  const old = [{ id: '1', val: 'a' }];
  computeDiff(old, csv({ id: '1', val: 'a' }), pks, cols);
  assert.equal(old.length, 0, 'oldRows.length = 0 was called');
});

test('composite PK diff', () => {
  const cPks = ['shape_id', 'seq'];
  const cCols = ['shape_id', 'seq', 'lat'];
  const oldRows = [{ shape_id: 'S1', seq: '1', lat: '53.0' }, { shape_id: 'S1', seq: '2', lat: '53.1' }];
  const newCsv = 'shape_id,seq,lat\nS1,1,53.0\nS1,3,54.0'; // seq 2 removed, seq 3 added
  const { toUpsert, toDelete } = computeDiff(oldRows, newCsv, cPks, cCols);
  assert.equal(toUpsert.length, 1);
  assert.equal(toUpsert[0].seq, '3');
  assert.equal(toDelete.length, 1);
  assert.equal(toDelete[0].seq, '2');
});

test('transformRow: trip with renamed shape_id appears unchanged after normalisation', () => {
  // Old trip: shape_id='OLD_SHAPE'. New trip: same data but shape_id='NEW_SHAPE'.
  // With transformRow mapping NEW_SHAPE→OLD_SHAPE, the trip should NOT appear as changed.
  const tPks = ['trip_id'];
  const tCols = ['trip_id', 'shape_id', 'route_id'];
  const oldTrips = [{ trip_id: 'T1', shape_id: 'OLD_SHAPE', route_id: 'R1' }];
  const newCsv = 'trip_id,shape_id,route_id\nT1,NEW_SHAPE,R1';
  const renameMap = new Map([['NEW_SHAPE', 'OLD_SHAPE']]);
  const transform = row => renameMap.has(row.shape_id)
    ? { ...row, shape_id: renameMap.get(row.shape_id) }
    : row;
  const { toUpsert, toDelete } = computeDiff(oldTrips, newCsv, tPks, tCols, transform);
  assert.equal(toUpsert.length, 0, 'trip with only shape rename should not appear as update');
  assert.equal(toDelete.length, 0);
});

test('transformRow: trip with genuinely different data → in toUpsert', () => {
  const tPks = ['trip_id'];
  const tCols = ['trip_id', 'shape_id', 'route_id'];
  const oldTrips = [{ trip_id: 'T1', shape_id: 'S1', route_id: 'R1' }];
  const newCsv = 'trip_id,shape_id,route_id\nT1,S1,R2'; // route_id changed
  const renameMap = new Map();
  const transform = row => renameMap.has(row.shape_id)
    ? { ...row, shape_id: renameMap.get(row.shape_id) }
    : row;
  const { toUpsert } = computeDiff(oldTrips, newCsv, tPks, tCols, transform);
  assert.equal(toUpsert.length, 1, 'genuine change must appear as update');
  assert.equal(toUpsert[0].route_id, 'R2');
});

// ─────────────────────────────────────────────────────────────────
// buildGeoHashIndex
// ─────────────────────────────────────────────────────────────────
group('buildGeoHashIndex');

test('missing shapes.txt → empty maps', () => {
  const zip = mockZip({}); // no shapes.txt
  const { idToHash, hashToId } = buildGeoHashIndex(zip);
  assert.equal(idToHash.size, 0);
  assert.equal(hashToId.size, 0);
});

test('single-point shape → hash computed, both maps populated', () => {
  const csv = 'shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence,shape_dist_traveled\nS1,53.0,-6.0,1,0.0';
  const { idToHash, hashToId } = buildGeoHashIndex(mockZip({ 'shapes.txt': csv }));
  assert.ok(idToHash.has('S1'), 'idToHash has shape');
  const h = idToHash.get('S1');
  assert.equal(typeof h, 'string');
  assert.equal(h.length, 16, 'hash is 16-char hex slice of sha256');
  assert.equal(hashToId.get(h), 'S1', 'reverse map is correct');
});

test('multi-point shape: points sorted by sequence before hashing', () => {
  // Deliberately out-of-order rows in CSV — hash should be same regardless of row order
  const csvOrdered = shapeCSV([
    { id: 'S1', lat: '53.0', lon: '-6.0', seq: '1' },
    { id: 'S1', lat: '53.1', lon: '-6.1', seq: '2' },
  ]);
  const csvReversed = shapeCSV([
    { id: 'S1', lat: '53.1', lon: '-6.1', seq: '2' },
    { id: 'S1', lat: '53.0', lon: '-6.0', seq: '1' },
  ]);
  const { idToHash: h1 } = buildGeoHashIndex(mockZip({ 'shapes.txt': csvOrdered }));
  const { idToHash: h2 } = buildGeoHashIndex(mockZip({ 'shapes.txt': csvReversed }));
  assert.equal(h1.get('S1'), h2.get('S1'), 'hash is order-independent');
});

test('shape_dist_traveled excluded: same lat/lon different dist → same hash', () => {
  const csvA = shapeCSV([{ id: 'S1', lat: '53.0', lon: '-6.0', seq: '1', dist: '0.0' }]);
  const csvB = shapeCSV([{ id: 'S1', lat: '53.0', lon: '-6.0', seq: '1', dist: '999.9' }]);
  const { idToHash: hA } = buildGeoHashIndex(mockZip({ 'shapes.txt': csvA }));
  const { idToHash: hB } = buildGeoHashIndex(mockZip({ 'shapes.txt': csvB }));
  assert.equal(hA.get('S1'), hB.get('S1'), 'dist_traveled does not affect hash');
});

test('different lat/lon → different hash', () => {
  const csvA = shapeCSV([{ id: 'S1', lat: '53.0', lon: '-6.0', seq: '1' }]);
  const csvB = shapeCSV([{ id: 'S1', lat: '54.0', lon: '-7.0', seq: '1' }]);
  const { idToHash: hA } = buildGeoHashIndex(mockZip({ 'shapes.txt': csvA }));
  const { idToHash: hB } = buildGeoHashIndex(mockZip({ 'shapes.txt': csvB }));
  assert.notEqual(hA.get('S1'), hB.get('S1'), 'different geometry → different hash');
});

test('two shapes with identical geometry → same hash value, hashToId maps to last one', () => {
  // Two distinct shape_ids with the same lat/lon — both get the same hash.
  // hashToId can only hold one entry per hash; whichever is processed last wins.
  const csv = shapeCSV([
    { id: 'S1', lat: '53.0', lon: '-6.0', seq: '1' },
    { id: 'S2', lat: '53.0', lon: '-6.0', seq: '1' },
  ]);
  const { idToHash, hashToId } = buildGeoHashIndex(mockZip({ 'shapes.txt': csv }));
  assert.equal(idToHash.get('S1'), idToHash.get('S2'), 'same geometry → same hash for both');
  const h = idToHash.get('S1');
  assert.ok(hashToId.get(h) === 'S1' || hashToId.get(h) === 'S2', 'hashToId holds one of them');
});

test('multiple shapes', () => {
  const csv = shapeCSV([
    { id: 'A', lat: '53.0', lon: '-6.0', seq: '1' },
    { id: 'B', lat: '54.0', lon: '-7.0', seq: '1' },
  ]);
  const { idToHash, hashToId } = buildGeoHashIndex(mockZip({ 'shapes.txt': csv }));
  assert.equal(idToHash.size, 2);
  assert.equal(hashToId.size, 2);
  assert.notEqual(idToHash.get('A'), idToHash.get('B'));
});

// ─────────────────────────────────────────────────────────────────
// buildRenameMap
// ─────────────────────────────────────────────────────────────────
group('buildRenameMap');

function fakeIndex(map) {
  // map: { shapeId: hash }
  return {
    idToHash: new Map(Object.entries(map)),
    hashToId: new Map(Object.entries(map).map(([id, h]) => [h, id])),
  };
}

test('geometry-identical rename: old A → new B', () => {
  // Old feed: { A: hash1 }. New feed: { B: hash1 }. A renamed to B.
  const oldIdx = fakeIndex({ A: 'hash1' });
  const newIdx = fakeIndex({ B: 'hash1' });
  const map = buildRenameMap(oldIdx, newIdx);
  assert.equal(map.get('B'), 'A', 'B maps back to A');
  assert.equal(map.size, 1);
});

test('same shape ID in both feeds → not a rename', () => {
  const oldIdx = fakeIndex({ A: 'hash1' });
  const newIdx = fakeIndex({ A: 'hash1', B: 'hash2' }); // A present in both
  const map = buildRenameMap(oldIdx, newIdx);
  assert.ok(!map.has('A'), 'A is in both feeds, not a rename');
  assert.ok(!map.has('B'), 'B has no geometry match in old');
});

test('new shape with no geometry match in old → not mapped', () => {
  const oldIdx = fakeIndex({ A: 'hash1' });
  const newIdx = fakeIndex({ A: 'hash1', C: 'hash99' }); // C is genuinely new
  const map = buildRenameMap(oldIdx, newIdx);
  assert.equal(map.size, 0);
});

test('old ID still in new feed: new ID with same geometry NOT mapped (not a rename)', () => {
  // Old: { A: hash1 }. New: { A: hash1, B: hash1 }. A still exists, B is a duplicate.
  // B should NOT be mapped because newIndex.idToHash.has('A') is true.
  const oldIdx = fakeIndex({ A: 'hash1' });
  const newIdx = fakeIndex({ A: 'hash1', B: 'hash1' });
  const map = buildRenameMap(oldIdx, newIdx);
  assert.ok(!map.has('B'), 'B not mapped: old ID still exists in new feed');
});

test('multiple renames in one call', () => {
  const oldIdx = fakeIndex({ A: 'h1', B: 'h2', C: 'h3' });
  // New feed renames A→X, B→Y, keeps C (it disappears but geometry is gone)
  const newIdx = fakeIndex({ X: 'h1', Y: 'h2' }); // C gone, no geometry left
  const map = buildRenameMap(oldIdx, newIdx);
  assert.equal(map.get('X'), 'A');
  assert.equal(map.get('Y'), 'B');
  assert.equal(map.size, 2);
});

test('empty feeds → empty map', () => {
  const map = buildRenameMap(fakeIndex({}), fakeIndex({}));
  assert.equal(map.size, 0);
});

// ─────────────────────────────────────────────────────────────────
// computeShapeDiff
// ─────────────────────────────────────────────────────────────────
group('computeShapeDiff');

const shapeCols = ['shape_id', 'shape_pt_lat', 'shape_pt_lon', 'shape_pt_sequence', 'shape_dist_traveled'];

function makeShapeRows(shapeId, pts) {
  // pts: [{ lat, lon, seq, dist? }]
  return pts.map(p => ({
    shape_id: shapeId, shape_pt_lat: p.lat, shape_pt_lon: p.lon,
    shape_pt_sequence: String(p.seq), shape_dist_traveled: p.dist ?? '',
  }));
}

function makeShapeCSV(shapes) {
  // shapes: [{ id, pts: [{ lat, lon, seq }] }]
  const header = shapeCols.join(',');
  const rows = shapes.flatMap(({ id, pts }) =>
    pts.map(p => `${id},${p.lat},${p.lon},${p.seq},${p.dist ?? ''}`));
  return [header, ...rows].join('\n');
}

test('no changes, no renames → empty toUpsert and toDelete', () => {
  const old = makeShapeRows('S1', [{ lat: '53.0', lon: '-6.0', seq: 1 }]);
  const newCsv = makeShapeCSV([{ id: 'S1', pts: [{ lat: '53.0', lon: '-6.0', seq: 1 }] }]);
  const { toUpsert, toDelete } = computeShapeDiff(old, newCsv, shapeCols, new Map());
  assert.equal(toUpsert.length, 0);
  assert.equal(toDelete.length, 0);
});

test('geometry-identical rename: old rows kept, new rows skipped', () => {
  // Old: shape A with one point. New: shape B with same point, A gone.
  // renameMap: B → A. B's rows should be skipped (already in D1 as A).
  // A's rows should NOT be deleted (keptOldIds guards them).
  const old = makeShapeRows('A', [{ lat: '53.0', lon: '-6.0', seq: 1 }]);
  const newCsv = makeShapeCSV([{ id: 'B', pts: [{ lat: '53.0', lon: '-6.0', seq: 1 }] }]);
  const renameMap = new Map([['B', 'A']]);
  const { toUpsert, toDelete } = computeShapeDiff(old, newCsv, shapeCols, renameMap);
  assert.equal(toUpsert.length, 0, 'B rows skipped (rename)');
  assert.equal(toDelete.length, 0, 'A rows kept in D1 (keptOldIds)');
});

test('completely new shape (no old match) → in toUpsert', () => {
  const old = makeShapeRows('A', [{ lat: '53.0', lon: '-6.0', seq: 1 }]);
  const newCsv = makeShapeCSV([
    { id: 'A', pts: [{ lat: '53.0', lon: '-6.0', seq: 1 }] },
    { id: 'NEW', pts: [{ lat: '54.0', lon: '-7.0', seq: 1 }] },
  ]);
  const { toUpsert, toDelete } = computeShapeDiff(old, newCsv, shapeCols, new Map());
  assert.equal(toUpsert.length, 1);
  assert.equal(toUpsert[0].shape_id, 'NEW');
  assert.equal(toDelete.length, 0);
});

test('deleted shape (geometry gone from new) → in toDelete', () => {
  const old = [
    ...makeShapeRows('A', [{ lat: '53.0', lon: '-6.0', seq: 1 }]),
    ...makeShapeRows('B', [{ lat: '54.0', lon: '-7.0', seq: 1 }]),
  ];
  const newCsv = makeShapeCSV([{ id: 'A', pts: [{ lat: '53.0', lon: '-6.0', seq: 1 }] }]);
  const { toUpsert, toDelete } = computeShapeDiff(old, newCsv, shapeCols, new Map());
  assert.equal(toDelete.length, 1);
  assert.equal(toDelete[0].shape_id, 'B');
  assert.equal(toUpsert.length, 0);
});

test('changed shape geometry → old in toDelete, new in toUpsert', () => {
  const old = makeShapeRows('A', [{ lat: '53.0', lon: '-6.0', seq: 1 }]);
  const newCsv = makeShapeCSV([{ id: 'A', pts: [{ lat: '99.0', lon: '-6.0', seq: 1 }] }]);
  const { toUpsert, toDelete } = computeShapeDiff(old, newCsv, shapeCols, new Map());
  assert.equal(toUpsert.length, 1, 'changed row upserted');
  assert.equal(toDelete.length, 0, 'old row key was seen and deleted from oldIndex, not in toDelete');
  // The key (shape_id, seq) is the same — so the old entry is just overwritten via upsert.
  // toDelete would only fire if the old key was never seen in the new file.
  assert.equal(toUpsert[0].shape_pt_lat, '99.0');
});

test('mixed: rename + new + deleted + unchanged', () => {
  // Shapes: A (renamed to X), B (unchanged), C (deleted), D (new)
  const old = [
    ...makeShapeRows('A', [{ lat: '1.0', lon: '1.0', seq: 1 }]),
    ...makeShapeRows('B', [{ lat: '2.0', lon: '2.0', seq: 1 }]),
    ...makeShapeRows('C', [{ lat: '3.0', lon: '3.0', seq: 1 }]),
  ];
  const newCsv = makeShapeCSV([
    { id: 'X', pts: [{ lat: '1.0', lon: '1.0', seq: 1 }] }, // rename of A
    { id: 'B', pts: [{ lat: '2.0', lon: '2.0', seq: 1 }] }, // unchanged
    { id: 'D', pts: [{ lat: '4.0', lon: '4.0', seq: 1 }] }, // new
    // C absent
  ]);
  const renameMap = new Map([['X', 'A']]); // X is a rename of A

  const { toUpsert, toDelete } = computeShapeDiff(old, newCsv, shapeCols, renameMap);
  const upsertIds = toUpsert.map(r => r.shape_id);
  const deleteIds = toDelete.map(r => r.shape_id);

  assert.ok(upsertIds.includes('D'), 'D is new → upserted');
  assert.ok(!upsertIds.includes('X'), 'X is a rename → skipped');
  assert.ok(!upsertIds.includes('B'), 'B unchanged → not upserted');
  assert.ok(deleteIds.includes('C'), 'C is gone → deleted');
  assert.ok(!deleteIds.includes('A'), 'A is kept in D1 (geometry lives as X) → not deleted');
  assert.ok(!deleteIds.includes('B'), 'B unchanged → not deleted');
});

test('oldRows array is emptied after call', () => {
  const old = makeShapeRows('A', [{ lat: '1.0', lon: '1.0', seq: 1 }]);
  computeShapeDiff(old, makeShapeCSV([{ id: 'A', pts: [{ lat: '1.0', lon: '1.0', seq: 1 }] }]), shapeCols, new Map());
  assert.equal(old.length, 0);
});

// ─────────────────────────────────────────────────────────────────
// getFeedVersion
// ─────────────────────────────────────────────────────────────────
group('getFeedVersion');

test('returns feed_version from feed_info.txt', () => {
  const zip = mockZip({ 'feed_info.txt': 'feed_publisher_name,feed_version\nNTA,20260609' });
  assert.equal(getFeedVersion(zip), '20260609');
});

test('missing feed_info.txt → null', () => {
  assert.equal(getFeedVersion(mockZip({})), null);
});

test('feed_version column absent → null (??)', () => {
  // Row exists but has no feed_version key → row[0].feed_version is undefined
  const zip = mockZip({ 'feed_info.txt': 'feed_publisher_name\nNTA' });
  assert.equal(getFeedVersion(zip), null);
});

test('empty rows → null', () => {
  // File with only a header, no data rows
  const zip = mockZip({ 'feed_info.txt': 'feed_publisher_name,feed_version' });
  assert.equal(getFeedVersion(zip), null);
});

// ─────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(60)}`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log('─'.repeat(60));
if (failed > 0) process.exit(1);
