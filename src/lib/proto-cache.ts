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

/** Header fragment for a final Response. Empty when nextUpdateAt is unknown (cold start). */
export function nextUpdateHeaders(nextUpdateAt: number | null): Record<string, string> {
	if (nextUpdateAt == null) return {};
	return {
		[NEXT_UPDATE_HEADER]: String(nextUpdateAt),
		// Let browser clients read the custom header from cross-origin responses.
		"Access-Control-Expose-Headers": NEXT_UPDATE_HEADER,
	};
}

/** Parses nextUpdateAt back off a cached Response; null if absent or malformed. */
export function readNextUpdateAt(res: Response): number | null {
	const raw = res.headers.get(NEXT_UPDATE_HEADER);
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
	 * nextUpdateAt (epoch ms, optional) is baked into the cached Response as the
	 * X-Next-Update-At header so subsequent cache hits — which return the cached
	 * Response verbatim — still advertise the next refresh time.
	 */
	put(key: Request, compressedBytes: Uint8Array, ttl: number, nextUpdateAt?: number | null): void {
		const headers: Record<string, string> = {
			"Content-Type": "application/x-protobuf",
			"Content-Encoding": "gzip",
			"Cache-Control": `public, max-age=${ttl}`,
			...nextUpdateHeaders(nextUpdateAt ?? null),
		};
		this.ctx.waitUntil(
			this.cache.put(key, new Response(compressedBytes, { headers })),
		);
	}
}
