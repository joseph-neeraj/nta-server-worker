// NTA GTFS-R v2 API mirror
// Docs: https://developer.nationaltransport.ie/api-details#api=gtfsr
// Set your API key: wrangler secret put NTA_API_KEY

import { FeedMessage } from "./generated/res/gtfs-realtime";

const NTA_BASE = "https://api.nationaltransport.ie/gtfsr/v2";
const CACHE_TTL = 65; // seconds — GTFS-RT updates every ~10-30s

// Maps our exposed paths to NTA upstream paths
const ROUTES: Record<string, string> = {
	"/gtfsr": "/gtfsr",
	"/TripUpdates": "/TripUpdates",
	"/Vehicles": "/Vehicles",
};

export default {
	async fetch(request, env, ctx): Promise<Response> {
		const { pathname, searchParams } = new URL(request.url);
		const upstreamPath = ROUTES[pathname];

		if (upstreamPath === undefined) {
			return new Response("Not Found", { status: 404 });
		}

		const accept = request.headers.get("Accept");

		// turn it onw only when debugging the app. use:
		// npx wrangler secret put ENABLE_JSON
		const jsonEnabled = env.ENABLE_JSON === "true";
		if (accept !== "application/x-protobuf" && (accept !== "application/json" || !jsonEnabled)) {
			const jsonDisabled = accept === "application/json" && !jsonEnabled;
			return new Response(jsonDisabled ? null : "Not Acceptable", { status: 406 });
		}

		const upstream = new URL(NTA_BASE + upstreamPath);
		// always fetch protobuf from NTA; JSON conversion is done here if needed
		// not needed as the GTFS API does not have any query params ( just format=json, which we're handling internally anyway)
		// searchParams.forEach((v, k) => upstream.searchParams.set(k, v));

		// Check Cloudflare cache
		const cache = caches.default;
		const cacheKey = new Request(upstream.toString(), { method: "GET" });
		const hit = await cache.match(cacheKey);
		if (hit) return hit;

		// Fetch from NTA
		const ntaRes = await fetch(upstream.toString(), {
			headers: { "x-api-key": env.NTA_API_KEY },
		});

		if (!ntaRes.ok) {
			return new Response(await ntaRes.text(), { status: ntaRes.status });
		}

		// Build cacheable response
		const headers = new Headers(ntaRes.headers);
		headers.set("Cache-Control", `public, max-age=${CACHE_TTL}`);
		headers.set("Content-Type", accept);

		let body: BodyInit;
		// json will be used only rarely when debugging the clients
		if (accept === "application/json") {
			const buf = await ntaRes.arrayBuffer();
			const feed = FeedMessage.decode(new Uint8Array(buf));
			body = JSON.stringify(FeedMessage.toJSON(feed));
		} else {
			body = ntaRes.body!;
		}

		const response = new Response(body, { status: ntaRes.status, headers });

		ctx.waitUntil(cache.put(cacheKey, response.clone()));
		return response;
	},
} satisfies ExportedHandler<Env>;
