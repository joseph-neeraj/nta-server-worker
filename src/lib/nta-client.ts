// Single point of entry for all NTA GTFS-Realtime API calls.
//
// Centralises the base URL, API key headers, and Cloudflare edge caching so
// that no other file needs to know how to talk to the NTA API.
//
// Key rotation strategy:
// NTA issues 2 API keys, each limited to one call per 60 seconds.
// Rather than round-robin (which requires shared state across CF isolates and
// PoPs — not feasible in a stateless Worker), we assign one key per endpoint:
//   NTA_API_KEY_1 → /Vehicles
//   NTA_API_KEY_2 → /TripUpdates
// With CACHE_TTL=65s each endpoint is called at most once per 65 seconds,
// so neither key ever approaches its rate limit.

import { FeedMessage } from "../generated/res/gtfs-realtime";

const NTA_BASE = "https://api.nationaltransport.ie/gtfsr/v2";

// NTA fair usage policy: 1 call per 60 seconds per token.
// 61s is the minimum safe value that respects the limit.
export const CACHE_TTL = 31;

export class NtaClient {
	constructor(private env: Env, private ctx: ExecutionContext) {}

	async fetchVehicles(): Promise<FeedMessage | null> {
		return this.fetchFeed("/Vehicles", this.env.NTA_API_KEY_1);
	}

	async fetchTripUpdates(): Promise<FeedMessage | null> {
		return this.fetchFeed("/TripUpdates", this.env.NTA_API_KEY_2);
	}

	// Fetches a GTFS-RT feed from NTA, with Cloudflare edge caching.
	// Returns null if the upstream call fails.
	private async fetchFeed(path: string, apiKey: string): Promise<FeedMessage | null> {
		const url = `${NTA_BASE}${path}`;
		const cache = caches.default;
		const cacheKey = new Request(url, { method: "GET" });

		const hit = await cache.match(cacheKey);
		if (hit) {
			const buf = await hit.arrayBuffer();
			return FeedMessage.decode(new Uint8Array(buf));
		}

		const res = await fetch(url, {
			headers: { "x-api-key": apiKey },
		});
		if (!res.ok) return null;

		// Cache the raw protobuf bytes so they survive beyond this invocation
		const bytes = new Uint8Array(await res.arrayBuffer());
		const cached = new Response(bytes, {
			headers: {
				"Content-Type": "application/x-protobuf",
				"Cache-Control": `public, max-age=${CACHE_TTL}`,
			},
		});
		this.ctx.waitUntil(cache.put(cacheKey, cached));

		return FeedMessage.decode(bytes);
	}
}
