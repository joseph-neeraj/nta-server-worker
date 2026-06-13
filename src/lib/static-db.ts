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

/**
 * Returns the UTC epoch milliseconds for Dublin local midnight on the given YYYYMMDD date.
 * Dublin uses Europe/Dublin: UTC+0 (GMT, winter) or UTC+1 (IST/BST, late March–late October).
 * Probes both offsets and returns whichever candidate lands on the correct Dublin calendar date.
 */
function getDublinMidnightUtcMs(yyyymmdd: string): number {
	const isoDate = `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
	const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Dublin' });
	// Probe largest offset first so we find the UTC instant that equals Dublin *midnight* (00:00 local),
	// not just any time that day. In BST (UTC+1): Dublin midnight = 23:00 UTC prev day (offset=1).
	// In GMT (UTC+0): Dublin midnight = 00:00 UTC (offset=0).
	for (const offsetHours of [1, 0]) {
		const candidate = new Date(`${isoDate}T00:00:00Z`).getTime() - offsetHours * 3_600_000;
		if (fmt.format(new Date(candidate)).replace(/-/g, '') === yyyymmdd) return candidate;
	}
	return new Date(`${isoDate}T00:00:00Z`).getTime(); // unreachable for Dublin
}

/**
 * Converts a GTFS HH:MM:SS time string (hours may be ≥ 24 for post-midnight trips)
 * to a UTC epoch seconds integer, given the Dublin midnight of the service calendar date.
 */
function gtfsTimeToUtcSeconds(gtfsTime: string, serviceDateMidnightMs: number): number {
	const h = parseInt(gtfsTime.slice(0, 2), 10);
	const m = parseInt(gtfsTime.slice(3, 5), 10);
	const s = parseInt(gtfsTime.slice(6, 8), 10);
	return Math.floor(serviceDateMidnightMs / 1000) + h * 3600 + m * 60 + s;
}

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
	 * Returns a stop's metadata and all scheduled arrivals for the current Dublin calendar day.
	 * Includes today's active services (all times) plus yesterday's active services with
	 * arrival_time >= '24:00:00' (post-midnight trips physically running today).
	 * null    — stop not found
	 * "error" — D1 failure
	 *
	 * "Active services" follows the GTFS spec:
	 *   base set  = calendar services active on today's weekday within their date range
	 *   add       = exception_type=1 (ADDED) entries for today
	 *   subtract  = exception_type=2 (REMOVED) entries for today
	 *
	 * Each returned row includes arrival_utc / departure_utc (POSIX seconds) so clients
	 * don't need to parse GTFS overflow times or handle the Europe/Dublin timezone themselves.
	 */
	async getStopWithArrivals(
		stopId: string,
	): Promise<{ stopRow: Record<string, unknown>; arrivalRows: Record<string, unknown>[] } | null | "error"> {
		const now = new Date();

		// All date/day-of-week calculations use Dublin local time (Europe/Dublin).
		// Using UTC here would produce the wrong calendar date during BST (UTC+1)
		// between 00:00–01:00 Dublin time, when UTC is still the previous day.
		const todayStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Dublin' })
			.format(now).replace(/-/g, ''); // "YYYYMMDD"
		// dayCol comes from a fixed array — safe to interpolate directly into SQL
		const todayDayCol = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Dublin', weekday: 'long' })
			.format(now).toLowerCase();

		// Yesterday — needed to catch post-midnight trips (GTFS stores them as 24:xx:xx on the previous day's service)
		const ydNow = new Date(now.getTime() - 86_400_000);
		const yesterdayStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Dublin' })
			.format(ydNow).replace(/-/g, '');
		const yesterdayDayCol = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Dublin', weekday: 'long' })
			.format(ydNow).toLowerCase();

		// Dublin midnight UTC (ms) for each service date — used to convert GTFS times to UTC epoch seconds
		const todayMidnightMs = getDublinMidnightUtcMs(todayStr);
		const yesterdayMidnightMs = getDublinMidnightUtcMs(yesterdayStr);

		try {
			const [stopResult, arrivalsResult] = await this.db.batch([
				// Query 1: look up the stop itself so we can 404 if it doesn't exist
				this.db
					.prepare(`SELECT stop_id, stop_code, stop_name, stop_lat, stop_lon FROM stops WHERE stop_id = ?`)
					.bind(stopId),

				// Query 2: all scheduled arrivals at this stop for today, ordered by time.
				//
				// ── What are "active services"? ───────────────────────────────────────────
				//
				//   calendar        — defines the regular weekly pattern for a service_id.
				//                     e.g. service_id=4 runs Mon–Fri between two dates.
				//                     Active today if: day-column = 1 AND within start/end date.
				//
				//   calendar_dates  — per-date exceptions that override the regular pattern:
				//     exception_type=1 (ADDED)   — runs today even if calendar says it shouldn't
				//                                  (e.g. bank holiday extra)
				//     exception_type=2 (REMOVED) — does NOT run today even if calendar says it should
				//                                  (e.g. Christmas Day cancellation)
				//
				//   Active services = (calendar base set) UNION (ADDED exceptions) EXCEPT (REMOVED exceptions)
				//
				// ── Post-midnight trips ───────────────────────────────────────────────────
				//
				//   GTFS represents trips running past midnight using overflow times:
				//   e.g. a bus departing at 00:30 belongs to the PREVIOUS day's service
				//   and is stored as arrival_time = '24:30:00'.
				//
				//   To include those buses, we also query yesterday's active services
				//   and filter for arrival_time >= '24:00:00'. Times are returned as-is.
				//
				// service_date is included so post-processing can pick the correct Dublin midnight
				// when converting GTFS time strings to UTC epoch seconds.
				this.db
					.prepare(
						`SELECT trip_id, stop_sequence, arrival_time, departure_time,
						        route_short_name, agency_id, trip_headsign, direction_id, service_date
						 FROM (
						   -- ── Part 1: today's active services (all scheduled times) ──────────────
						   SELECT st.trip_id, st.stop_sequence, st.arrival_time, st.departure_time,
						          r.route_short_name, r.agency_id, t.trip_headsign, t.direction_id,
						          ? AS service_date
						   FROM stop_times st
						   JOIN trips t  ON st.trip_id = t.trip_id
						   JOIN routes r ON t.route_id = r.route_id
						   WHERE st.stop_id = ?
						     AND t.service_id IN (
						       SELECT service_id FROM calendar
						         WHERE ${todayDayCol} = 1 AND start_date <= ? AND end_date >= ?
						       UNION
						       SELECT service_id FROM calendar_dates WHERE date = ? AND exception_type = 1
						       EXCEPT
						       SELECT service_id FROM calendar_dates WHERE date = ? AND exception_type = 2
						     )

						   UNION ALL

						   -- ── Part 2: yesterday's active services, post-midnight only ─────────────
						   -- Trips stored as 24:xx:xx / 25:xx:xx that are physically running today.
						   -- Times are returned as-is; the client is responsible for interpreting them.
						   SELECT st.trip_id, st.stop_sequence,
						          st.arrival_time,
						          st.departure_time,
						          r.route_short_name, r.agency_id, t.trip_headsign, t.direction_id,
						          ? AS service_date
						   FROM stop_times st
						   JOIN trips t  ON st.trip_id = t.trip_id
						   JOIN routes r ON t.route_id = r.route_id
						   WHERE st.stop_id = ?
						     AND st.arrival_time >= '24:00:00'
						     AND t.service_id IN (
						       SELECT service_id FROM calendar
						         WHERE ${yesterdayDayCol} = 1 AND start_date <= ? AND end_date >= ?
						       UNION
						       SELECT service_id FROM calendar_dates WHERE date = ? AND exception_type = 1
						       EXCEPT
						       SELECT service_id FROM calendar_dates WHERE date = ? AND exception_type = 2
						     )
						 )
						 ORDER BY arrival_time`,
					)
					.bind(
						todayStr, stopId, todayStr, todayStr, todayStr, todayStr,              // Part 1
						yesterdayStr, stopId, yesterdayStr, yesterdayStr, yesterdayStr, yesterdayStr, // Part 2
					),
			]);

			const stopRow = (stopResult.results[0] as Record<string, unknown>) ?? null;
			if (!stopRow) return null;

			// Post-process: convert GTFS time strings to UTC epoch seconds.
			// Uses service_date to pick the correct Dublin midnight for each row
			// (Part 1 rows use todayStr, Part 2 post-midnight rows use yesterdayStr).
			const arrivalRows = (arrivalsResult.results as Record<string, unknown>[]).map((row) => {
				const midnightMs = (row.service_date as string) === todayStr ? todayMidnightMs : yesterdayMidnightMs;
				return {
					...row,
					arrival_utc: row.arrival_time ? gtfsTimeToUtcSeconds(row.arrival_time as string, midnightMs) : null,
					departure_utc: row.departure_time ? gtfsTimeToUtcSeconds(row.departure_time as string, midnightMs) : null,
				};
			});

			return { stopRow, arrivalRows };
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
