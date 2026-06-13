// NtaPollerDO — single global Durable Object that polls the NTA GTFS-Realtime
// feeds on a fixed slot schedule and publishes the raw proto bytes to KV.
//
// Why a Durable Object: a plain Worker runs once per colo, so each colo would
// fetch NTA independently and blow past NTA's 1-request-per-60s-per-token limit.
// A DO addressed by a fixed name is a single global instance, so the whole fleet
// makes exactly one set of NTA calls per slot. Handlers never call this DO — they
// read the published bytes from KV (see NtaClient), keeping the DO off the request
// hot path.
//
// ── Slot schedule (40s slots, 160s cycle, 2 tokens) ──────────────────────────
//   slot 0  T=0    /Vehicles     KEY_1
//   slot 1  T=40   /Vehicles     KEY_2
//   slot 2  T=80   /Vehicles     KEY_1
//   slot 3  T=120  /TripUpdates  KEY_2   (no /Vehicles call — KV keeps slot 2's)
//   ── repeats at T=160 ──
// Each token is reused every 80s (KEY_1 on slots 0↔2, KEY_2 on slots 1↔3),
// a 20s safety margin over NTA's 60s/token rate limit.

import { DurableObject } from "cloudflare:workers";
import { SLOT_MS, CYCLE_SLOTS, FEED_KV_VEHICLES, FEED_KV_TRIPUPDATES } from "../lib/nta-client";

const NTA_BASE = "https://api.nationaltransport.ie/gtfsr/v2";

/** Hard timeout for NTA subrequests — avoids hanging indefinitely on a slow upstream. */
const FETCH_TIMEOUT_MS = 10_000;

// Generous TTL so a single transient poll failure doesn't immediately blank a feed;
// normal operation overwrites each key well within this window.
const FEED_KV_TTL = 600;

export class NtaPollerDO extends DurableObject<Env> {
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

	// Next 40s wall-clock boundary — matches the slot math in nta-client so the
	// poller fires exactly on slot edges (deterministic across restarts).
	private nextSlotBoundary(): number {
		return Math.floor(Date.now() / SLOT_MS) * SLOT_MS + SLOT_MS;
	}

	private async poll(): Promise<void> {
		const slot = Math.floor(Date.now() / SLOT_MS) % CYCLE_SLOTS;

		if (slot === 3) {
			const bytes = await this.fetchNta("/TripUpdates", this.env.NTA_API_KEY_2);
			if (bytes) await this.publish(FEED_KV_TRIPUPDATES, bytes);
		} else {
			// slots 0 & 2 → KEY_1, slot 1 → KEY_2 (each token reused every 80s)
			const apiKey = slot % 2 === 0 ? this.env.NTA_API_KEY_1 : this.env.NTA_API_KEY_2;
			const bytes = await this.fetchNta("/Vehicles", apiKey);
			if (bytes) await this.publish(FEED_KV_VEHICLES, bytes);
		}
	}

	private async publish(key: string, bytes: Uint8Array): Promise<void> {
		await this.env.RT_FEED_KV.put(key, bytes, { expirationTtl: FEED_KV_TTL });
		console.log(`[poller] published ${key} (${bytes.length}B)`);
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
