// NtaPollerDO — single global Durable Object that polls the NTA GTFS-Realtime
// feeds on a fixed slot schedule and serves the freshest bytes to the request path.
//
// Why a Durable Object: a plain Worker runs once per colo, so each colo would
// fetch NTA independently and blow past NTA's 1-request-per-60s-per-token limit.
// A DO addressed by a fixed name is a single global instance, so the whole fleet
// makes exactly one set of NTA calls per slot.
//
// Why handlers read from the DO (not KV): KV is eventually consistent — once a
// colo reads a key it caches that value (and its metadata) in-region for up to
// ~60s, so newer writes from the poller stay invisible there. That made clients
// see the SAME data + X-Last-Update-At for ~60s even though we publish every 32s.
// The DO is strongly consistent, so reading the latest bytes from it is always
// fresh. The bytes live in the DO's own storage (ctx.storage), which survives the
// eviction the DO undergoes between 32s alarms — in-memory fields would not.
// KV is still written as a fallback (see publish()).
//
// ── Slot schedule (32s slots, 128s cycle, 2 tokens) ──────────────────────────
//   slot 0  T=0   /Vehicles     KEY_1
//   slot 1  T=32  /Vehicles     KEY_2
//   slot 2  T=64  /Vehicles     KEY_1
//   slot 3  T=96  /TripUpdates  KEY_2   (no /Vehicles call — last bytes stay live)
//   ── repeats at T=128 ──
// Each token is reused every 64s (KEY_1 on slots 0↔2, KEY_2 on slots 1↔3),
// a 4s safety margin over NTA's 60s/token rate limit. The real margin is larger
// since HTTP dispatch latency adds to the wall-clock reuse interval.

import { DurableObject } from "cloudflare:workers";
import { SLOT_MS, CYCLE_SLOTS, FEED_KV_VEHICLES, FEED_KV_TRIPUPDATES, type FeedMetadata, type FeedPayload } from "../lib/nta-client";

const NTA_BASE = "https://api.nationaltransport.ie/gtfsr/v2";

/** Hard timeout for NTA subrequests — avoids hanging indefinitely on a slow upstream. */
const FETCH_TIMEOUT_MS = 10_000;

// Small buffer added to the advertised nextUpdateAt so a client aiming exactly at
// that instant doesn't arrive a hair before the poller has finished fetching and
// writing the next bytes. Covers NTA fetch + KV-put latency for the next slot.
const PUBLISH_LATENCY_BUFFER_MS = 2_000;

// Generous TTL so a single transient poll failure doesn't immediately blank a feed;
// normal operation overwrites each key well within this window.
const FEED_KV_TTL = 600;

export class NtaPollerDO extends DurableObject<Env> {
	// RPC getters the request path calls on a feed-cache miss (see NtaClient.readFeed).
	// They read from ctx.storage — the strongly-consistent, eviction-proof store the
	// poll loop writes to — so reads always reflect the latest successful poll.
	async getVehicles(): Promise<FeedPayload | null> {
		return (await this.ctx.storage.get<FeedPayload>(FEED_KV_VEHICLES)) ?? null;
	}
	async getTripUpdates(): Promise<FeedPayload | null> {
		return (await this.ctx.storage.get<FeedPayload>(FEED_KV_TRIPUPDATES)) ?? null;
	}

	// Idempotent kick — ensures the alarm loop is running. Called by the cron
	// watchdog (see index.ts); safe to call repeatedly from any colo.
	async start(): Promise<void> {
		const existing = await this.ctx.storage.getAlarm();
		if (existing == null) {
			await this.ctx.storage.setAlarm(this.nextSlotBoundary());
		}
	}

	async alarm(): Promise<void> {
		try {
			await this.poll();
		} catch (err) {
			console.error("[poller] poll failed", err);
		} finally {
			// Always reschedule so the loop survives transient errors. Alarm auto-retry
			// is capped at 6 attempts, so self-rescheduling is what keeps it alive forever.
			await this.ctx.storage.setAlarm(this.nextSlotBoundary());
		}
	}

	// Next 32s wall-clock boundary — matches the slot math in nta-client so the
	// poller fires exactly on slot edges (deterministic across restarts).
	private nextSlotBoundary(): number {
		return Math.floor(Date.now() / SLOT_MS) * SLOT_MS + SLOT_MS;
	}

	// Epoch ms (plus a small latency buffer) of the next slot boundary that will
	// publish THIS feed — not just the next alarm. Vehicles publish on every slot
	// except slot 3 (which fetches TripUpdates); TripUpdates publish only on slot 3.
	// So each feed has its own cadence and clients must be told the feed-specific time.
	private nextPublishBoundary(isTripUpdates: boolean): number {
		// `n` = how many whole slots have elapsed since the epoch. The current slot
		// number in the cycle is n % 4; n+1 is the next slot, n+2 the one after, etc.
		const n = Math.floor(Date.now() / SLOT_MS);

		// Walk forward one slot at a time, looking ahead up to a full cycle (4 slots),
		// and stop at the first upcoming slot that publishes the feed we care about.
		for (let k = 1; k <= CYCLE_SLOTS; k++) {
			// Is the slot k steps ahead the TripUpdates slot (slot 3 in the cycle)?
			const isTripSlot = (n + k) % CYCLE_SLOTS === 3;

			// Match found when that slot's type equals the feed we're asking about:
			//   - TripUpdates feed → we want the trip slot      (isTripSlot === true)
			//   - Vehicles feed    → we want any non-trip slot  (isTripSlot === false)
			if (isTripSlot === isTripUpdates) {
				// Convert that slot index back to a wall-clock time, then add the buffer
				// so the advertised instant is just after the bytes are actually written.
				return (n + k) * SLOT_MS + PUBLISH_LATENCY_BUFFER_MS;
			}
		}

		// Unreachable: within any 4 consecutive slots there's always one trip slot and
		// three vehicle slots, so the loop above always returns. This is a safety net.
		return (n + 1) * SLOT_MS + PUBLISH_LATENCY_BUFFER_MS;
	}

	private async poll(): Promise<void> {
		const slot = Math.floor(Date.now() / SLOT_MS) % CYCLE_SLOTS;

		if (slot === 3) {
			const bytes = await this.fetchNta("/TripUpdates", this.env.NTA_API_KEY_2);
			if (bytes) await this.publish(FEED_KV_TRIPUPDATES, bytes, this.nextPublishBoundary(true));
		} else {
			// slots 0 & 2 → KEY_1, slot 1 → KEY_2 (each token reused every 64s)
			const apiKey = slot % 2 === 0 ? this.env.NTA_API_KEY_1 : this.env.NTA_API_KEY_2;
			const bytes = await this.fetchNta("/Vehicles", apiKey);
			if (bytes) await this.publish(FEED_KV_VEHICLES, bytes, this.nextPublishBoundary(false));
		}
	}

	private async publish(key: string, bytes: Uint8Array, nextUpdateAt: number): Promise<void> {
		// lastUpdateAt = now, the instant this successful poll's bytes are written.
		const metadata: FeedMetadata = { nextUpdateAt, lastUpdateAt: Date.now() };
		const payload: FeedPayload = { bytes, metadata };

		// Mirror to KV first so it always has the latest bytes even if the DO-storage
		// write below fails. KV is the cold-start/fallback source and the ONLY source the
		// staging Worker has (staging binds no poller DO — see wrangler.jsonc).
		await this.env.RT_FEED_KV.put(key, bytes, { expirationTtl: FEED_KV_TTL, metadata });

		// DO storage is the strongly-consistent source of truth the request path reads
		// via RPC. It survives the eviction the DO undergoes between 32s alarms (in-memory
		// state would not). Guarded because the value must stay under the 2 MB row limit;
		// if a feed ever exceeds it we degrade to KV-only for that feed rather than crash.
		try {
			await this.ctx.storage.put(key, payload);
		} catch (err) {
			console.error(`[poller] storage.put ${key} failed (falling back to KV)`, err);
		}
		console.log(`[poller] published ${key} (${bytes.length}B) nextUpdateAt=${nextUpdateAt}`);
	}

	private async fetchNta(path: string, apiKey: string): Promise<Uint8Array | null> {
		try {
			const res = await fetch(`${NTA_BASE}${path}`, {
				headers: { "x-api-key": apiKey },
				signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
			});
			if (!res.ok) {
				console.warn(`[poller] ${path} → HTTP ${res.status}`);
				return null;
			}
			return new Uint8Array(await res.arrayBuffer());
		} catch (err) {
			console.warn(`[poller] ${path} fetch failed`, err);
			return null;
		}
	}
}
