#!/usr/bin/env node
// Downloads the NTA GTFS static ZIP and generates a SQL file for D1 import.
//
// Two modes:
//   FULL — first run (no .gtfs_last_zip exists). Shadow-table swap: loads into
//          *_new tables, then atomic rename replaces live tables.
//   DIFF — subsequent runs. Compares old zip vs new, generates only
//          INSERT OR REPLACE for new/changed rows + DELETE for removed rows.
//
// wrangler d1 execute --file wraps the entire file in a transaction; explicit
// BEGIN/COMMIT are forbidden by D1 and must NOT appear in the SQL.

import AdmZip from 'adm-zip';
import { createWriteStream, writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { promisify } from 'util';
import chalk from 'chalk';
import ora from 'ora';
import {
  ROWS_PER_INSERT,
  parseCSV, writeInserts, writeUpserts, writeDeletes,
  computeDiff, computeShapeDiff,
  buildGeoHashIndex, buildRenameMap, getFeedVersion,
} from './lib.mjs';

const GTFS_URL = 'https://www.transportforireland.ie/transitData/Data/GTFS_Realtime.zip';

// All generated files and tracking markers go here, keeping the project root clean.
const ARTIFACTS_DIR = 'scripts/gtfs/artifacts';
mkdirSync(ARTIFACTS_DIR, { recursive: true });

const TS = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
const ZIP_FILE = `${ARTIFACTS_DIR}/gtfs_${TS}.zip`;
const OUT_FILE = `${ARTIFACTS_DIR}/gtfs_${TS}.sql`;

// Tracking files — shell script uses these to coordinate state between runs
const STATS_FILE = `${ARTIFACTS_DIR}/.gtfs_stats.json`;        // per-table diff counts for confirmation prompt
const PENDING_ZIP_FILE = `${ARTIFACTS_DIR}/.gtfs_pending_zip`; // path of just-downloaded zip (not yet committed)
const LAST_ZIP_FILE = `${ARTIFACTS_DIR}/.gtfs_last_zip`;       // path of last successfully imported zip

console.log(chalk.dim(`  zip: ${ZIP_FILE}`));
console.log(chalk.dim(`  sql: ${OUT_FILE}`));

const TABLES = [
  {
    table: 'agency',
    file: 'agency.txt',
    pks: ['agency_id'],
    columns: ['agency_id', 'agency_name', 'agency_url', 'agency_timezone'],
    ddl: `CREATE TABLE agency_new (
  agency_id TEXT PRIMARY KEY, agency_name TEXT NOT NULL,
  agency_url TEXT, agency_timezone TEXT
)`,
  },
  {
    table: 'routes',
    file: 'routes.txt',
    pks: ['route_id'],
    columns: ['route_id', 'agency_id', 'route_short_name', 'route_long_name', 'route_desc', 'route_type', 'route_url', 'route_color', 'route_text_color'],
    ddl: `CREATE TABLE routes_new (
  route_id TEXT PRIMARY KEY, agency_id TEXT, route_short_name TEXT,
  route_long_name TEXT, route_desc TEXT, route_type INTEGER,
  route_url TEXT, route_color TEXT, route_text_color TEXT
)`,
  },
  {
    table: 'calendar',
    file: 'calendar.txt',
    pks: ['service_id'],
    columns: ['service_id', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'start_date', 'end_date'],
    ddl: `CREATE TABLE calendar_new (
  service_id TEXT PRIMARY KEY,
  monday INTEGER NOT NULL, tuesday INTEGER NOT NULL, wednesday INTEGER NOT NULL,
  thursday INTEGER NOT NULL, friday INTEGER NOT NULL, saturday INTEGER NOT NULL,
  sunday INTEGER NOT NULL, start_date TEXT NOT NULL, end_date TEXT NOT NULL
)`,
  },
  {
    table: 'calendar_dates',
    file: 'calendar_dates.txt',
    pks: ['service_id', 'date'],
    columns: ['service_id', 'date', 'exception_type'],
    ddl: `CREATE TABLE calendar_dates_new (
  service_id TEXT NOT NULL, date TEXT NOT NULL,
  exception_type INTEGER NOT NULL, PRIMARY KEY (service_id, date)
)`,
  },
  {
    table: 'shapes',
    file: 'shapes.txt',
    pks: ['shape_id', 'shape_pt_sequence'],
    columns: ['shape_id', 'shape_pt_lat', 'shape_pt_lon', 'shape_pt_sequence', 'shape_dist_traveled'],
    ddl: `CREATE TABLE shapes_new (
  shape_id TEXT NOT NULL, shape_pt_lat REAL NOT NULL, shape_pt_lon REAL NOT NULL,
  shape_pt_sequence INTEGER NOT NULL, shape_dist_traveled REAL,
  PRIMARY KEY (shape_id, shape_pt_sequence)
)`,
  },
  {
    table: 'stops',
    file: 'stops.txt',
    pks: ['stop_id'],
    columns: ['stop_id', 'stop_code', 'stop_name', 'stop_desc', 'stop_lat', 'stop_lon', 'zone_id', 'stop_url', 'location_type', 'parent_station'],
    ddl: `CREATE TABLE stops_new (
  stop_id TEXT PRIMARY KEY, stop_code TEXT, stop_name TEXT NOT NULL,
  stop_desc TEXT, stop_lat REAL NOT NULL, stop_lon REAL NOT NULL,
  zone_id TEXT, stop_url TEXT, location_type INTEGER, parent_station TEXT
)`,
  },
  {
    table: 'trips',
    file: 'trips.txt',
    pks: ['trip_id'],
    columns: ['route_id', 'service_id', 'trip_id', 'trip_headsign', 'trip_short_name', 'direction_id', 'block_id', 'shape_id'],
    ddl: `CREATE TABLE trips_new (
  route_id TEXT NOT NULL, service_id TEXT NOT NULL, trip_id TEXT PRIMARY KEY,
  trip_headsign TEXT, trip_short_name TEXT, direction_id INTEGER,
  block_id TEXT, shape_id TEXT
)`,
  },
  {
    table: 'stop_times',
    file: 'stop_times.txt',
    pks: ['trip_id', 'stop_sequence'],
    columns: ['trip_id', 'arrival_time', 'departure_time', 'stop_id', 'stop_sequence', 'stop_headsign', 'pickup_type', 'drop_off_type', 'timepoint'],
    ddl: `CREATE TABLE stop_times_new (
  trip_id TEXT NOT NULL, arrival_time TEXT, departure_time TEXT,
  stop_id TEXT NOT NULL, stop_sequence INTEGER NOT NULL,
  stop_headsign TEXT, pickup_type INTEGER, drop_off_type INTEGER,
  timepoint INTEGER, PRIMARY KEY (trip_id, stop_sequence)
)`,
  },
];

// ── Main ──────────────────────────────────────────────────────────

console.log(chalk.bold.blue('\n╔══════════════════════════════════════╗'));
console.log(chalk.bold.blue('║   NTA GTFS SQL Generator             ║'));
console.log(chalk.bold.blue('╚══════════════════════════════════════╝\n'));

// Step 1: download
const dlSpinner = ora({ text: chalk.cyan(`Downloading ${GTFS_URL} ...`), color: 'cyan' }).start();
const res = await fetch(GTFS_URL);
if (!res.ok) { dlSpinner.fail(chalk.red(`Download failed: HTTP ${res.status}`)); process.exit(1); }
const buf = Buffer.from(await res.arrayBuffer());
dlSpinner.succeed(chalk.green(`Downloaded ${chalk.bold((buf.length / 1024 / 1024).toFixed(1) + ' MB')}`));

writeFileSync(ZIP_FILE, buf);
console.log(chalk.dim(`  Saved zip → ${ZIP_FILE}`));

// Step 2: determine mode
// .gtfs_last_zip holds the path to the last successfully imported zip.
// If it exists and the file is present, run a diff. Otherwise fall back to
// a full import (first run, or the zip was cleaned up manually).
const lastZipPath = existsSync(LAST_ZIP_FILE) ? readFileSync(LAST_ZIP_FILE, 'utf8').trim() : null;
const newZip = new AdmZip(buf);
const newVersion = getFeedVersion(newZip);

let mode = 'full';
let oldZip = null;
let oldVersion = null;

if (lastZipPath && existsSync(lastZipPath)) {
  oldZip = new AdmZip(lastZipPath);
  oldVersion = getFeedVersion(oldZip);

  if (oldVersion && oldVersion === newVersion) {
    console.log(chalk.yellow(`\n⚠ Feed version unchanged (${newVersion}) — nothing to import.`));
    writeFileSync(STATS_FILE, JSON.stringify({ noChange: true, feedVersion: newVersion }));
    process.exit(0);
  }

  mode = 'diff';
  console.log(chalk.cyan(`\n  Feed version changed: ${chalk.bold(oldVersion)} → ${chalk.bold(newVersion)} — proceeding with diff`));
} else {
  console.log(chalk.dim(`\n  Mode: full import (no previous zip found)`));
}

// Record the pending zip. Shell script promotes this to .gtfs_last_zip only
// after wrangler d1 execute succeeds — a failed import leaves state unchanged.
writeFileSync(PENDING_ZIP_FILE, ZIP_FILE);

// Step 3: generate SQL
console.log(chalk.bold.yellow('\n▶ Processing tables'));

const stream = createWriteStream(OUT_FILE, { encoding: 'utf8' });
const streamEnd = promisify(stream.end.bind(stream));

const tableStats = [];

if (mode === 'full') {
  // Shadow-table swap — same as before. Safe for initial load even if tables
  // already exist from the migration (DROP TABLE replaces them atomically).
  for (const { table } of TABLES) stream.write(`DROP TABLE IF EXISTS ${table}_new;\n`);
  stream.write('\n');

  for (const { table, file, columns, ddl } of TABLES) {
    const spinner = ora({ text: chalk.cyan(`  ${table} ...`), color: 'cyan', indent: 2 }).start();
    const entry = newZip.getEntry(file);
    const rows = entry ? parseCSV(entry.getData().toString('utf8')) : [];

    stream.write(`-- ${table}\n${ddl};\n`);
    if (rows.length > 0) writeInserts(stream, table, columns, rows);
    stream.write('\n');

    tableStats.push({ table, upsertRows: rows.length, deleteRows: 0 });
    spinner.succeed(chalk.green(`  ${chalk.bold(table)}: ${rows.length.toLocaleString()} rows`));
  }

  for (const { table } of TABLES) {
    stream.write(`DROP TABLE ${table};\n`);
    stream.write(`ALTER TABLE ${table}_new RENAME TO ${table};\n`);
  }

} else {
  // Diff mode — patch live tables. Only changed/added/deleted rows are written.

  // Build shape geometry fingerprints before the table loop.
  // shapeRenameMap: Map<newShapeId, oldShapeId> for geometry-identical renames.
  // Used by both the shapes diff (to skip re-writing unchanged geometry) and
  // the trips diff (to normalise shape_id so trips don't look changed).
  const oldShapeIndex = buildGeoHashIndex(oldZip);
  const newShapeIndex = buildGeoHashIndex(newZip);
  const shapeRenameMap = buildRenameMap(oldShapeIndex, newShapeIndex);
  if (shapeRenameMap.size > 0) {
    console.log(chalk.dim(`  Shape renames detected: ${shapeRenameMap.size} (geometry-identical, writes skipped)`));
  }

  for (const { table, file, columns, pks } of TABLES) {
    const spinner = ora({ text: chalk.cyan(`  ${table} ...`), color: 'cyan', indent: 2 }).start();

    const oldEntry = oldZip.getEntry(file);
    const newEntry = newZip.getEntry(file);
    const oldRows = oldEntry ? parseCSV(oldEntry.getData().toString('utf8')) : [];
    const newText = newEntry ? newEntry.getData().toString('utf8') : '';

    let toUpsert, toDelete;
    if (table === 'shapes') {
      // Skip rows for geometry-identical renames; keep their old D1 rows intact.
      ({ toUpsert, toDelete } = computeShapeDiff(oldRows, newText, columns, shapeRenameMap));
    } else if (table === 'trips') {
      // Normalise shape_id through rename map before comparison: a trip that only
      // changed because NTA renamed its shape will now match the old D1 row.
      ({ toUpsert, toDelete } = computeDiff(oldRows, newText, pks, columns,
        row => shapeRenameMap.has(row.shape_id)
          ? { ...row, shape_id: shapeRenameMap.get(row.shape_id) }
          : row));
    } else {
      ({ toUpsert, toDelete } = computeDiff(oldRows, newText, pks, columns));
    }

    if (toUpsert.length > 0 || toDelete.length > 0) {
      stream.write(`-- ${table}: ${toUpsert.length} upserts, ${toDelete.length} deletes\n`);
      writeDeletes(stream, table, pks, toDelete);
      writeUpserts(stream, table, columns, toUpsert);
      stream.write('\n');
    }

    const renameNote = table === 'shapes' && shapeRenameMap.size > 0
      ? chalk.dim(` (${shapeRenameMap.size} renames skipped)`)
      : '';
    tableStats.push({ table, upsertRows: toUpsert.length, deleteRows: toDelete.length,
      ...(table === 'shapes' ? { renamedShapes: shapeRenameMap.size } : {}) });
    spinner.succeed(chalk.green(`  ${chalk.bold(table)}: ${toUpsert.length.toLocaleString()} upserts, ${toDelete.length.toLocaleString()} deletes${renameNote}`));
  }
}

await streamEnd();

// Step 4: write stats for the shell confirmation prompt
const upsertStatements = tableStats.reduce((n, t) => n + Math.ceil(t.upsertRows / ROWS_PER_INSERT), 0);
const deleteStatements = tableStats.reduce((n, t) => n + Math.ceil(t.deleteRows / ROWS_PER_INSERT), 0);

writeFileSync(STATS_FILE, JSON.stringify({
  noChange: false,
  mode,
  oldVersion: oldVersion ?? null,
  newVersion,
  sqlFile: OUT_FILE,
  tables: tableStats,
  totalUpsertStatements: upsertStatements,
  totalDeleteStatements: deleteStatements,
}, null, 2));

writeFileSync(`${ARTIFACTS_DIR}/.gtfs_last_sql`, OUT_FILE);

const { size } = (await import('fs')).statSync(OUT_FILE);
console.log(chalk.green(`\n✔ Wrote ${chalk.bold(OUT_FILE)} (${(size / 1024 / 1024).toFixed(1)} MB)`));
