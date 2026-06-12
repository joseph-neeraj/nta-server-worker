// Handler for GET /v1/static/stops
//
// Returns all bus stops from the GTFS static feed.
// Freshness is controlled entirely by the static version key embedded in the
// cache URL — a new import writes a new version, making the old cache entry
// unreachable. The edge TTL is set to 1 year so CF holds entries indefinitely;
// the version key is the only expiry mechanism. Edge TTL is 20 hours.

import { StopsFeed } from "../generated/res/nta";
import { gzip } from "../lib/compress";
import { buildErrorResponse } from "../lib/error-response";
import { getStaticVersionWithFallback } from "../lib/static-version";
import { ProtoCache } from "../lib/proto-cache";
import { StaticDb } from "../lib/static-db";

export async function handleStops(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	const accept = request.headers.get("Accept");

	const version = await getStaticVersionWithFallback(env);
	const protoCache = new ProtoCache(ctx);
	const cacheKey = new Request(`https://nta-worker-cache/v1/static/stops?v=${encodeURIComponent(version)}`, { method: "GET" });
	const cachedProto = await protoCache.match(cacheKey);

	// Proto cache hit — return directly without any decode/re-encode work
	if (cachedProto && accept !== "application/json") return cachedProto;

	let feed: StopsFeed;
	let compressedProto: Uint8Array | undefined;

	if (cachedProto) {
		// JSON requested — decompress cached bytes, then decode
		const rawBytes = await protoCache.decompress(cachedProto);
		feed = StopsFeed.decode(rawBytes);
	} else {
		// Cache miss — fetch all stops from D1
		const rows = await new StaticDb(env.nta_static).getAllStops();
		if (rows === "error") {
			return buildErrorResponse(500, "Database error", accept, "Something went wrong. Please try again shortly.");
		}

		feed = {
			version,
			stops: rows.map((r) => ({
				stopId: (r.stop_id as string) ?? "",
				stopCode: (r.stop_code as string) ?? "",
				stopName: (r.stop_name as string) ?? "",
				stopDesc: (r.stop_desc as string) ?? "",
				stopLat: (r.stop_lat as number) ?? 0,
				stopLon: (r.stop_lon as number) ?? 0,
				zoneId: (r.zone_id as string) ?? "",
				stopUrl: (r.stop_url as string) ?? "",
				locationType: (r.location_type as number) ?? 0,
				parentStation: (r.parent_station as string) ?? "",
			})),
		};

		const rawBytes = StopsFeed.encode(feed).finish();
		console.log(`[stops] proto raw=${rawBytes.length}B count=${feed.stops.length}`);
		compressedProto = await gzip(rawBytes);
		console.log(`[stops] proto gzip=${compressedProto.length}B (${Math.round((1 - compressedProto.length / rawBytes.length) * 100)}% reduction)`);
		// 20 hours — version key in the URL is the only expiry mechanism
		protoCache.put(cacheKey, compressedProto, 72000);
	}

	if (accept === "application/json") {
		return new Response(JSON.stringify(StopsFeed.toJSON(feed)), {
			headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=300" },
		});
	}

	// compressedProto is always set on the cache-miss path; the fallback guards against type errors only
	const bytes = compressedProto ?? await gzip(StopsFeed.encode(feed).finish());
	return new Response(bytes, {
		headers: { "Content-Type": "application/x-protobuf", "Content-Encoding": "gzip", "Cache-Control": "public, max-age=300" },
	});
}
