// Single point of entry for all D1 static GTFS database queries.
//
// Groups the four query categories used across handlers:
//   getAllStops          — /v1/static/stops
//   getStopWithArrivals — /v1/live/stops/:stop_id
//   getTrip             — /v1/live/trips/:trip_id
//   enrichTrips         — /v1/live/vehicles

/** Shape point row from the shapes table. */
type ShapeRow = { shape_pt_lat: number; shape_pt_lon: number; shape_dist_traveled: number | null };

/** Trip enrichment row: route + agency metadata joined onto a trip. */
export type TripEnrichmentRow = {
	trip_id: string;
	trip_headsign: string | null;
	route_short_name: string | null;
	agency_id: string | null;
	agency_name: string | null;
};

export class StaticDb {
	constructor(private db: D1Database) {}

	/** Returns all stops ordered by stop_id. "error" on D1 failure. */
	async getAllStops(): Promise<Record<string, unknown>[] | "error"> {
		try {
			const result = await this.db
				.prepare(
					`SELECT stop_id, stop_code, stop_name, stop_desc,
					        stop_lat, stop_lon, zone_id, stop_url,
					        location_type, parent_station
					 FROM stops
					 ORDER BY stop_id`,
				)
				.all();
			return result.results as Record<string, unknown>[];
		} catch {
			return "error";
		}
	}

	/**
	 * Returns a stop's metadata and today's scheduled arrivals.
	 * null  — stop not found
	 * "error" — D1 failure
	 *
	 * "Active services" follows the GTFS spec:
	 *   base set  = calendar services active on today's weekday within their date range
	 *   add       = exception_type=1 (ADDED) entries for today
	 *   subtract  = exception_type=2 (REMOVED) entries for today
	 */
	async getStopWithArrivals(
		stopId: string,
	): Promise<{ stopRow: Record<string, unknown>; arrivalRows: Record<string, unknown>[] } | null | "error"> {
		const now = new Date();
		const todayStr = now.toISOString().slice(0, 10).replace(/-/g, ""); // "YYYYMMDD"
		// dayCol comes from a fixed array — safe to interpolate directly into SQL
		const dayCol = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"][now.getUTCDay()];

		try {
			const [stopResult, arrivalsResult] = await this.db.batch([
				// Query 1: look up the stop itself so we can 404 if it doesn't exist
				this.db
					.prepare(`SELECT stop_id, stop_code, stop_name, stop_lat, stop_lon FROM stops WHERE stop_id = ?`)
					.bind(stopId),

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
				this.db
					.prepare(
						`SELECT st.trip_id, st.stop_sequence, st.arrival_time, st.departure_time,
						        r.route_short_name, r.agency_id, t.trip_headsign, t.direction_id
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
					.bind(stopId, todayStr, todayStr, todayStr, todayStr),
			]);

			const stopRow = (stopResult.results[0] as Record<string, unknown>) ?? null;
			if (!stopRow) return null;

			return { stopRow, arrivalRows: arrivalsResult.results as Record<string, unknown>[] };
		} catch {
			return "error";
		}
	}

	/**
	 * Returns full trip details: metadata, ordered stop times, and shape points.
	 * null  — trip not found
	 * "error" — D1 failure
	 */
	async getTrip(
		tripId: string,
	): Promise<{ tripRow: Record<string, unknown>; stopRows: Record<string, unknown>[]; shapeRows: ShapeRow[] } | null | "error"> {
		try {
			const [tripResult, stopsResult, shapeResult] = await this.db.batch([
				this.db
					.prepare(
						`SELECT t.trip_id, t.trip_headsign, t.trip_short_name, t.direction_id, t.block_id, t.shape_id,
						        r.route_short_name, r.route_long_name, r.route_type, r.route_color, r.route_text_color,
						        a.agency_name, a.agency_url
						 FROM trips t
						 JOIN routes r ON t.route_id = r.route_id
						 JOIN agency a ON r.agency_id = a.agency_id
						 WHERE t.trip_id = ?`,
					)
					.bind(tripId),
				this.db
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
					.bind(tripId),
				this.db
					.prepare(
						`SELECT sh.shape_pt_lat, sh.shape_pt_lon, sh.shape_dist_traveled
						 FROM trips t
						 JOIN shapes sh ON t.shape_id = sh.shape_id
						 WHERE t.trip_id = ?
						 ORDER BY sh.shape_pt_sequence`,
					)
					.bind(tripId),
			]);

			const tripRow = (tripResult.results[0] as Record<string, unknown>) ?? null;
			if (!tripRow) return null;

			return {
				tripRow,
				stopRows: stopsResult.results as Record<string, unknown>[],
				shapeRows: shapeResult.results as ShapeRow[],
			};
		} catch {
			return "error";
		}
	}

	/**
	 * Fetches route + agency enrichment data for a list of trip IDs.
	 * D1 caps bound parameters at 100 per query — queries are chunked and batched automatically.
	 * Returns an empty Map if tripIds is empty.
	 */
	async enrichTrips(tripIds: string[]): Promise<Map<string, TripEnrichmentRow>> {
		const lookup = new Map<string, TripEnrichmentRow>();
		if (tripIds.length === 0) return lookup;

		// D1 caps bound parameters at 100 per query — chunk and batch
		const chunks: string[][] = [];
		for (let i = 0; i < tripIds.length; i += 100) chunks.push(tripIds.slice(i, i + 100));

		const batchResults = await this.db.batch<TripEnrichmentRow>(
			chunks.map((chunk) => {
				const placeholders = chunk.map(() => "?").join(",");
				return this.db
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

		return lookup;
	}
}
