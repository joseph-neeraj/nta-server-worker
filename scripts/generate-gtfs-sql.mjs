#!/usr/bin/env node
// Downloads the NTA GTFS static ZIP and generates a SQL file.
// Run after: npx wrangler d1 execute nta-static --remote --file=gtfs_import.sql
//
// The generated SQL uses a shadow-table swap: data loads into *_new tables,
// then an atomic rename replaces the live tables only after all inserts succeed.
// `wrangler d1 execute --file` wraps the entire file in a transaction automatically,
// so explicit BEGIN/COMMIT must NOT appear in the SQL (D1 forbids them).

import AdmZip from 'adm-zip';
import { createWriteStream, writeFileSync } from 'fs';
import { promisify } from 'util';
import chalk from 'chalk';
import ora from 'ora';

const GTFS_URL = 'https://www.transportforireland.ie/transitData/Data/GTFS_Realtime.zip';

const TS = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
const ZIP_FILE = `gtfs_${TS}.zip`;
const OUT_FILE = `gtfs_${TS}.sql`;

console.log(chalk.dim(`  zip: ${ZIP_FILE}`));
console.log(chalk.dim(`  sql: ${OUT_FILE}`));
const ROWS_PER_INSERT = 500;

const TABLES = [
  {
    table: 'agency',
    file: 'agency.txt',
    columns: ['agency_id', 'agency_name', 'agency_url', 'agency_timezone'],
    ddl: `CREATE TABLE agency_new (
  agency_id TEXT PRIMARY KEY, agency_name TEXT NOT NULL,
  agency_url TEXT, agency_timezone TEXT
)`,
  },
  {
    table: 'routes',
    file: 'routes.txt',
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
    columns: ['service_id', 'date', 'exception_type'],
    ddl: `CREATE TABLE calendar_dates_new (
  service_id TEXT NOT NULL, date TEXT NOT NULL,
  exception_type INTEGER NOT NULL, PRIMARY KEY (service_id, date)
)`,
  },
  {
    table: 'shapes',
    file: 'shapes.txt',
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
    columns: ['trip_id', 'arrival_time', 'departure_time', 'stop_id', 'stop_sequence', 'stop_headsign', 'pickup_type', 'drop_off_type', 'timepoint'],
    ddl: `CREATE TABLE stop_times_new (
  trip_id TEXT NOT NULL, arrival_time TEXT, departure_time TEXT,
  stop_id TEXT NOT NULL, stop_sequence INTEGER NOT NULL,
  stop_headsign TEXT, pickup_type INTEGER, drop_off_type INTEGER,
  timepoint INTEGER, PRIMARY KEY (trip_id, stop_sequence)
)`,
  },
];

// ── CSV parser ────────────────────────────────────────────────────

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

// ── SQL helpers ───────────────────────────────────────────────────

function lit(val) {
  if (val === '' || val == null) return 'NULL';
  return "'" + String(val).replace(/'/g, "''") + "'";
}

function writeInserts(stream, table, columns, rows) {
  // Write one INSERT per chunk directly to the stream rather than building
  // a return value. stop_times alone has ~4M rows; joining all those strings
  // into a single return value exceeds V8's max string length (~512 MB) and
  // throws RangeError: Invalid string length.
  const colList = columns.join(',');
  for (let i = 0; i < rows.length; i += ROWS_PER_INSERT) {
    const batch = rows.slice(i, i + ROWS_PER_INSERT);
    const values = batch.map(r => `(${columns.map(c => lit(r[c])).join(',')})`).join(',\n  ');
    stream.write(`INSERT INTO ${table}_new (${colList}) VALUES\n  ${values};\n`);
  }
}

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

// Save the raw ZIP so you can inspect or re-run SQL generation without re-downloading
writeFileSync(ZIP_FILE, buf);
console.log(chalk.dim(`  Saved zip → ${ZIP_FILE}`));

// Step 2: parse CSVs and stream SQL to file
console.log(chalk.bold.yellow('\n▶ Processing tables'));
const zip = new AdmZip(buf);

// Use a WriteStream instead of accumulating the SQL in a string.
// The full import SQL (shapes + stop_times alone) exceeds several hundred MB —
// holding that in memory as a JS string hits V8's string length limit and
// crashes with RangeError. Streaming writes each chunk to disk as it's
// generated, keeping memory usage flat regardless of dataset size.
const stream = createWriteStream(OUT_FILE, { encoding: 'utf8' });
const streamWrite = (s) => { if (!stream.write(s)) { /* backpressure ignored — local file */ } };
const streamEnd = promisify(stream.end.bind(stream));

// wrangler d1 execute --file wraps the whole file in a transaction automatically;
// explicit BEGIN/COMMIT are forbidden by D1 and will cause an error.

for (const { table } of TABLES) {
  streamWrite(`DROP TABLE IF EXISTS ${table}_new;\n`);
}
streamWrite('\n');

let totalRows = 0;
for (const { table, file, columns, ddl } of TABLES) {
  const spinner = ora({ text: chalk.cyan(`  ${table} ...`), color: 'cyan', indent: 2 }).start();
  const entry = zip.getEntry(file);
  const rows = entry ? parseCSV(entry.getData().toString('utf8')) : [];
  totalRows += rows.length;

  streamWrite(`-- ${table}\n${ddl};\n`);
  if (rows.length > 0) writeInserts(stream, table, columns, rows);
  streamWrite('\n');

  spinner.succeed(chalk.green(`  ${chalk.bold(table)}: ${rows.length.toLocaleString()} rows`));
}

// Atomic swap: drop live tables, rename _new → live
for (const { table } of TABLES) {
  streamWrite(`DROP TABLE ${table};\n`);
  streamWrite(`ALTER TABLE ${table}_new RENAME TO ${table};\n`);
}
await streamEnd();

// Step 3: report
const { size } = (await import('fs')).statSync(OUT_FILE);
const sizeMB = (size / 1024 / 1024).toFixed(1);
console.log(chalk.green(`\n✔ Wrote ${chalk.bold(OUT_FILE)} (${sizeMB} MB, ${totalRows.toLocaleString()} rows across ${TABLES.length} tables)`));

// Write the SQL filename to a marker file so the shell script knows what to execute
writeFileSync('.gtfs_last_sql', OUT_FILE);

console.log(chalk.bold.yellow('\n▶ Next step:'));
console.log(chalk.dim(`  npx wrangler d1 execute nta-static --remote --file=${OUT_FILE}\n`));
