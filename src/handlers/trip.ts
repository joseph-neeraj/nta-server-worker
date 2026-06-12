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
//   "timestamp": 1780668623,      // POSIX seconds of last vehicle progress measurement; absent if unavailable
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

import { NtaClient, tripUpdateCacheKey } from "../lib/nta-client";

const CACHE_TTL = 65; // seconds
import { TripDetails } from "../generated/res/nta";
import { gzip } from "../lib/compress";
import { buildErrorResponse } from "../lib/error-response";
import { ProtoCache } from "../lib/proto-cache";
import { StaticDb } from "../lib/static-db";

export async function handleTripFetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	const accept = request.headers.get("Accept");

	const trip_id = new URL(request.url).pathname.split("/").pop() || "";
	if (!trip_id) {
		return buildErrorResponse(400, "Missing trip_id in path", accept, "Please provide a valid trip ID in the request URL.");
	}

	const protoCache = new ProtoCache(ctx);
	const cacheKey = new Request(
		`https://nta-worker-cache/v1/live/trips/${encodeURIComponent(trip_id)}?e=${tripUpdateCacheKey()}`,
		{ method: "GET" },
	);
	const cachedProto = await protoCache.match(cacheKey);

	if (cachedProto && accept !== "application/json") return cachedProto;

	let details: TripDetails;
	let compressedProto: Uint8Array | undefined;

	if (cachedProto) {
		// JSON requested — decompress cached bytes, then decode
		const rawBytes = await protoCache.decompress(cachedProto);
		details = TripDetails.decode(rawBytes);
	} else {
		// Cache miss — fetch from D1 and NTA in parallel
		const [dbResult, delayUpdates] = await Promise.all([
			new StaticDb(env.nta_static).getTrip(trip_id),
			fetchDelayUpdates(trip_id, env, ctx),
		]);

		if (dbResult === null) {
			return buildErrorResponse(404, "Trip not found", accept, "The requested trip could not be found. It may no longer be active.");
		}
		if (dbResult === "error") {
			return buildErrorResponse(500, "Database error", accept, "Something went wrong. Please try again shortly.");
		}

		const { tripRow, stopRows, shapeRows } = dbResult;

		console.log(`[trip:${trip_id}] delayUpdates=${delayUpdates == null ? "null" : `timestamp=${delayUpdates.timestamp}, stops=${delayUpdates.stops.length}`}`);

		const delayByStopId = new Map<string, { arrivalDelay?: number; departureDelay?: number }>();
		for (const stu of delayUpdates?.stops ?? []) {
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
			...(delayUpdates?.timestamp != null ? { timestamp: delayUpdates.timestamp } : {}),
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
		// make sure the cache expires a little before the api cache, so fresh data is always available
		protoCache.put(cacheKey, compressedProto, CACHE_TTL - 2);
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

// Fetches TripUpdates and returns per-stop delay data for one trip.
// Returns null if the feed is unavailable or the trip has no entry.
async function fetchDelayUpdates(
	trip_id: string,
	env: Env,
	ctx: ExecutionContext,
): Promise<{ timestamp: number | null; stops: { stopId: string | null; arrivalDelay: number | null; departureDelay: number | null }[] } | null> {
	const feed = await new NtaClient(env, ctx).fetchTripUpdates();
	if (!feed) return null;

	const entity = feed.entity.find((e) => e.tripUpdate?.trip?.tripId === trip_id);
	if (!entity?.tripUpdate) return null;

	return {
		timestamp: entity.tripUpdate.timestamp ?? null,
		stops: entity.tripUpdate.stopTimeUpdate.map((stu) => ({
			stopId: stu.stopId ?? null,
			arrivalDelay: stu.arrival?.delay ?? null,
			departureDelay: stu.departure?.delay ?? null,
		})),
	};
}

