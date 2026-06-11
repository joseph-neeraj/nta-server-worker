// Reads the static GTFS data version from KV.
// The version is written by scripts/gtfs/publish_diff.sh after each D1 import
// as a full ISO timestamp (e.g. "2026-06-11T08:15:43Z"), so a new import
// immediately invalidates all static edge-cache entries.
//
// Falls back to today's date (YYYY-MM-DD) if the key hasn't been set yet —
// date-only ensures no spurious per-request cache misses on first deploy.

export async function getStaticVersion(env: Env): Promise<string | null> {
	return env.STATIC_META_KV.get("static:version");
}

export async function getStaticVersionWithFallback(env: Env): Promise<string> {
	const version = await getStaticVersion(env);
	if (version) return version;
	// Fallback: use today's date so all workers on the same day share one cache entry
	return new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
}
