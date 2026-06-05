# API Endpoints — Implementation Spec

## Static endpoints (`src/static.ts`)

Implement three new endpoints in `src/static.ts`. The D1 database (`nta_static` binding) is already set up and populated with the NTA GTFS static feed. The router in `src/index.ts` already forwards all non-GTFS-RT paths to `handleStatic` — no changes needed there.

All static endpoints:
- Accept `GET` only
- Return `application/json`
- Return `{ "error": "..." }` with an appropriate status code on failure (400 missing param, 404 not found, 500 DB error)
- Cache successful responses with `Cache-Control: public, max-age=3600`

---

## `GET /static/trip?trip_id=<trip_id>`

Returns route and agency metadata for a trip.

**Response:**
```json
{
  "trip_id": "5675_85",
  "trip_headsign": "Edenderry Town Hall",
  "direction_id": 0,
  "shape_id": "5675_85_shape",
  "route_short_name": "120",
  "route_long_name": "Dublin - Edenderry",
  "route_color": "",
  "route_text_color": "",
  "agency_name": "Go-Ahead Ireland",
  "agency_url": "https://www.goaheadireland.ie/"
}
```

---

## `GET /static/trip-stops?trip_id=<trip_id>`

Returns the ordered stop list for a trip with names, coordinates, and scheduled times.

**Response:**
```json
{
  "trip_id": "5675_85",
  "stops": [
    {
      "stop_sequence": 1,
      "stop_id": "8340B355121",
      "stop_code": 355121,
      "stop_name": "Dublin, Busáras",
      "stop_lat": 53.3498,
      "stop_lon": -6.2490,
      "arrival_time": "14:00:00",
      "departure_time": "14:00:00",
      "pickup_type": 0,
      "drop_off_type": 1,
      "timepoint": 1
    }
  ]
}
```

---

## `GET /static/trip-shape?trip_id=<trip_id>`

Returns the route polyline. Points are compact `[lat, lon, dist_meters]` triples to keep payload small (shapes can have thousands of points).

**Response:**
```json
{
  "trip_id": "5675_85",
  "shape_id": "5675_85_shape",
  "points": [
    [53.3498, -6.2490, 0.0],
    [53.3512, -6.2601, 120.5],
    [53.3641, -6.4894, 18200.3]
  ]
}
```

The third value in each triple is `shape_dist_traveled` in metres from the trip start.

---

## Realtime endpoint (`src/gtfsr.ts`)

### `GET /realtime/trip-delays?trip_id=<trip_id>`

Returns the delay data for a single trip, extracted from the NTA `/TripUpdates` feed. The full TripUpdates feed is already fetched and cached by the worker for 65s — this endpoint just decodes it and filters to the requested `trip_id`, so the cost is minimal.

Add this route to the existing `ROUTES` map in `src/gtfsr.ts` (or handle it separately within `handleGtfsr`), then decode the protobuf, find the matching `TripUpdate` entity, and return its stop-time updates as JSON.

**Response — 200 OK `application/json`:**
```json
{
  "trip_id": "5675_709",
  "stop_time_updates": [
    { "stop_sequence": 30, "stop_id": "8530B1581501", "arrival_delay": 2442, "departure_delay": 2442 },
    { "stop_sequence": 31, "stop_id": "8530B158231",  "arrival_delay": 2438, "departure_delay": 2438 },
    { "stop_sequence": 32, "stop_id": "7010B158131",  "arrival_delay": 2358, "departure_delay": null }
  ]
}
```

- `arrival_delay` / `departure_delay`: seconds, positive = late. `null` if not present in the feed for that stop.
- The feed only includes **remaining stops** — stops already passed are omitted.
- Return `404` if no `TripUpdate` entity matches the `trip_id` (bus may have finished its trip).
- Do **not** cache this response — delays change every ~30s.
