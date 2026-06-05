-- GTFS Static schema
-- Imported once daily from NTA's GTFS_Realtime.zip

CREATE TABLE IF NOT EXISTS agency (
  agency_id   TEXT PRIMARY KEY,
  agency_name TEXT NOT NULL,
  agency_url  TEXT,
  agency_timezone TEXT
);

CREATE TABLE IF NOT EXISTS routes (
  route_id         TEXT PRIMARY KEY,
  agency_id        TEXT,
  route_short_name TEXT,
  route_long_name  TEXT,
  route_desc       TEXT,
  route_type       INTEGER,
  route_url        TEXT,
  route_color      TEXT,
  route_text_color TEXT,
  FOREIGN KEY (agency_id) REFERENCES agency(agency_id)
);

CREATE TABLE IF NOT EXISTS calendar (
  service_id TEXT PRIMARY KEY,
  monday     INTEGER NOT NULL,
  tuesday    INTEGER NOT NULL,
  wednesday  INTEGER NOT NULL,
  thursday   INTEGER NOT NULL,
  friday     INTEGER NOT NULL,
  saturday   INTEGER NOT NULL,
  sunday     INTEGER NOT NULL,
  start_date TEXT NOT NULL,
  end_date   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS calendar_dates (
  service_id     TEXT    NOT NULL,
  date           TEXT    NOT NULL,
  exception_type INTEGER NOT NULL,
  PRIMARY KEY (service_id, date)
);

CREATE TABLE IF NOT EXISTS shapes (
  shape_id            TEXT    NOT NULL,
  shape_pt_lat        REAL    NOT NULL,
  shape_pt_lon        REAL    NOT NULL,
  shape_pt_sequence   INTEGER NOT NULL,
  shape_dist_traveled REAL,
  PRIMARY KEY (shape_id, shape_pt_sequence)
);

CREATE TABLE IF NOT EXISTS stops (
  stop_id        TEXT PRIMARY KEY,
  stop_code      TEXT,
  stop_name      TEXT NOT NULL,
  stop_desc      TEXT,
  stop_lat       REAL NOT NULL,
  stop_lon       REAL NOT NULL,
  zone_id        TEXT,
  stop_url       TEXT,
  location_type  INTEGER,
  parent_station TEXT
);

CREATE TABLE IF NOT EXISTS trips (
  route_id        TEXT NOT NULL,
  service_id      TEXT NOT NULL,
  trip_id         TEXT PRIMARY KEY,
  trip_headsign   TEXT,
  trip_short_name TEXT,
  direction_id    INTEGER,
  block_id        TEXT,
  shape_id        TEXT,
  FOREIGN KEY (route_id)   REFERENCES routes(route_id),
  FOREIGN KEY (service_id) REFERENCES calendar(service_id)
);

CREATE TABLE IF NOT EXISTS stop_times (
  trip_id        TEXT    NOT NULL,
  arrival_time   TEXT    NOT NULL,
  departure_time TEXT    NOT NULL,
  stop_id        TEXT    NOT NULL,
  stop_sequence  INTEGER NOT NULL,
  stop_headsign  TEXT,
  pickup_type    INTEGER,
  drop_off_type  INTEGER,
  timepoint      INTEGER,
  PRIMARY KEY (trip_id, stop_sequence),
  FOREIGN KEY (trip_id) REFERENCES trips(trip_id),
  FOREIGN KEY (stop_id) REFERENCES stops(stop_id)
);

-- Useful indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_routes_short_name  ON routes(route_short_name);
CREATE INDEX IF NOT EXISTS idx_trips_route        ON trips(route_id);
CREATE INDEX IF NOT EXISTS idx_trips_service      ON trips(service_id);
CREATE INDEX IF NOT EXISTS idx_stop_times_stop    ON stop_times(stop_id);
CREATE INDEX IF NOT EXISTS idx_stop_times_trip    ON stop_times(trip_id);
CREATE INDEX IF NOT EXISTS idx_calendar_dates_svc ON calendar_dates(service_id);
