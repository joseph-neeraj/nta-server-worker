// Handler for GET /v1/static/version
//
// Returns the current static GTFS data version. Clients should poll this
// cheaply and only re-fetch heavy static endpoints (e.g. /v1/static/stops)
// when the version changes.
//
// The version is written to STATIC_META_KV by scripts/gtfs/publish_diff.sh
// after each successful D1 import. Format: "<feed-uuid>/<ISO-timestamp>",
// e.g. "0E8CF856-0FA7-4FC6-B420-2423A092BC69/2026-06-11T08:15:43Z".

import { getStaticVersionWithFallback } from "../lib/static-version";

export async function handleStaticVersion(request: Request, env: Env): Promise<Response> {
	const version = await getStaticVersionWithFallback(env);

	return new Response(JSON.stringify({ version }), {
		headers: {
			"Content-Type": "application/json",
			// Short TTL — clients poll this to detect changes; stale for too long defeats the purpose
			"Cache-Control": "public, max-age=60",
		},
	});
}
