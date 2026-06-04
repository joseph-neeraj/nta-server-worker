// NTA GTFS-R v2 API mirror
// Docs: https://developer.nationaltransport.ie/api-details#api=gtfsr
// Set your API key: wrangler secret put NTA_API_KEY

const NTA_BASE = "https://api.nationaltransport.ie/gtfsr/v2";
const CACHE_TTL = 10; // seconds — GTFS-RT updates every ~10-30s

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

		const upstream = new URL(NTA_BASE + upstreamPath);
		searchParams.forEach((v, k) => upstream.searchParams.set(k, v));

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
		const response = new Response(ntaRes.body, { status: ntaRes.status, headers });

		ctx.waitUntil(cache.put(cacheKey, response.clone()));
		return response;
	},
} satisfies ExportedHandler<Env>;
