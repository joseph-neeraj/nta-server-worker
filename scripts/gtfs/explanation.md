# How the GTFS static data import works

This document explains how the NTA GTFS static schedule data is downloaded, compared, and imported into Cloudflare D1. It also explains an optimisation that was added to reduce the number of database writes.

---

## The problem this system solves

NTA (National Transport Authority) publishes a ZIP file every day containing the full public transport schedule for Ireland — every bus, train, and tram route, every stop, every trip, every timetable. This ZIP is about 140 MB and when unpacked contains around 15 million rows of data.

We need this data in a Cloudflare D1 database so the API can answer questions like "what stops does bus 120 make?" or "where does this trip go?" without calling NTA directly on every request.

The challenge: **you can't just re-import everything every day.** Writing 15 million rows daily would cost money (Cloudflare charges per row written) and take a long time. So instead, we only write what actually changed.

---

## What the scripts do

There are two scripts that work together:

### `generate-sql.mjs`

This is the main script. It:

1. Downloads the latest GTFS ZIP from NTA
2. Compares it against the last ZIP that was successfully imported
3. Generates a SQL file containing only the changes (inserts, updates, deletes)

### `publish.sh`

This is the shell script you actually run. It calls `generate-sql.mjs`, shows you a summary of what changed, asks for confirmation, then executes the SQL against the D1 database.

---

## Two modes: FULL and DIFF

### FULL mode (first run only)

The very first time you run the script, there's no previous ZIP to compare against, so it does a full import. It loads all rows into temporary "shadow" tables (e.g. `trips_new`, `stops_new`), and once everything is loaded, it swaps them atomically to replace the live tables. This means the live database is never partially updated — it goes from old to new in one step.

### DIFF mode (every run after that)

On subsequent runs, the script compares the new ZIP against the last successfully imported ZIP row by row. It generates:

- `INSERT OR REPLACE` statements only for rows that are new or changed
- `DELETE` statements only for rows that were removed

Everything that didn't change is simply not touched.

The last successfully imported ZIP is recorded in `.gtfs_last_zip`. This file is only updated **after** the D1 import succeeds — so if an import fails halfway, the next run will re-generate the diff against the last known-good state and try again.

---

## The shape rename problem

### What NTA does

Every table has a primary key — a unique identifier for each row. For example, the `trips` table uses `trip_id`, and the `shapes` table uses `(shape_id, shape_pt_sequence)`.

NTA regenerates this data every day. When they do, they sometimes assign **new names** to shapes — even when the actual GPS coordinates haven't changed at all. So a shape that was called `5692_85` might become `5703_104` overnight, even though it traces exactly the same route on the map.

### Why this is expensive

The diff script works by comparing primary keys. If a shape's name changed from `5692_85` to `5703_104`:

- The old name looks like it was deleted → generates DELETE statements for all its GPS points
- The new name looks like it was added → generates INSERT statements for all the same GPS points

A single shape can have hundreds of GPS points. Multiply that by the ~164 shapes that get renamed every day and you get hundreds of thousands of unnecessary database writes.

It also affects the `trips` table. Every trip references a shape by name in its `shape_id` column. If the shape was renamed, the trip row now looks different even if nothing about the trip schedule changed — generating unnecessary trip writes too.

### The fix: geometry fingerprinting

Instead of comparing shape names, we compare the actual GPS content of each shape. The process:

1. For each shape in both the old and new ZIP, compute a short fingerprint (a hash) of its sorted lat/lon points — ignoring the name and ignoring `shape_dist_traveled` which can fluctuate
2. If a shape in the new ZIP has a name that doesn't exist in the old ZIP, but its fingerprint does match something in the old ZIP, it's a rename — same GPS data under a new name
3. For renames: skip writing the shape to D1 entirely. The old rows are already correct. Record the mapping `new name → old name`.
4. When processing trips: before comparing old vs new trip rows, translate any renamed `shape_id` through this mapping. A trip that only changed because its shape was renamed will now look identical to the old trip — no write needed.

### What gets deleted

A shape is only deleted from D1 if its GPS fingerprint no longer appears anywhere in the new feed — meaning it's genuinely gone, not just renamed.

---

## Results

The test in `scripts/gtfs/test/` runs both the old (unoptimised) and new (optimised) diff against two real NTA feeds — one from 6 June 2026 and one from 9 June 2026 — and shows the comparison:

```
──────────────────────────────────────────────────────────────────────
Table              Before      After      Saved  %
──────────────────────────────────────────────────────────────────────
shapes upsert    512,294   289,924   222,370  43.4%
shapes delete    371,293   204,705   166,588  44.9%
trips upsert     235,732   235,732         0  0.0%
trips delete      10,629    10,629         0  0.0%
──────────────────────────────────────────────────────────────────────
TOTAL          1,129,948   740,990   388,958  34.4%
──────────────────────────────────────────────────────────────────────
```

About 34% fewer writes for shapes and trips combined. Trips still show 0% savings because NTA also changes the `trip_id` on the same day they rename shapes, so normalising `shape_id` alone isn't enough — the primary key itself is different. The stop_times and calendar churn is real data (schedule expiry as the calendar window moves forward each day) and cannot be avoided.

---

## Why trips still churn

The 235K daily trip writes are caused by NTA's rolling calendar window, not by anything we can optimise. NTA publishes about 12 months of schedule data at a time. Services that were valid last week may have an `end_date` that's now in the past — those trips disappear from the feed entirely. New future trips appear. This is genuine data change and the database must reflect it.

---

## D1 write costs

Cloudflare D1 charges per row written. On the paid Workers plan, the first 50 million writes per month are included. After the optimisation, this system writes approximately 1.2–1.5 million rows per day (~36–45 million per month), staying within the included allowance with no overage charge.

---

## Running the test

```bash
bash scripts/gtfs/test/run.sh
```

This uses the sample feeds in `scripts/gtfs/test/old.zip` and `scripts/gtfs/test/new.zip`. You can pass your own zips:

```bash
bash scripts/gtfs/test/run.sh path/to/old.zip path/to/new.zip
```

---

## File reference

| File | Purpose |
|---|---|
| `scripts/gtfs/generate-sql.mjs` | Downloads GTFS, diffs against last import, writes SQL |
| `scripts/gtfs/publish.sh` | End-to-end script: generate → confirm → import to D1 |
| `scripts/gtfs/print-stats.mjs` | Prints the per-table diff summary used in the confirmation prompt |
| `scripts/gtfs/test/test-optimization.mjs` | Tests the shape-rename optimisation against sample zips |
| `scripts/gtfs/test/run.sh` | Shell wrapper to run the test |
| `scripts/gtfs/test/old.zip` | Sample GTFS feed (6 Jun 2026) — baseline for the test |
| `scripts/gtfs/test/new.zip` | Sample GTFS feed (9 Jun 2026) — updated feed for the test |
| `.gtfs_last_zip` | Path of the last successfully imported ZIP (diff baseline) |
| `.gtfs_pending_zip` | Path of the just-downloaded ZIP (not yet committed) |
| `.gtfs_stats.json` | Per-table row counts used by the confirmation prompt |
