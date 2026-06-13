// Thin wrapper around the Cloudflare edge cache for gzip-compressed proto responses.
//
// Every proto handler repeats the same three operations:
//   match      — look up a cached response
//   decompress — gunzip a cached response back to raw bytes (for the JSON path)
//   put        — fire-and-forget store with standard proto headers
//
// This class centralises that boilerplate so handlers only deal with
// cache keys, proto encode/decode, and building the final Response.

import { gunzip } from "./compress";

/** Header that advertises the epoch-ms instant the live data will next refresh. */
export const NEXT_UPDATE_HEADER = "X-Next-Update-At";

/** Header that carries the epoch-ms instant of the last successful poll behind this data. */
export const LAST_UPDATE_HEADER = "X-Last-Update-At";

/**
 * Header fragment for a final Response carrying the freshness hints. Each header
 * is omitted when its value is unknown (cold start, before the poller stamps it).
 * A single Access-Control-Expose-Headers lists whichever headers are present so
 * the two spreads don't clobber each other on a cross-origin response.
 */
export function feedHeaders(nextUpdateAt: number | null, lastUpdateAt: number | null): Record<string, string> {
	const headers: Record<string, string> = {};
	const exposed: string[] = [];
	if (nextUpdateAt != null) {
		headers[NEXT_UPDATE_HEADER] = String(nextUpdateAt);
		exposed.push(NEXT_UPDATE_HEADER);
	}
	if (lastUpdateAt != null) {
		headers[LAST_UPDATE_HEADER] = String(lastUpdateAt);
		exposed.push(LAST_UPDATE_HEADER);
	}
	// Let browser clients read the custom headers from cross-origin responses.
	if (exposed.length) headers["Access-Control-Expose-Headers"] = exposed.join(", ");
	return headers;
}

/** Parses nextUpdateAt back off a cached Response; null if absent or malformed. */
export function readNextUpdateAt(res: Response): number | null {
	return readEpochHeader(res, NEXT_UPDATE_HEADER);
}

/** Parses lastUpdateAt back off a cached Response; null if absent or malformed. */
export function readLastUpdateAt(res: Response): number | null {
	return readEpochHeader(res, LAST_UPDATE_HEADER);
}

function readEpochHeader(res: Response, name: string): number | null {
	const raw = res.headers.get(name);
	if (raw == null) return null;
	const n = Number(raw);
	return Number.isFinite(n) ? n : null;
}

/**
 * Cache-Control max-age (whole seconds) that aligns with nextUpdateAt, so the
 * HTTP freshness window and the X-Next-Update-At hint always agree. Clamped to
 * ≥1 so we never emit max-age=0. Falls back to `fallback` when nextUpdateAt is
 * unknown (cold start, before the poller has stamped metadata).
 *
 * Note: max-age is relative to receipt, but it's computed here from the absolute
 * nextUpdateAt at store time. On an edge cache hit the stored max-age stays correct
 * because Cloudflare adds an `Age` header, and downstream freshness = max-age − Age,
 * which resolves back to (nextUpdateAt − now).
 */
export function cacheMaxAge(nextUpdateAt: number | null, fallback: number): number {
	if (nextUpdateAt == null) return fallback;
	return Math.max(1, Math.ceil((nextUpdateAt - Date.now()) / 1000));
}

export class ProtoCache {
	private cache: Cache;

	constructor(private ctx: ExecutionContext) {
		this.cache = caches.default;
	}

	/** Returns the cached Response, or undefined on a miss. */
	match(key: Request): Promise<Response | undefined> {
		return this.cache.match(key);
	}

	/** Decompresses a cached gzip proto response back to raw bytes. */
	async decompress(res: Response): Promise<Uint8Array> {
		return gunzip(new Uint8Array(await res.arrayBuffer()));
	}

	/**
	 * Stores compressed proto bytes in the edge cache via ctx.waitUntil.
	 * Fire-and-forget — the current response is not blocked by this write.
	 *
	 * nextUpdateAt/lastUpdateAt (epoch ms, optional) are baked into the cached
	 * Response as the X-Next-Update-At / X-Last-Update-At headers so subsequent
	 * cache hits — which return the cached Response verbatim — still carry the
	 * freshness hints.
	 */
	put(key: Request, compressedBytes: Uint8Array, ttl: number, nextUpdateAt?: number | null, lastUpdateAt?: number | null): void {
		const headers: Record<string, string> = {
			"Content-Type": "application/x-protobuf",
			"Content-Encoding": "gzip",
			"Cache-Control": `public, max-age=${ttl}`,
			...feedHeaders(nextUpdateAt ?? null, lastUpdateAt ?? null),
		};
		this.ctx.waitUntil(
			this.cache.put(key, new Response(compressedBytes, { headers })),
		);
	}
}
