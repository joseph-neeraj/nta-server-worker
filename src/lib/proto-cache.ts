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
	 */
	put(key: Request, compressedBytes: Uint8Array, ttl: number): void {
		this.ctx.waitUntil(
			this.cache.put(
				key,
				new Response(compressedBytes, {
					headers: {
						"Content-Type": "application/x-protobuf",
						"Content-Encoding": "gzip",
						"Cache-Control": `public, max-age=${ttl}`,
					},
				}),
			),
		);
	}
}
