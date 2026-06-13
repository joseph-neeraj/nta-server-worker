// Handler for GET /v1/live/stops/{stop_id}
//
// Returns today's scheduled arrivals at a single stop, enriched with
// real-time delay data from the NTA TripUpdates feed.
//
// Response shape (JSON):
// {
//   "stopId": "8250DB000017",
//   "stopName": "Heuston Station",
//   "stopLat": 53.3461,
//   "stopLon": -6.2935,
//   "realtimeTimestamp": 1780668623,  // POSIX seconds of TripUpdates feed; absent if unavailable
//   "arrivals": [
//     {
//       "tripId": "5675_85",
//       "routeShortName": "120",
//       "tripHeadsign": "Edenderry Town Hall",
//       "directionId": 0,
//       "stopSequence": 1,
//       "scheduledArrival": "14:00:00",
//       "scheduledDeparture": "14:00:00",
//       "arrivalDelay": 120,    // seconds late; absent if no live data
//       "departureDelay": 120,
//     }
//   ]
// }

import { NtaClient, tripUpdateCacheKey } from "../lib/nta-client";
import { StopSchedule } from "../generated/res/nta";
import { gzip } from "../lib/compress";
import { buildErrorResponse } from "../lib/error-response";
import { ProtoCache, feedHeaders, readNextUpdateAt, readLastUpdateAt, cacheMaxAge } from "../lib/proto-cache";
import { StaticDb } from "../lib/static-db";

const CACHE_TTL = 120; // 2 minutes — schedule can change in real time

export async function handleStopSchedule(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	const accept = request.headers.get("Accept");

	const stop_id = new URL(request.url).pathname.split("/").pop() || "";
	if (!stop_id) {
		return buildErrorResponse(400, "Missing stop_id in path", accept, "Please provide a valid stop ID in the request URL.");
	}

	const protoCache = new ProtoCache(ctx);
	// Key rotates with the TripUpdates epoch (same cadence as the live delay feed),
	// so a client polling at nextUpdateAt hits a new key → cache miss → fresh delays,
	// instead of a stale flat-key hit that would also serve an already-elapsed header.
	const cacheKey = new Request(
		`https://nta-worker-cache/v1/live/stops/${encodeURIComponent(stop_id)}?e=${tripUpdateCacheKey()}`,
		{ method: "GET" },
	);
	const cachedProto = await protoCache.match(cacheKey);

	if (cachedProto && accept !== "application/json") return cachedProto;

	let schedule: StopSchedule;
	let compressedProto: Uint8Array | undefined;
	// Epoch-ms instants advertised via X-Next-Update-At / X-Last-Update-At.
	let nextUpdateAt: number | null = null;
	let lastUpdateAt: number | null = null;

	if (cachedProto) {
		// JSON requested — decompress cached bytes, then decode
		const rawBytes = await protoCache.decompress(cachedProto);
		schedule = StopSchedule.decode(rawBytes);
		nextUpdateAt = readNextUpdateAt(cachedProto);
		lastUpdateAt = readLastUpdateAt(cachedProto);
	} else {
		// Cache miss — fetch static schedule and live delays in parallel
		const [dbResult, feedResult] = await Promise.all([
			new StaticDb(env.nta_static).getStopWithArrivals(stop_id),
			new NtaClient(env).fetchTripUpdates(),
		]);

		if (dbResult === null) {
			return buildErrorResponse(404, "Stop not found", accept, "The requested stop could not be found.");
		}
		if (dbResult === "error") {
			return buildErrorResponse(500, "Database error", accept, "Something went wrong. Please try again shortly.");
		}

		const feed = feedResult?.feed;
		nextUpdateAt = feedResult?.metadata?.nextUpdateAt ?? null;
		lastUpdateAt = feedResult?.metadata?.lastUpdateAt ?? null;
		const { stopRow, arrivalRows } = dbResult;

		// Build a lookup of trip_id → delay data from the TripUpdates feed.
		// The feed contains stop-level updates; we only care about the entry
		// matching our stop_id within each trip.
		const delayByTripId = new Map<string, { arrivalDelay?: number; departureDelay?: number }>();
		if (feed) {
			for (const entity of feed.entity) {
				const tu = entity.tripUpdate;
				if (!tu?.trip?.tripId) continue;
				const stu = tu.stopTimeUpdate.find((u) => u.stopId === stop_id);
				if (!stu) continue;
				delayByTripId.set(tu.trip.tripId, {
					...(stu.arrival?.delay != null ? { arrivalDelay: stu.arrival.delay } : {}),
					...(stu.departure?.delay != null ? { departureDelay: stu.departure.delay } : {}),
				});
			}
		}

		schedule = {
			stopId: stopRow.stop_id as string,
			stopCode: (stopRow.stop_code as string) ?? "",
			stopName: stopRow.stop_name as string,
			stopLat: stopRow.stop_lat as number,
			stopLon: stopRow.stop_lon as number,
			...(feed?.header?.timestamp != null ? { realtimeTimestamp: feed.header.timestamp } : {}),
			arrivals: arrivalRows.map((r) => ({
				tripId: r.trip_id as string,
				routeShortName: (r.route_short_name as string) ?? "",
				tripHeadsign: (r.trip_headsign as string) ?? "",
				directionId: (r.direction_id as number) ?? 0,
				stopSequence: r.stop_sequence as number,
				scheduledArrival: (r.arrival_time as string) ?? "",
				scheduledDeparture: (r.departure_time as string) ?? "",
				agencyId: (r.agency_id as string) ?? "",
				...(r.arrival_utc != null ? { scheduledArrivalUtc: r.arrival_utc as number } : {}),
				...(r.departure_utc != null ? { scheduledDepartureUtc: r.departure_utc as number } : {}),
				...delayByTripId.get(r.trip_id as string),
			})),
		};

		const rawBytes = StopSchedule.encode(schedule).finish();
		console.log(`[stop:${stop_id}] proto raw=${rawBytes.length}B arrivals=${schedule.arrivals.length}`);
		compressedProto = await gzip(rawBytes);
		console.log(`[stop:${stop_id}] proto gzip=${compressedProto.length}B (${Math.round((1 - compressedProto.length / rawBytes.length) * 100)}% reduction)`);
		protoCache.put(cacheKey, compressedProto, cacheMaxAge(nextUpdateAt, CACHE_TTL), nextUpdateAt, lastUpdateAt);
	}

	// Align HTTP freshness with the advertised next refresh (fixed TTL only on cold start).
	const maxAge = cacheMaxAge(nextUpdateAt, CACHE_TTL);

	if (accept === "application/json") {
		return new Response(JSON.stringify(StopSchedule.toJSON(schedule)), {
			headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${maxAge}`, ...feedHeaders(nextUpdateAt, lastUpdateAt) },
		});
	}

	// compressedProto is always set on the cache-miss path; the fallback guards against type errors only
	const bytes = compressedProto ?? await gzip(StopSchedule.encode(schedule).finish());
	return new Response(bytes, {
		headers: { "Content-Type": "application/x-protobuf", "Content-Encoding": "gzip", "Cache-Control": `public, max-age=${maxAge}`, ...feedHeaders(nextUpdateAt, lastUpdateAt) },
	});
}
