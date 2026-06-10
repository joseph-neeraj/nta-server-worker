// Handler for GET /v1/live/trips/{trip_id}
//
// Returns full trip information in a single response: static GTFS data
// (route, stops, shape polyline) plus real-time stop delay data from the
// NTA TripUpdates feed.
//
// Proto bytes are cached on the CF edge per trip_id for 65 seconds.
// JSON is derived on the fly from the cached proto via toJSON.
//
// Response shape (JSON):
// {
//   "tripId": "5675_85",
//   "tripHeadsign": "Edenderry Town Hall",
//   "routeShortName": "120",
//   "routeLongName": "Dublin - Edenderry",
//   "routeType": 3,
//   "agencyName": "Go-Ahead Ireland",
//   "shape": [{ "lat": 53.3498, "lon": -6.249, "distTraveled": 0 }, ...],
//   "stops": [
//     {
//       "stopSequence": 1,
//       "stopId": "8340B355121",
//       "stopName": "Dublin, Busáras",
//       "arrivalTime": "14:00:00",
//       "arrivalDelay": 120,    // seconds late; absent if no live data
//       "departureDelay": 120,
//       ...
//     }
//   ]
// }

import { NtaClient, CACHE_TTL } from "../lib/nta-client";
import { TripDetails } from "../generated/res/nta";
import { gzip, gunzip } from "../lib/compress";

export async function handleTripFetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	if (request.method !== "GET") {
		return new Response(JSON.stringify({ error: "Method Not Allowed" }), {
			status: 405,
			headers: { "Content-Type": "application/json" },
		});
	}

	const accept = request.headers.get("Accept");
	const jsonEnabled = env.ENABLE_JSON === "true";

	if (accept !== "application/x-protobuf" && (accept !== "application/json" || !jsonEnabled)) {
		return new Response(accept === "application/json" ? null : "Not Acceptable", { status: 406 });
	}

	const trip_id = new URL(request.url).pathname.split("/").pop() || "";
	if (!trip_id) {
		return new Response(JSON.stringify({ error: "Missing trip_id in path" }), {
			status: 400,
			headers: { "Content-Type": "application/json" },
		});
	}

	const cache = caches.default;
	const cacheKey = new Request(
		`https://nta-worker-cache/v1/live/trips/${encodeURIComponent(trip_id)}`,
		{ method: "GET" },
	);
	const cachedProto = await cache.match(cacheKey);

	if (cachedProto && accept !== "application/json") return cachedProto;

	let details: TripDetails;
	let compressedProto: Uint8Array | undefined;

	if (cachedProto) {
		// JSON requested — decompress cached bytes, then decode
		const rawBytes = await gunzip(new Uint8Array(await cachedProto.arrayBuffer()));
		details = TripDetails.decode(rawBytes);
	} else {
		// Cache miss — fetch from D1 and NTA in parallel
		const [dbResult, delayUpdates] = await Promise.all([
			fetchFromDb(trip_id, env),
			fetchDelayUpdates(trip_id, env, ctx),
		]);

		if (dbResult === null) {
			return new Response(JSON.stringify({ error: "Trip not found" }), {
				status: 404,
				headers: { "Content-Type": "application/json" },
			});
		}
		if (dbResult === "error") {
			return new Response(JSON.stringify({ error: "Database error" }), {
				status: 500,
				headers: { "Content-Type": "application/json" },
			});
		}

		const { tripRow, stopRows, shapeRows } = dbResult;

		const delayByStopId = new Map<string, { arrivalDelay?: number; departureDelay?: number }>();
		for (const stu of delayUpdates ?? []) {
			if (stu.stopId) {
				delayByStopId.set(stu.stopId, {
					...(stu.arrivalDelay != null ? { arrivalDelay: stu.arrivalDelay } : {}),
					...(stu.departureDelay != null ? { departureDelay: stu.departureDelay } : {}),
				});
			}
		}

		details = {
			tripId: tripRow.trip_id as string,
			tripHeadsign: (tripRow.trip_headsign as string) ?? "",
			tripShortName: (tripRow.trip_short_name as string) ?? "",
			directionId: (tripRow.direction_id as number) ?? 0,
			blockId: (tripRow.block_id as string) ?? "",
			shapeId: (tripRow.shape_id as string) ?? "",
			routeShortName: (tripRow.route_short_name as string) ?? "",
			routeLongName: (tripRow.route_long_name as string) ?? "",
			routeType: (tripRow.route_type as number) ?? 0,
			routeColor: (tripRow.route_color as string) ?? "",
			routeTextColor: (tripRow.route_text_color as string) ?? "",
			agencyName: (tripRow.agency_name as string) ?? "",
			agencyUrl: (tripRow.agency_url as string) ?? "",
			shape: shapeRows.map((r) => ({
				lat: r.shape_pt_lat,
				lon: r.shape_pt_lon,
				distTraveled: r.shape_dist_traveled ?? 0,
			})),
			stops: stopRows.map((s) => ({
				stopSequence: (s.stop_sequence as number) ?? 0,
				stopId: (s.stop_id as string) ?? "",
				stopCode: (s.stop_code as string) ?? "",
				stopName: (s.stop_name as string) ?? "",
				stopLat: (s.stop_lat as number) ?? 0,
				stopLon: (s.stop_lon as number) ?? 0,
				arrivalTime: (s.arrival_time as string) ?? "",
				departureTime: (s.departure_time as string) ?? "",
				stopHeadsign: (s.stop_headsign as string) ?? "",
				pickupType: (s.pickup_type as number) ?? 0,
				dropOffType: (s.drop_off_type as number) ?? 0,
				timepoint: (s.timepoint as number) ?? 0,
				...delayByStopId.get(s.stop_id as string),
			})),
		};

		// Encode, compress, log sizes, then cache the compressed bytes
		const rawBytes = TripDetails.encode(details).finish();
		console.log(`[trip:${trip_id}] proto raw=${rawBytes.length}B`);
		compressedProto = await gzip(rawBytes);
		console.log(`[trip:${trip_id}] proto gzip=${compressedProto.length}B (${Math.round((1 - compressedProto.length / rawBytes.length) * 100)}% reduction)`);
		ctx.waitUntil(
			cache.put(
				cacheKey,
				new Response(compressedProto, {
					headers: {
						"Content-Type": "application/x-protobuf",
						"Content-Encoding": "gzip",
						// make sure the cache expires a little before the api cache, so fresh data is always available
						"Cache-Control": `public, max-age=${CACHE_TTL - 2}`,
					},
				}),
			),
		);
	}

	if (accept === "application/json") {
		return new Response(JSON.stringify(TripDetails.toJSON(details)), {
			headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${CACHE_TTL}` },
		});
	}

	// compressedProto is always set on the cache-miss path; the fallback guards against type errors only
	const bytes = compressedProto ?? await gzip(TripDetails.encode(details).finish());
	return new Response(bytes, {
		headers: { "Content-Type": "application/x-protobuf", "Content-Encoding": "gzip", "Cache-Control": `public, max-age=${CACHE_TTL}` },
	});
}

// ─── helpers ─────────────────────────────────────────────────────────────────

type DbResult = {
	tripRow: Record<string, unknown>;
	stopRows: Record<string, unknown>[];
	shapeRows: { shape_pt_lat: number; shape_pt_lon: number; shape_dist_traveled: number | null }[];
};

async function fetchFromDb(trip_id: string, env: Env): Promise<DbResult | null | "error"> {
	try {
		const [tripResult, stopsResult, shapeResult] = await env.nta_static.batch([
			env.nta_static
				.prepare(
					`SELECT t.trip_id, t.trip_headsign, t.trip_short_name, t.direction_id, t.block_id, t.shape_id,
					        r.route_short_name, r.route_long_name, r.route_type, r.route_color, r.route_text_color,
					        a.agency_name, a.agency_url
					 FROM trips t
					 JOIN routes r ON t.route_id = r.route_id
					 JOIN agency a ON r.agency_id = a.agency_id
					 WHERE t.trip_id = ?`,
				)
				.bind(trip_id),
			env.nta_static
				.prepare(
					`SELECT st.stop_sequence, st.stop_id, s.stop_code, s.stop_name,
					        s.stop_lat, s.stop_lon,
					        st.arrival_time, st.departure_time, st.stop_headsign,
					        st.pickup_type, st.drop_off_type, st.timepoint
					 FROM stop_times st
					 JOIN stops s ON st.stop_id = s.stop_id
					 WHERE st.trip_id = ?
					 ORDER BY st.stop_sequence`,
				)
				.bind(trip_id),
			env.nta_static
				.prepare(
					`SELECT sh.shape_pt_lat, sh.shape_pt_lon, sh.shape_dist_traveled
					 FROM trips t
					 JOIN shapes sh ON t.shape_id = sh.shape_id
					 WHERE t.trip_id = ?
					 ORDER BY sh.shape_pt_sequence`,
				)
				.bind(trip_id),
		]);

		const tripRow = (tripResult.results[0] as Record<string, unknown>) ?? null;
		if (!tripRow) return null;

		return {
			tripRow,
			stopRows: stopsResult.results as Record<string, unknown>[],
			shapeRows: shapeResult.results as DbResult["shapeRows"],
		};
	} catch {
		return "error";
	}
}

// Fetches TripUpdates and returns per-stop delay data for one trip.
// Returns null if the feed is unavailable or the trip has no entry.
async function fetchDelayUpdates(
	trip_id: string,
	env: Env,
	ctx: ExecutionContext,
): Promise<{ stopId: string | null; arrivalDelay: number | null; departureDelay: number | null }[] | null> {
	const feed = await new NtaClient(env, ctx).fetchTripUpdates();
	if (!feed) return null;

	const entity = feed.entity.find((e) => e.tripUpdate?.trip?.tripId === trip_id);
	if (!entity?.tripUpdate) return null;

	return entity.tripUpdate.stopTimeUpdate.map((stu) => ({
		stopId: stu.stopId ?? null,
		arrivalDelay: stu.arrival?.delay ?? null,
		departureDelay: stu.departure?.delay ?? null,
	}));
}

