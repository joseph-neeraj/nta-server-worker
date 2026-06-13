// Reads the latest GTFS-Realtime feeds (decoded) from KV.
//
// Polling NTA (token rotation + rate-limit budgeting) is owned by NtaPollerDO,
// a single global Durable Object that fetches each feed once per slot and writes
// the raw proto bytes to KV. This client just reads those bytes and decodes them,
// so the whole fleet shares one set of NTA calls instead of every colo fetching
// independently (which would breach NTA's 60s/token limit).
//
// ── Slot schedule (owned by the poller; documented here for the cache keys) ──
// 40s slots, 160s cycle (4 slots). Two NTA tokens, each reused every 80s
// (20s margin over NTA's 60s/token limit):
//   slot 0  T=0    /Vehicles     KEY_1
//   slot 1  T=40   /Vehicles     KEY_2
//   slot 2  T=80   /Vehicles     KEY_1
//   slot 3  T=120  /TripUpdates  KEY_2   (Vehicles keeps serving slot 2's data)

import { FeedMessage } from "../generated/res/gtfs-realtime";

/** Slot timing — shared with NtaPollerDO so its schedule and the cache keys agree. */
export const SLOT_MS = 40_000;   // 40s per slot
export const CYCLE_SLOTS = 4;    // 4 × 40s = 160s cycle

/** Edge-cache TTL for enriched /Vehicles responses (slot 40s + small buffer). */
export const VEHICLE_CACHE_TTL = 42;

/** KV keys the poller writes and this client reads (in the dedicated RT_FEED_KV namespace). */
export const FEED_KV_VEHICLES = "feed:vehicles";
export const FEED_KV_TRIPUPDATES = "feed:tripupdates";

/**
 * Current 40s slot index within the 160s cycle (0–3).
 * All isolates read the same wall clock, so they agree on the slot with no shared state.
 */
function currentSlot(): number {
	return Math.floor(Date.now() / SLOT_MS) % CYCLE_SLOTS;
}

/**
 * Effective slot for the enriched /Vehicles edge-cache key (slot 3 maps to 2 —
 * no new vehicle data is fetched in slot 3, so it reuses slot 2's entry).
 */
export function vehicleSlot(): number {
	const slot = currentSlot();
	return slot === 3 ? 2 : slot;
}

/**
 * Epoch key for the enriched /TripUpdates edge cache — increments once per 160s
 * cycle, at slot 3 (when the poller publishes fresh TripUpdates). The phase shift
 * (- 3) makes slots 0–2 share the epoch of the preceding slot 3, so the enriched
 * trip response is reused across the cycle and refreshes right after each publish:
 *
 *   n    slot (n%4)   epoch (floor((n-3)/4))
 *   ──────────────────────────────────────────────────────
 *   100     0          24   ← reuse (shares epoch with n=99's slot 3)
 *   101     1          24   ← reuse
 *   102     2          24   ← reuse
 *   103     3          25   ← new epoch → poller publishes TripUpdates
 *   104     0          25   ← reuse (sees n=103's fresh data)  ✓
 */
export function tripUpdateCacheKey(): number {
	const n = Math.floor(Date.now() / SLOT_MS);
	return Math.floor((n - 3) / CYCLE_SLOTS);
}

export class NtaClient {
	constructor(private env: Env) {}

	async fetchVehicles(): Promise<FeedMessage | null> {
		return this.readFeed(FEED_KV_VEHICLES);
	}

	async fetchTripUpdates(): Promise<FeedMessage | null> {
		return this.readFeed(FEED_KV_TRIPUPDATES);
	}

	// Reads the latest feed bytes the poller published to KV, then decodes them.
	// Returns null if the key isn't populated yet (e.g. right after first deploy),
	// so handlers' graceful-degradation paths still apply.
	private async readFeed(key: string): Promise<FeedMessage | null> {
		const buf = await this.env.RT_FEED_KV.get(key, "arrayBuffer");
		if (!buf) return null;
		return FeedMessage.decode(new Uint8Array(buf));
	}
}
