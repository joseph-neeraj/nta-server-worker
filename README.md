# nta-server-worker

A Cloudflare Worker that proxies [NTA GTFS-Realtime](https://developer.nationaltransport.ie/api-details#api=gtfsr) feeds and (in progress) serves static GTFS schedule data from a D1 database.

---

## Overview

| Layer | What it does |
|---|---|
| **GTFS-R** (`/gtfsr`, `/TripUpdates`, `/Vehicles`) | Proxies live NTA feeds, caches responses for 65 s in Cloudflare's edge cache |
| **Static GTFS** (`/static/*`) | Serves schedule data (routes, stops, trips, stop times…) from a D1 SQLite database |

Requests are routed in `src/index.ts`:
- Paths in `gtfsrPaths` → `src/gtfsr.ts`
- Everything else → `src/static.ts`

---

## Prerequisites

- Node.js ≥ 18
- A [Cloudflare account](https://dash.cloudflare.com/) with Workers and D1 enabled
- An NTA API key from the [NTA Developer Portal](https://developer.nationaltransport.ie/)

---

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Set secrets

```bash
npx wrangler secret put NTA_API_KEY
# Paste your NTA API key when prompted

# Optional — enables JSON responses for debugging clients
npx wrangler secret put ENABLE_JSON
# Enter: true
```

### 3. Create the D1 database

```bash
npx wrangler d1 create nta-static
```

Copy the returned `database_id` into `wrangler.jsonc` under `d1_databases[0].database_id`.

### 4. Apply the schema migration

```bash
npx wrangler d1 execute nta-static --remote --file=migrations/0001_gtfs_static.sql
```

---

## Development

```bash
npm run dev        # local dev server (wrangler dev)
npm test           # run tests (vitest)
npm run cf-typegen # regenerate worker-configuration.d.ts after binding changes
```

---

## Deployment

```bash
npm run deploy
```

---

## GTFS-R endpoints

All endpoints require the `Accept` header to be set to `application/x-protobuf`. JSON responses (`Accept: application/json`) are available only when the `ENABLE_JSON` secret is set to `true`.

| Path | NTA upstream |
|---|---|
| `GET /gtfsr` | Full GTFS-Realtime feed |
| `GET /TripUpdates` | Trip update entities only |
| `GET /Vehicles` | Vehicle position entities only |

Responses are cached at the edge for **65 seconds** (NTA feeds update every ~10–30 s).

---

## Static GTFS data

The static schedule data comes from NTA's `GTFS_Realtime.zip`, loaded into a Cloudflare D1 database (`nta_static`). It should be refreshed periodically (e.g. daily).

### Tables

| Table | Source file | Contents |
|---|---|---|
| `agency` | agency.txt | Operator names and URLs |
| `routes` | routes.txt | Route definitions |
| `calendar` | calendar.txt | Service patterns by day of week |
| `calendar_dates` | calendar_dates.txt | Service exceptions |
| `shapes` | shapes.txt | Route geometry (lat/lon sequences) |
| `stops` | stops.txt | Stop locations |
| `trips` | trips.txt | Trips per route/service |
| `stop_times` | stop_times.txt | Arrival/departure times per stop (~4 M rows) |

### Refreshing the static data

#### Option A — one-shot script (recommended)

Edit `scripts/publish_static_data.sh` and set your Cloudflare credentials:

```bash
export CLOUDFLARE_ACCOUNT_ID="your-account-id"
export CLOUDFLARE_API_TOKEN="your-api-token"
```

Then run:

```bash
bash scripts/publish_static_data.sh
```

This will:
1. Download the latest `GTFS_Realtime.zip` from Transport for Ireland
2. Parse all CSVs and stream a SQL import file to disk (e.g. `gtfs_2026-06-05T12-00-00.sql`)
3. Execute the SQL against the remote D1 database

The import uses a shadow-table swap (`*_new` tables are populated, then atomically renamed to the live tables), so the live data is never in a partially-updated state.

#### Option B — step by step

**Generate the SQL file:**

```bash
npm run generate-gtfs-sql
# or directly:
node scripts/generate-gtfs-sql.mjs
```

This downloads the ZIP, parses the CSVs, and writes a timestamped `.sql` file. The filename is also written to `.gtfs_last_sql`.

**Execute against D1:**

```bash
npx wrangler d1 execute nta-static --remote --file=<filename>.sql
```

> The SQL file can be several hundred MB due to `stop_times`. The generator streams writes to disk to stay within Node.js memory limits.

---

## Protobuf type generation

The GTFS-Realtime protobuf types in `src/generated/` are generated from `res/gtfs-realtime.proto`:

```bash
npm run proto
```

Requires `protoc` to be installed (`brew install protobuf` on macOS).

---

## Project structure

```
src/
  index.ts          # Entry point — routes requests to gtfsr or static handlers
  gtfsr.ts          # GTFS-Realtime proxy with edge caching
  static.ts         # Static GTFS endpoints (D1)
  env.d.ts          # Env interface (secrets + bindings)
  generated/
    res/
      gtfs-realtime.ts  # Auto-generated protobuf types
scripts/
  generate-gtfs-sql.mjs   # Downloads GTFS ZIP and generates SQL import file
  publish_static_data.sh  # End-to-end static data refresh script
migrations/
  0001_gtfs_static.sql    # D1 schema
res/
  gtfs-realtime.proto     # Protobuf definition
wrangler.jsonc            # Wrangler / Worker configuration
```
