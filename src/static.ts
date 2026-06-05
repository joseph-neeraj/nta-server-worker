// Vehicle details endpoint — combines static + real-time data for a vehicle in one response
import { getTripDelayUpdates } from "./gtfsr";

const REALTIME_CACHE_TTL = 65; // seconds — matches GTFS-RT feed TTL

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: {
			"Content-Type": "application/json",
			...(status === 200 ? { "Cache-Control": `public, max-age=${REALTIME_CACHE_TTL}` } : {}),
		},
	});
}

export async function handleStatic(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	if (request.method !== "GET") {
		return json({ error: "Method Not Allowed" }, 405);
	}

	const { pathname, searchParams } = new URL(request.url);

	if (pathname === "/vehicle-details") return handleVehicleDetails(searchParams, env, ctx);

	return json({ error: "Not Found" }, 404);
}

/**
 * GET /vehicle-details?trip_id=<trip_id>
 *
 * Returns all useful information about a vehicle in a single response.
 * Pass trip_id from the /Vehicles GTFS-RT feed (entity.vehicle.trip.trip_id).
 *
 * 200 OK:
 * {
 *   "trip_id": "5675_85",
 *   "trip_headsign": "Edenderry Town Hall",
 *   "trip_short_name": "...",
 *   "direction_id": 0,
 *   "block_id": "...",
 *   "shape_id": "...",
 *   "route_short_name": "120",
 *   "route_long_name": "Dublin - Edenderry",
 *   "route_type": 3,
 *   "route_color": "",
 *   "route_text_color": "",
 *   "agency_name": "Go-Ahead Ireland",
 *   "agency_url": "https://www.goaheadireland.ie/",
 *   "shape": [[53.3498, -6.249, 0.0], [53.3512, -6.2601, 120.5], ...],
 *   "stops": [
 *     {
 *       "stop_sequence": 1,
 *       "stop_id": "8340B355121",
 *       "stop_code": 355121,
 *       "stop_name": "Dublin, Busáras",
 *       "stop_lat": 53.3498,
 *       "stop_lon": -6.249,
 *       "arrival_time": "14:00:00",
 *       "departure_time": "14:00:00",
 *       "stop_headsign": null,
 *       "pickup_type": 0,
 *       "drop_off_type": 1,
 *       "timepoint": 1,
 *       "arrival_delay": 120,
 *       "departure_delay": 120
 *     }
 *   ]
 * }
 *
 * shape: compact [lat, lon, dist_meters] triples for the route polyline.
 * arrival_delay / departure_delay: seconds (positive = late), null if no real-time data
 * for that stop. Only stops not yet served will have delay data — NTA omits past stops.
 */
async function handleVehicleDetails(params: URLSearchParams, env: Env, ctx: ExecutionContext): Promise<Response> {
	const trip_id = params.get("trip_id");
	if (!trip_id) return json({ error: "Missing required parameter: trip_id" }, 400);

	let tripRow: Record<string, unknown> | null;
	let stopRows: Record<string, unknown>[];
	let shapeRows: { shape_pt_lat: number; shape_pt_lon: number; shape_dist_traveled: number | null }[];

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
					 WHERE t.trip_id = ?`
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
					 ORDER BY st.stop_sequence`
				)
				.bind(trip_id),
			env.nta_static
				.prepare(
					`SELECT sh.shape_pt_lat, sh.shape_pt_lon, sh.shape_dist_traveled
					 FROM trips t
					 JOIN shapes sh ON t.shape_id = sh.shape_id
					 WHERE t.trip_id = ?
					 ORDER BY sh.shape_pt_sequence`
				)
				.bind(trip_id),
		]);

		tripRow = (tripResult.results[0] as Record<string, unknown>) ?? null;
		stopRows = stopsResult.results as Record<string, unknown>[];
		shapeRows = shapeResult.results as {
			shape_pt_lat: number;
			shape_pt_lon: number;
			shape_dist_traveled: number | null;
		}[];
	} catch {
		return json({ error: "Database error" }, 500);
	}

	if (!tripRow) return json({ error: "Trip not found" }, 404);

	// Fetch real-time delays — best-effort, null if trip not in feed (completed or not yet started)
	const delayUpdates = await getTripDelayUpdates(trip_id, env, ctx);
	const delayByStopId = new Map<string, { arrival_delay: number | null; departure_delay: number | null }>();
	for (const stu of delayUpdates ?? []) {
		if (stu.stop_id) {
			delayByStopId.set(stu.stop_id, { arrival_delay: stu.arrival_delay, departure_delay: stu.departure_delay });
		}
	}

	const stops = stopRows.map((s) => {
		const d = delayByStopId.get(s.stop_id as string);
		return { ...s, arrival_delay: d?.arrival_delay ?? null, departure_delay: d?.departure_delay ?? null };
	});

	const shape = shapeRows.map((r) => [r.shape_pt_lat, r.shape_pt_lon, r.shape_dist_traveled ?? 0]);

	return json({ ...tripRow, shape, stops });
}
