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

import { NtaClient } from "../lib/nta-client";
import { StopSchedule } from "../generated/res/nta";
import { gzip, gunzip } from "../lib/compress";
import { buildErrorResponse } from "../lib/error-response";

const CACHE_TTL = 120; // 2 minutes — schedule can change in real time

export async function handleStopSchedule(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	if (request.method !== "GET") {
		return buildErrorResponse(405, "Method Not Allowed", null, "Only GET requests are supported on this endpoint.");
	}

	const accept = request.headers.get("Accept");
	const jsonEnabled = env.ENABLE_JSON === "true";

	if (accept !== "application/x-protobuf" && (accept !== "application/json" || !jsonEnabled)) {
		return buildErrorResponse(406, "Not Acceptable", null, "This endpoint only supports application/x-protobuf or application/json.");
	}

	const stop_id = new URL(request.url).pathname.split("/").pop() || "";
	if (!stop_id) {
		return buildErrorResponse(400, "Missing stop_id in path", accept, "Please provide a valid stop ID in the request URL.");
	}

	const cache = caches.default;
	const cacheKey = new Request(
		`https://nta-worker-cache/v1/live/stops/${encodeURIComponent(stop_id)}`,
		{ method: "GET" },
	);
	const cachedProto = await cache.match(cacheKey);

	if (cachedProto && accept !== "application/json") return cachedProto;

	let schedule: StopSchedule;
	let compressedProto: Uint8Array | undefined;

	if (cachedProto) {
		// JSON requested — decompress cached bytes, then decode
		const rawBytes = await gunzip(new Uint8Array(await cachedProto.arrayBuffer()));
		schedule = StopSchedule.decode(rawBytes);
	} else {
		// Cache miss — fetch static schedule and live delays in parallel
		const [dbResult, feed] = await Promise.all([
			fetchFromDb(stop_id, env),
			new NtaClient(env, ctx).fetchTripUpdates(),
		]);

		if (dbResult === null) {
			return buildErrorResponse(404, "Stop not found", accept, "The requested stop could not be found.");
		}
		if (dbResult === "error") {
			return buildErrorResponse(500, "Database error", accept, "Something went wrong. Please try again shortly.");
		}

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
				...delayByTripId.get(r.trip_id as string),
			})),
		};

		const rawBytes = StopSchedule.encode(schedule).finish();
		console.log(`[stop:${stop_id}] proto raw=${rawBytes.length}B arrivals=${schedule.arrivals.length}`);
		compressedProto = await gzip(rawBytes);
		console.log(`[stop:${stop_id}] proto gzip=${compressedProto.length}B (${Math.round((1 - compressedProto.length / rawBytes.length) * 100)}% reduction)`);

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
		return new Response(JSON.stringify(StopSchedule.toJSON(schedule)), {
			headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${CACHE_TTL}` },
		});
	}

	// compressedProto is always set on the cache-miss path; the fallback guards against type errors only
	const bytes = compressedProto ?? await gzip(StopSchedule.encode(schedule).finish());
	return new Response(bytes, {
		headers: { "Content-Type": "application/x-protobuf", "Content-Encoding": "gzip", "Cache-Control": `public, max-age=${CACHE_TTL}` },
	});
}

// ─── helpers ─────────────────────────────────────────────────────────────────

type DbResult = {
	stopRow: Record<string, unknown>;
	arrivalRows: Record<string, unknown>[];
};

async function fetchFromDb(stop_id: string, env: Env): Promise<DbResult | null | "error"> {
	// Derive today's date components for the service-active filter.
	// All comparisons are against GTFS date strings (YYYYMMDD) and the day-of-week
	// column name — both computed here from the server clock, not from user input.
	const now = new Date();
	const todayStr = now.toISOString().slice(0, 10).replace(/-/g, ""); // "YYYYMMDD"
	const dayCol = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"][now.getUTCDay()];

	try {
		const [stopResult, arrivalsResult] = await env.nta_static.batch([
			// Query 1: look up the stop itself so we can 404 if it doesn't exist
			env.nta_static
				.prepare(`SELECT stop_id, stop_name, stop_lat, stop_lon FROM stops WHERE stop_id = ?`)
				.bind(stop_id),

			// Query 2: all scheduled arrivals at this stop for today's active services,
			// ordered by scheduled arrival time.
			//
			// "Active services" is a three-part calculation:
			//
			//   calendar          — defines the regular weekly pattern for a service_id.
			//                       e.g. service_id=4 runs Mon–Fri between two dates.
			//                       A service is active today if today falls within its
			//                       start_date/end_date range AND the day-of-week column = 1.
			//
			//   calendar_dates    — per-date exceptions that override the regular pattern:
			//     exception_type=1  (ADDED)   — service runs today even if calendar says it shouldn't
			//                                   (e.g. a bank holiday special service)
			//     exception_type=2  (REMOVED) — service does NOT run today even if calendar says it should
			//                                   (e.g. Christmas Day cancellation)
			//
			// The UNION / EXCEPT pattern below implements the GTFS spec correctly:
			//   base set  = calendar services active on today's weekday within their date range
			//   add       = ADDED exceptions for today
			//   subtract  = REMOVED exceptions for today
			env.nta_static
				.prepare(
					`SELECT st.trip_id, st.stop_sequence, st.arrival_time, st.departure_time,
					        r.route_short_name, t.trip_headsign, t.direction_id
					 FROM stop_times st
					 JOIN trips t   ON st.trip_id  = t.trip_id
					 JOIN routes r  ON t.route_id  = r.route_id
					 WHERE st.stop_id = ?
					   AND t.service_id IN (
					     -- Regular weekly services active today
					     SELECT service_id FROM calendar
					       WHERE ${dayCol} = 1
					         AND start_date <= ?
					         AND end_date   >= ?
					     -- Plus any one-off additions for today (e.g. bank holiday extras)
					     UNION
					     SELECT service_id FROM calendar_dates
					       WHERE date = ? AND exception_type = 1
					     -- Minus any cancellations for today (e.g. Christmas Day)
					     EXCEPT
					     SELECT service_id FROM calendar_dates
					       WHERE date = ? AND exception_type = 2
					   )
					 ORDER BY st.arrival_time`,
				)
				.bind(stop_id, todayStr, todayStr, todayStr, todayStr),
		]);

		const stopRow = (stopResult.results[0] as Record<string, unknown>) ?? null;
		if (!stopRow) return null;

		return {
			stopRow,
			arrivalRows: arrivalsResult.results as Record<string, unknown>[],
		};
	} catch {
		return "error";
	}
}
