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

export const gtfsrPaths = new Set(Object.keys(ROUTES));

export async function handleGtfsr(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	const { pathname } = new URL(request.url);

	const upstreamPath = ROUTES[pathname];

	const accept = request.headers.get("Accept");

	// turn it on only when debugging the app. use:
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
}

export type StopDelayUpdate = {
	stop_sequence: number | null;
	stop_id: string | null;
	arrival_delay: number | null;
	departure_delay: number | null;
};

/**
 * Returns per-stop delay updates for a trip from the live TripUpdates feed.
 * Returns null if the upstream call fails or the trip has no TripUpdate entity.
 */
export async function getTripDelayUpdates(
	trip_id: string,
	env: Env,
	ctx: ExecutionContext
): Promise<StopDelayUpdate[] | null> {
	const syntheticReq = new Request("https://worker/TripUpdates", {
		headers: { Accept: "application/x-protobuf" },
	});
	const upstreamRes = await handleGtfsr(syntheticReq, env, ctx);
	if (!upstreamRes.ok) return null;

	const bytes = new Uint8Array(await upstreamRes.arrayBuffer());
	const feed = FeedMessage.decode(bytes);
	const entity = feed.entity.find((e) => e.tripUpdate?.trip?.tripId === trip_id);
	if (!entity?.tripUpdate) return null;

	return entity.tripUpdate.stopTimeUpdate.map((stu) => ({
		stop_sequence: stu.stopSequence ?? null,
		stop_id: stu.stopId ?? null,
		arrival_delay: stu.arrival?.delay ?? null,
		departure_delay: stu.departure?.delay ?? null,
	}));
}
