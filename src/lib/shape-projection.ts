// Projects a lat/lon point onto a GTFS shape polyline and returns the interpolated
// shape_dist_traveled at the closest point on the shape.
//
// ── Algorithm ────────────────────────────────────────────────────────────────
//
// For each consecutive pair of shape points [A, B] we find the perpendicular foot F
// — the closest point on that segment to the query point P:
//
//     A ──────── F ──────── B
//                │
//                │  (perpendicular)
//                │
//                P  ← query (vehicle or stop)
//
//   t = clamp(dot(P−A, B−A) / |B−A|², 0, 1)
//   F = A + t·(B−A)
//
// The segment with the smallest |PF|² wins. t is then used to linearly interpolate
// shape_dist_traveled between the two endpoints, giving a sub-metre accurate
// distance along the route.
//
// Raw lat/lon treated as Cartesian introduces a cos(lat) ≈ 0.60 longitude
// compression for Ireland, but since we only compare distances across segments
// on the same route this consistent distortion does not affect segment ranking.
//
// ── Usage ────────────────────────────────────────────────────────────────────
//
// Pass vehicle + stop positions separately to vehicleProximityToStop().
// It projects both, then subtracts to get the distance along the route and
// determines whether the vehicle has already passed the stop.

export type ShapePoint = { lat: number; lon: number; distM: number };

/** Projects a single point onto the shape, returning the interpolated distM. */
function projectDistM(shape: ShapePoint[], qLat: number, qLon: number): number {
	let bestSeg = 0;
	let bestT = 0;
	let bestDistSq = Infinity;

	for (let i = 0; i < shape.length - 1; i++) {
		const aLat = shape[i].lat,   aLon = shape[i].lon;
		const bLat = shape[i + 1].lat, bLon = shape[i + 1].lon;

		const abLat = bLat - aLat, abLon = bLon - aLon;
		const ab2 = abLat * abLat + abLon * abLon;
		if (ab2 === 0) continue; // skip degenerate zero-length segments

		const apLat = qLat - aLat, apLon = qLon - aLon;
		// t = dot(P−A, B−A) / |B−A|², clamped to [0,1] so F stays on the segment
		const t = Math.max(0, Math.min(1, (apLat * abLat + apLon * abLon) / ab2));

		const fLat = aLat + t * abLat, fLon = aLon + t * abLon;
		const dLat = qLat - fLat,       dLon = qLon - fLon;
		const distSq = dLat * dLat + dLon * dLon;

		if (distSq < bestDistSq) {
			bestDistSq = distSq;
			bestSeg = i;
			bestT = t;
		}
	}

	// Interpolate shape_dist_traveled at the foot using t
	const a = shape[bestSeg];
	const b = shape[bestSeg + 1] ?? a; // guard: last point has no successor
	return a.distM + bestT * (b.distM - a.distM);
}

/**
 * Computes the distance in metres along the route shape between a live vehicle
 * and a stop, and whether the vehicle has already passed the stop.
 *
 * Returns null if the shape has fewer than 2 points (unusable).
 */
export function vehicleProximityToStop(
	shape: ShapePoint[],
	stopLat: number,
	stopLon: number,
	vehicleLat: number,
	vehicleLon: number,
): { distanceM: number; hasPassed: boolean } | null {
	if (shape.length < 2) return null;

	const vehicleDistM = projectDistM(shape, vehicleLat, vehicleLon);
	const stopDistM    = projectDistM(shape, stopLat, stopLon);

	return {
		distanceM: Math.round(Math.abs(stopDistM - vehicleDistM)),
		hasPassed: vehicleDistM > stopDistM,
	};
}
