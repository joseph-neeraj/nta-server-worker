// Reads the latest GTFS-Realtime feeds (decoded) for the request path.
//
// Polling NTA (token rotation + rate-limit budgeting) is owned by NtaPollerDO,
// a single global Durable Object that fetches each feed once per slot. This client
// reads the freshest bytes DIRECTLY from that DO (strongly consistent) rather than
// from KV, because KV caches a value in-region for up to ~60s after a newer write
// and would otherwise serve stale data + a frozen X-Last-Update-At. A feed-level
// edge cache in front of the DO bounds reads to ~one per colo per slot, and KV is
// kept as a fallback (and as the only source for the staging Worker, which binds
// no poller DO).
//
// ── Slot schedule (owned by the poller; documented here for the cache keys) ──
// 32s slots, 128s cycle (4 slots). Two NTA tokens, each reused every 64s
// (4s margin over NTA's 60s/token limit; real margin is larger once HTTP
// dispatch latency is added on top of the wall-clock reuse interval):
//   slot 0  T=0   /Vehicles     KEY_1
//   slot 1  T=32  /Vehicles     KEY_2
//   slot 2  T=64  /Vehicles     KEY_1
//   slot 3  T=96  /TripUpdates  KEY_2   (Vehicles keeps serving slot 2's data)

import { FeedMessage } from "../generated/res/gtfs-realtime";

/** Metadata the poller stores alongside each feed in KV. */
export type FeedMetadata = { nextUpdateAt: number; lastUpdateAt: number };

/** Raw feed bytes + metadata, as held in the poller's storage and returned over RPC. */
export type FeedPayload = { bytes: Uint8Array; metadata: FeedMetadata };

/**
 * A decoded feed plus the poller's metadata (next/last update instants).
 * metadata is null when the poller hasn't stamped it yet (cold start).
 */
export type FeedResult = { feed: FeedMessage; metadata: FeedMetadata | null };

/** Slot timing — shared with NtaPollerDO so its schedule and the cache keys agree. */
export const SLOT_MS = 32_000;   // 32s per slot
export const CYCLE_SLOTS = 4;    // 4 × 32s = 128s cycle

/** Edge-cache TTL for enriched /Vehicles responses (slot 32s + small buffer). */
export const VEHICLE_CACHE_TTL = 34;

/** KV keys the poller writes and this client reads (in the dedicated RT_FEED_KV namespace). */
export const FEED_KV_VEHICLES = "feed:vehicles";
export const FEED_KV_TRIPUPDATES = "feed:tripupdates";

/** Fixed name of the single global poller DO (shared with index.ts). */
export const POLLER_NAME = "nta-poller";

// Types for the poller DO binding, derived from Env so we don't import the DO class
// (which would create a circular import — the DO imports constants from this file).
type PollerNamespace = Env["NTA_POLLER"];
type PollerStub = ReturnType<PollerNamespace["getByName"]>;

// Feed-level edge cache TTLs: how long a raw feed stays cached per colo to bound
// poller-DO reads. Vehicles refresh per 32s slot; TripUpdates per 128s cycle, so
// the TTLs match those windows. The slot/epoch in the cache key drives correctness
// — the TTL just caps how long stale-after-rotation entries linger before cleanup.
const VEHICLES_FEED_CACHE_TTL = VEHICLE_CACHE_TTL; // ~one 32s slot
const TRIPUPDATES_FEED_CACHE_TTL = 130;            // ~one 128s cycle + buffer

// Internal headers carrying raw (unclamped) metadata on feed-cache entries.
const FEED_META_NEXT = "x-feed-next-update-at";
const FEED_META_LAST = "x-feed-last-update-at";

/**
 * Current 32s slot index within the 128s cycle (0–3).
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
 * Epoch key for the enriched /TripUpdates edge cache — increments once per 128s
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

	async fetchVehicles(): Promise<FeedResult | null> {
		return this.readFeed(FEED_KV_VEHICLES, `vehicles:${vehicleSlot()}`, VEHICLES_FEED_CACHE_TTL, (stub) => stub.getVehicles());
	}

	async fetchTripUpdates(): Promise<FeedResult | null> {
		return this.readFeed(FEED_KV_TRIPUPDATES, `tripupdates:${tripUpdateCacheKey()}`, TRIPUPDATES_FEED_CACHE_TTL, (stub) => stub.getTripUpdates());
	}

	// Reads the latest feed, newest-source-first:
	//   1. feed-level edge cache  — collapses many enriched-cache misses (especially
	//      per-trip / per-stop ones) into ONE poller read per colo per slot.
	//   2. the poller DO directly — strongly consistent, unlike KV (which can keep
	//      serving a value cached in-region for up to ~60s after a newer write).
	//   3. KV — fallback for the brief window after the DO is recreated post eviction
	//      and before its first poll, AND the only source on staging (no poller DO).
	// Returns null if no source has data, so handlers' graceful-degradation applies.
	private async readFeed(
		kvKey: string,
		cacheTag: string,
		cacheTtl: number,
		readFromDO: (stub: PollerStub) => Promise<FeedPayload | null>,
	): Promise<FeedResult | null> {
		const cache = caches.default;
		const cacheKey = feedCacheKey(cacheTag);

		const cached = await cache.match(cacheKey);
		if (cached) {
			const bytes = new Uint8Array(await cached.arrayBuffer());
			return this.toResult(bytes, readFeedCacheMeta(cached));
		}

		let payload = await this.readFromPoller(readFromDO);
		if (!payload) payload = await this.readFromKV(kvKey);
		if (!payload) return null;

		// Warm the feed cache so sibling requests in this slot skip the DO hop. Stores
		// raw (unclamped) metadata in headers; clamping happens in toResult on the way out.
		await cache.put(cacheKey, new Response(payload.bytes, {
			headers: { "Cache-Control": `public, max-age=${cacheTtl}`, ...feedCacheMetaHeaders(payload.metadata) },
		}));

		return this.toResult(payload.bytes, payload.metadata);
	}

	// Calls the single global poller DO for its freshest stored payload. Returns null
	// when no poller DO is bound (staging shares prod's feeds via KV) so the caller
	// falls through to readFromKV instead of throwing on an undefined binding.
	private readFromPoller(call: (stub: PollerStub) => Promise<FeedPayload | null>): Promise<FeedPayload | null> {
		const ns = this.env.NTA_POLLER as PollerNamespace | undefined;
		if (!ns) return Promise.resolve(null);
		return call(ns.getByName(POLLER_NAME));
	}

	// Last-resort read of the bytes the poller persisted to KV. Eventually consistent
	// (may be stale), so it's only used when the DO has no data yet or isn't bound.
	private async readFromKV(kvKey: string): Promise<FeedPayload | null> {
		const { value, metadata } = await this.env.RT_FEED_KV.getWithMetadata<FeedMetadata>(kvKey, "arrayBuffer");
		if (!value || !metadata) return null;
		return { bytes: new Uint8Array(value), metadata };
	}

	// Decodes the feed and clamps nextUpdateAt so a stalled poller can't advertise a
	// past instant (lastUpdateAt is a real past timestamp, returned as-is).
	private toResult(bytes: Uint8Array, metadata: FeedMetadata): FeedResult {
		return {
			feed: FeedMessage.decode(bytes),
			metadata: { nextUpdateAt: clampNextUpdateAt(metadata.nextUpdateAt), lastUpdateAt: metadata.lastUpdateAt },
		};
	}
}

/** Synthetic cache key for a raw feed entry in the colo's edge cache. */
function feedCacheKey(tag: string): Request {
	return new Request(`https://nta-feed-cache/${tag}`, { method: "GET" });
}

function feedCacheMetaHeaders(m: FeedMetadata): Record<string, string> {
	return { [FEED_META_NEXT]: String(m.nextUpdateAt), [FEED_META_LAST]: String(m.lastUpdateAt) };
}

function readFeedCacheMeta(res: Response): FeedMetadata {
	return {
		nextUpdateAt: Number(res.headers.get(FEED_META_NEXT)),
		lastUpdateAt: Number(res.headers.get(FEED_META_LAST)),
	};
}

/**
 * Worker-side guard for the advertised next-update time. If the poller stalled,
 * the stored nextUpdateAt can be in the past — clamp it to now + one slot so
 * clients retry soon (but not in a tight loop).
 */
function clampNextUpdateAt(nextUpdateAt: number): number {
	const floor = Date.now() + SLOT_MS;
	return Math.max(nextUpdateAt, floor);
}
