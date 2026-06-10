// Single point of entry for all NTA GTFS-Realtime API calls.
//
// ─── Token rotation strategy ─────────────────────────────────────────────────
//
// NTA allows 1 request per 60s per token. We have t1 and t2.
// Goal: serve /Vehicles to clients every 30s, /TripUpdates every 120s.
//
// Solution: a repeating 120s cycle split into four 30s slots.
// Each token is called at most once per 60s — the rate limit is never breached.
//
//   Slot  T(s)  Token  NTA call        NTA cache key  Client sees
//   ────────────────────────────────────────────────────────────────────────
//     0     0    t1    /Vehicles        key=slot=0     fresh vehicles (slot 0)
//     1    30    t2    /Vehicles        key=slot=1     fresh vehicles (slot 1)
//     2    60    t1    /Vehicles        key=slot=2     fresh vehicles (slot 2)
//     3    90    t2    /TripUpdates     key=epoch=N    fresh trips    (epoch N)
//                      /Vehicles: no NTA call          slot 2 cache   (30s old)
//   ── cycle repeats at T=120 ──────────────────────────────────────────────────
//     0   120    t1    /Vehicles        key=slot=0     fresh vehicles (slot 0)
//     ...
//     3   210    t2    /TripUpdates     key=epoch=N+1  fresh trips    (epoch N+1)
//
// /Vehicles cache keys rotate each slot (0/1/2), forcing a fresh NTA fetch every
// 30s. Slot 3 reuses slot 2's key so no /Vehicles call is made — t2 is free for
// /TripUpdates. Clients requesting /Vehicles in slot 3 are served slot 2's data,
// which is at most 30s old (within the 32s TTL).
//
// /TripUpdates uses an epoch key (floor((n-3)/4)) that is stable across the 3
// non-fetch slots and steps up exactly at slot 3. This means slots 0–2 hit the
// cache written by the preceding slot 3, serving fresh trip data throughout the
// cycle.

import { FeedMessage } from "../generated/res/gtfs-realtime";

const NTA_BASE = "https://api.nationaltransport.ie/gtfsr/v2";

const SLOT_MS = 30_000;   // 30s per slot
const CYCLE_SLOTS = 4;    // 4 × 30s = 120s cycle

/** Cache TTL for /Vehicles responses — exported for use by the vehicles handler. */
export const VEHICLE_CACHE_TTL = 32;   // seconds (slot duration 30s + small buffer)

/** Hard timeout for NTA subrequests — avoids hanging indefinitely on a slow upstream. */
const FETCH_TIMEOUT_MS = 10_000;

/**
 * Current 30s slot index within the 120s cycle (0–3).
 *
 * Date.now() is milliseconds since epoch — a large ever-increasing number.
 * Dividing by SLOT_MS and flooring gives an integer that increments every 30s:
 *
 *   T=0s → 0,  T=30s → 1,  T=60s → 2,  T=90s → 3,  T=120s → 4 ...
 *
 * % CYCLE_SLOTS wraps that back to 0–3, repeating:
 *
 *   4 → 0,  5 → 1,  6 → 2,  7 → 3,  8 → 0 ...
 *
 * It's a clock hand. All Worker isolates across all CF PoPs read the same
 * wall clock and independently agree on the current slot — no shared state needed.
 */
function currentSlot(): number {
	return Math.floor(Date.now() / SLOT_MS) % CYCLE_SLOTS;
}

/**
 * Effective slot for /Vehicles cache keys (slot 3 maps to 2 — reuse its cached data).
 * Exported so the vehicles handler can use the same key for its enriched cache.
 */
export function vehicleSlot(): number {
	const slot = currentSlot();
	return slot === 3 ? 2 : slot;
}

/**
 * Cache key for /TripUpdates — increments once per 120s cycle, at slot 3.
 *
 * Unlike vehicleSlot() where reusing the previous slot's data (30s old) is fine,
 * here we need slots 0–2 of each cycle to find the fresh data written by slot 3
 * of that same cycle. A stable -1 sentinel would instead serve the previous
 * cycle's data (up to 120s old).
 *
 * The phase shift (- 3) moves the epoch boundary to slot 3, so slots 0–2
 * and the preceding slot 3 all share the same epoch key:
 *
 *   n    slot (n%4)   epoch (floor((n-3)/4))
 *   ──────────────────────────────────────────────────────
 *   100     0          24   ← cache hit  (shares epoch with n=99's slot 3)
 *   101     1          24   ← cache hit
 *   102     2          24   ← cache hit
 *   103     3          25   ← cache miss → NTA fetch → writes epoch=25
 *   104     0          25   ← cache hit  (finds n=103's fresh data)  ✓
 */
export function tripUpdateCacheKey(): number {
	const n = Math.floor(Date.now() / SLOT_MS);
	return Math.floor((n - 3) / CYCLE_SLOTS);
}

export class NtaClient {
	constructor(private env: Env, private ctx: ExecutionContext) {}

	async fetchVehicles(): Promise<FeedMessage | null> {
		const slot = vehicleSlot();
		const apiKey = slot % 2 === 0 ? this.env.NTA_API_KEY_1 : this.env.NTA_API_KEY_2;
		return this.fetchFeed("/Vehicles", apiKey, slot, VEHICLE_CACHE_TTL);
	}

	async fetchTripUpdates(): Promise<FeedMessage | null> {
		return this.fetchFeed("/TripUpdates", this.env.NTA_API_KEY_2, tripUpdateCacheKey(), 125);
	}

	// Fetches a GTFS-RT feed from NTA, with per-slot Cloudflare edge caching.
	// cacheEpoch scopes the cache key so each slot/epoch gets its own entry.
	// Returns null if the upstream call fails.
	private async fetchFeed(path: string, apiKey: string, cacheEpoch: number, ttl: number): Promise<FeedMessage | null> {
		const cache = caches.default;
		const cacheKey = new Request(`${NTA_BASE}${path}?s=${cacheEpoch}`, { method: "GET" });

		const hit = await cache.match(cacheKey);
		if (hit) {
			const buf = await hit.arrayBuffer();
			return FeedMessage.decode(new Uint8Array(buf));
		}

		const res = await fetch(`${NTA_BASE}${path}`, {
			headers: { "x-api-key": apiKey },
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		});
		if (!res.ok) return null;

		const bytes = new Uint8Array(await res.arrayBuffer());
		this.ctx.waitUntil(cache.put(cacheKey, new Response(bytes, {
			headers: {
				"Content-Type": "application/x-protobuf",
				"Cache-Control": `public, max-age=${ttl}`,
			},
		})));

		return FeedMessage.decode(bytes);
	}
}
