// Handler for GET /v1/live/vehicles
//
// Returns an enriched vehicle feed: all active vehicles with their real-time
// positions plus route_short_name and trip_headsign from the static GTFS data.
// The enriched response is cached on the CF edge for 65 seconds (matching the
// NTA feed cadence), so the D1 join only runs on cache misses.

import { NtaClient, CACHE_TTL } from "../lib/nta-client";
import { VehiclesFeed } from "../generated/res/nta";
import { gzip, gunzip } from "../lib/compress";

type TripRow = { trip_id: string; trip_headsign: string | null; route_short_name: string | null; agency_id: string | null; agency_name: string | null };

export async function handleVehicles(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	const accept = request.headers.get("Accept");
	const jsonEnabled = env.ENABLE_JSON === "true";

	if (accept !== "application/x-protobuf" && (accept !== "application/json" || !jsonEnabled)) {
		return new Response(accept === "application/json" ? null : "Not Acceptable", { status: 406 });
	}

	// Always cache proto bytes — one cache entry regardless of the requested format.
	// JSON is cheap to derive on the fly from the decoded proto.
	const cache = caches.default;
	const cacheKey = new Request("https://nta-worker-cache/v1/live/vehicles/enriched", { method: "GET" });
	const cachedProto = await cache.match(cacheKey);

	// Proto cache hit — return directly without any decode/re-encode work
	if (cachedProto && accept !== "application/json") return cachedProto;

	let enriched: VehiclesFeed;
	let compressedProto: Uint8Array | undefined;

	if (cachedProto) {
		// JSON requested — decompress cached bytes, then decode
		const rawBytes = await gunzip(new Uint8Array(await cachedProto.arrayBuffer()));
		enriched = VehiclesFeed.decode(rawBytes);
	} else {
		// Cache miss — fetch from NTA and enrich with D1 static data
		const feed = await new NtaClient(env, ctx).fetchVehicles();
		if (!feed) return new Response("Upstream error", { status: 502 });

		// Collect all trip_ids so we can fetch enrichment data in a single D1 query
		const tripIds = feed.entity
			.map((e) => e.vehicle?.trip?.tripId)
			.filter((id): id is string => Boolean(id));

		const lookup = new Map<string, TripRow>();
		if (tripIds.length > 0) {
			// D1 caps bound parameters at 100 per query — chunk and batch
			const chunks: string[][] = [];
			for (let i = 0; i < tripIds.length; i += 100) chunks.push(tripIds.slice(i, i + 100));

			const batchResults = await env.nta_static.batch<TripRow>(
				chunks.map((chunk) => {
					const placeholders = chunk.map(() => "?").join(",");
					return env.nta_static
						.prepare(
							`SELECT t.trip_id, t.trip_headsign, r.route_short_name, r.agency_id, a.agency_name
							 FROM trips t
							 JOIN routes r ON t.route_id = r.route_id
							 JOIN agency a ON r.agency_id = a.agency_id
							 WHERE t.trip_id IN (${placeholders})`,
						)
						.bind(...chunk);
				}),
			);
			for (const { results } of batchResults) {
				for (const row of results) lookup.set(row.trip_id, row);
			}
		}

		enriched = {
			timestamp: feed.header?.timestamp ?? 0,
			entity: feed.entity
				.filter((e) => e.vehicle != null)
				.map((e) => {
					const v = e.vehicle!;
					const tripId = v.trip?.tripId ?? "";
					const row = lookup.get(tripId);
					return {
						id: e.id,
						tripId,
						routeId: v.trip?.routeId ?? "",
						directionId: v.trip?.directionId ?? 0,
						latitude: v.position?.latitude ?? 0,
						longitude: v.position?.longitude ?? 0,
						bearing: v.position?.bearing ?? 0,
						timestamp: v.timestamp ?? 0,
						vehicleId: v.vehicle?.id ?? "",
						routeShortName: row?.route_short_name ?? "",
						tripHeadsign: row?.trip_headsign ?? "",
						agencyId: row?.agency_id ?? "",
						agencyName: row?.agency_name ?? "",
					};
				}),
		};

		// Encode, compress, log sizes, then cache the compressed bytes
		const rawBytes = VehiclesFeed.encode(enriched).finish();
		console.log(`[vehicles] proto raw=${rawBytes.length}B`);
		compressedProto = await gzip(rawBytes);
		console.log(`[vehicles] proto gzip=${compressedProto.length}B (${Math.round((1 - compressedProto.length / rawBytes.length) * 100)}% reduction)`);
		ctx.waitUntil(
			cache.put(
				cacheKey,
				new Response(compressedProto, {
					headers: {
						"Content-Type": "application/x-protobuf",
						"Content-Encoding": "gzip",
						"Cache-Control": `public, max-age=${CACHE_TTL}`,
					},
				}),
			),
		);
	}

	if (accept === "application/json") {
		return new Response(JSON.stringify(VehiclesFeed.toJSON(enriched)), {
			headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${CACHE_TTL}` },
		});
	}

	// compressedProto is always set on the cache-miss path; the fallback guards against type errors only
	const bytes = compressedProto ?? await gzip(VehiclesFeed.encode(enriched).finish());
	return new Response(bytes, {
		headers: { "Content-Type": "application/x-protobuf", "Content-Encoding": "gzip", "Cache-Control": `public, max-age=${CACHE_TTL}` },
	});
}

