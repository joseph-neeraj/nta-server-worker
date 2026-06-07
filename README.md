# nta-server-worker

A Cloudflare Worker that proxies [NTA GTFS-Realtime](https://developer.nationaltransport.ie/api-details#api=gtfsr) feeds and serves static GTFS schedule data from a D1 database.

---

## Overview

| Layer | What it does |
|---|---|
| **Live vehicles** (`GET /v1/live/vehicles`) | All active vehicles with real-time positions, enriched with route and headsign from static GTFS. Cached at the CF edge for 65 s. |
| **Trip details** (`GET /v1/live/trips/:trip_id`) | Full trip info: static route/stops/shape plus real-time stop delays. Cached per trip for 65 s. |
| **Session init** (`POST /init`) | Issues a short-lived JWT for authenticating subsequent API requests. |

Requests are routed in `src/index.ts` via [Hono](https://hono.dev/).

---

## Prerequisites

- Node.js ≥ 18
- A [Cloudflare account](https://dash.cloudflare.com/) with Workers, D1, and KV enabled
- An NTA API key from the [NTA Developer Portal](https://developer.nationaltransport.ie/)

---

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Create the KV namespace (rate limiting)

```bash
npx wrangler kv namespace create RATE_LIMIT_KV
```

Copy the returned `id` into `wrangler.jsonc` under `kv_namespaces[0].id`.

### 3. Set secrets

```bash
npx wrangler secret put NTA_API_KEY_1   # NTA API key (primary)
npx wrangler secret put NTA_API_KEY_2   # NTA API key (secondary/fallback)
npx wrangler secret put HMAC_SECRET     # Shared secret embedded in the mobile app
npx wrangler secret put JWT_SECRET      # Worker-side secret for signing session JWTs
```

See `scripts/setup-secrets.sh` for guidance on generating secure values for `HMAC_SECRET` and `JWT_SECRET`.

### 4. Create the D1 database

```bash
npx wrangler d1 create nta-static
```

Copy the returned `database_id` into `wrangler.jsonc` under `d1_databases[0].database_id`.

### 5. Apply the schema migration

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
# or use the deploy script directly:
bash scripts/deploy.sh
```

---

## Security

Three layers of protection prevent abuse from bots, scrapers, and unauthorised API consumers without adding any friction for real users.

### 1. HMAC request signing (`POST /init` only)

The mobile app signs every `/init` request with a shared secret (`HMAC_SECRET`) using HMAC-SHA256. The signature covers the HTTP method, path, and a Unix timestamp (`X-Timestamp` header), and is sent as `X-Signature` (base64).

The Worker verifies the signature and **rejects any request with a timestamp older than 30 seconds** to prevent replay attacks. Requests that fail verification receive a `401`.

> Note: the shared secret is embedded in the app binary. This stops casual scraping but a motivated attacker with a decompiler could extract it. It is obfuscation, not authentication.

### 2. Short-lived JWT session tokens

On a successful `/init`, the Worker issues a signed JWT (HS256, 1 hour expiry) containing a unique `jti` claim. All subsequent API calls must include this token as a `Bearer` token in the `Authorization` header. The `jwt()` Hono middleware validates the token on every `/v1/*` request — invalid or expired tokens receive a `401`.

### 3. Rate limiting

| Endpoint | Key | Limit |
|---|---|---|
| `POST /init` | IP (`CF-Connecting-IP`) | 120 requests / IP / hour |
| `GET /v1/*` | Token identity (`jti`) | 120 requests / token / minute |

IP-based limiting on `/init` is set generously to accommodate users behind NAT or mobile carrier CGNAT. The `/v1/*` routes are limited per token rather than per IP — each session has its own independent bucket, so users sharing an IP cannot affect each other.

Rate limit state is stored in the `RATE_LIMIT_KV` KV namespace.

---

## API endpoints

All `/v1/*` endpoints require a valid JWT in the `Authorization: Bearer <token>` header (obtained from `POST /init`).

### `POST /init`

Issues a session token. No `Authorization` header required, but the request must be HMAC-signed.

**Required headers:**

| Header | Value |
|---|---|
| `X-Timestamp` | Unix timestamp (seconds) |
| `X-Signature` | HMAC-SHA256 of `method + pathname + timestamp`, base64-encoded |

**Response:**
```json
{ "token": "<jwt>" }
```

---

### `GET /v1/live/vehicles`

Returns all active vehicles with real-time positions, enriched with `route_short_name` and `trip_headsign` from static GTFS.

**Accepted formats** (`Accept` header):
- `application/x-protobuf` — binary protobuf
- `application/json` — JSON (only when `ENABLE_JSON=true`)

Responses are cached at the edge for **65 seconds**.

---

### `GET /v1/live/trips/:trip_id`

Returns full trip details: static route info, stop list with arrival/departure times, shape polyline, and real-time stop delays.

**Response shape (JSON):**
```json
{
  "tripId": "5675_85",
  "tripHeadsign": "Edenderry Town Hall",
  "routeShortName": "120",
  "routeLongName": "Dublin - Edenderry",
  "routeType": 3,
  "agencyName": "Go-Ahead Ireland",
  "shape": [{ "lat": 53.3498, "lon": -6.249, "distTraveled": 0 }],
  "stops": [
    {
      "stopSequence": 1,
      "stopId": "8340B355121",
      "stopName": "Dublin, Busáras",
      "arrivalTime": "14:00:00",
      "arrivalDelay": 120,
      "departureDelay": 120
    }
  ]
}
```

Responses are cached per `trip_id` for **65 seconds**.

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

Run the publish script — it handles download, SQL generation, diff detection, and D1 import interactively:

```bash
bash scripts/gtfs/publish.sh
```

See the [Scripts section](#scripts) for a full breakdown of how it works.

---

## Protobuf type generation

The GTFS-Realtime protobuf types in `src/generated/` are generated from `res/gtfs-realtime.proto`:

```bash
npm run proto
```

Requires `protoc` to be installed (`brew install protobuf` on macOS).

---

## Scripts

All scripts live in `scripts/`. Run them from the project root.

### `scripts/deploy.sh`

Thin wrapper around `npm run deploy` with coloured output. Equivalent to running `npm run deploy` directly.

```bash
bash scripts/deploy.sh
```

---

### `scripts/generate-proto.sh`

Generates TypeScript types from `res/gtfs-realtime.proto` into `src/generated/res/gtfs-realtime.ts`. Wraps `npm run proto`.

Requires `protoc`:
```bash
brew install protobuf   # macOS
```

```bash
bash scripts/generate-proto.sh
```

---

### `scripts/setup-secrets.sh`

**Reference only — do not execute directly.** Contains step-by-step commands for generating and uploading `HMAC_SECRET` and `JWT_SECRET` to Cloudflare. Open it and run the commands manually, one at a time, so secrets are pasted interactively and never appear in shell history.

---

### `scripts/gtfs/publish.sh` _(recommended)_

End-to-end script to refresh the static GTFS data in D1. Before running, edit the two variables at the top of the file:

```bash
export CLOUDFLARE_ACCOUNT_ID="your-account-id"
export CLOUDFLARE_API_TOKEN="your-api-token"
```

The script will refuse to run if these are still set to the placeholder values.

```bash
bash scripts/gtfs/publish.sh
```

See [How `publish.sh` works](#how-publishsh-works) below for a detailed breakdown.

---

### `scripts/gtfs/print-stats.mjs`

Reads `.gtfs_stats.json` (written by `generate-sql.mjs`) and prints a per-table breakdown of upserts and deletes. Exits `0` if the feed version is unchanged (nothing to import), `1` if there are changes. Called by `publish.sh` — not normally run directly.

---

### How `publish.sh` works

The script runs in two steps with interactive confirmation between them.

**Step 1 — Download and generate SQL**

`generate-sql.mjs` is called with an increased Node.js heap. It runs in one of two modes depending on whether a previous import baseline exists:

| Mode | When | What it generates |
|---|---|---|
| **FULL** | First run (no `.gtfs_last_zip` file) | Loads all rows into shadow `*_new` tables, then atomically renames them to replace the live tables. Live data is never partially updated. |
| **DIFF** | Subsequent runs | Compares the new ZIP against the last successfully imported ZIP. Generates only `INSERT OR REPLACE` for new/changed rows and `DELETE` for removed rows. Much faster and smaller SQL file. |

The script writes three tracking files to the project root:

| File | Purpose |
|---|---|
| `.gtfs_stats.json` | Per-table row counts (upserts/deletes) used for the confirmation prompt |
| `.gtfs_pending_zip` | Path of the just-downloaded ZIP (not yet committed as baseline) |
| `.gtfs_last_zip` | Path of the last successfully imported ZIP (used as diff baseline next run) |
| `.gtfs_last_sql` | Path of the generated SQL file |

**Confirmation prompt**

After generation, `print-stats.mjs` prints a per-table breakdown:

```
  Mode : diff  (2026-06-01 → 2026-06-06)

  agency          (unchanged)
  routes          +12 upserts (1 stmts), -3 deletes (1 stmts)
  stop_times      +4,821 upserts (10 stmts), -190 deletes (1 stmts)
  ...

  Total : 5,103 upserts, 193 deletes → 14 SQL statements
```

If the feed version is unchanged, the script exits early with no import.

**Step 2 — Execute SQL against D1**

Runs `npx wrangler d1 execute` against the generated SQL file. Pass `--remote` flag by answering `y` to the "Publish to remote?" prompt at the start.

`wrangler d1 execute --file` wraps the entire file in a transaction automatically — no explicit `BEGIN`/`COMMIT` appears in the SQL (D1 forbids them).

After a successful import, `.gtfs_pending_zip` is promoted to `.gtfs_last_zip`, making the new ZIP the baseline for the next diff run. If the import fails, the baseline is not updated, so the next run will re-generate the full diff against the last known-good state.

---

## Project structure

```
src/
  index.ts              # Entry point — Hono router
  init.ts               # POST /init — HMAC verification + JWT issuance
  vehicles.ts           # GET /v1/live/vehicles
  vehicle-details.ts    # GET /v1/live/trips/:trip_id
  nta-client.ts         # NTA API client with key rotation and edge caching
  env.d.ts              # Env interface extensions (secrets)
  generated/
    res/
      gtfs-realtime.ts  # Auto-generated protobuf types
      nta.ts            # Auto-generated protobuf types
scripts/
  deploy.sh             # Deploy to Cloudflare
  generate-proto.sh     # Regenerate protobuf TypeScript types
  setup-secrets.sh      # Reference guide for creating Cloudflare secrets
  gtfs/
    publish.sh          # End-to-end static GTFS data refresh (download → SQL → D1)
    generate-sql.mjs    # Downloads GTFS ZIP and generates SQL import file
    print-stats.mjs     # Prints per-table diff breakdown from .gtfs_stats.json
migrations/
  0001_gtfs_static.sql  # D1 schema
res/
  gtfs-realtime.proto   # Protobuf definition
wrangler.jsonc          # Wrangler / Worker configuration
```

