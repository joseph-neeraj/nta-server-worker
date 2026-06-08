// Safe KV-backed rate limit store for hono-rate-limiter.
//
// WorkersKVStore from @hono-rate-limiter/cloudflare uses absolute `expiration`
// (Unix timestamp) when writing to KV. This causes a 400 error in two cases:
//
//   1. KV eventual consistency: a key can be returned briefly after its TTL
//      expires. WorkersKVStore reads the old resetTime (now in the past) and
//      tries to PUT it back as the expiration — Cloudflare rejects it.
//
//   2. Short windows (≤ ~62s): by the time the PUT reaches KV's API the
//      expiration is fewer than 60 seconds away, which KV also rejects.
//
// This store fixes both by:
//   - Treating entries whose resetTime has passed as non-existent (fresh window)
//   - Using `expirationTtl` (relative seconds) instead of `expiration`
//   - Clamping the TTL to a minimum of 61 seconds

interface RateLimitEntry {
	totalHits: number;
	resetTime: Date;
}

// What's stored in KV — resetTime is serialised as an ISO string
interface StoredEntry {
	totalHits: number;
	resetTime: string;
}

export class SafeKVStore {
	namespace: KVNamespace;
	prefix: string;
	private windowMs = 0;

	constructor(options: { namespace: KVNamespace; prefix?: string }) {
		this.namespace = options.namespace;
		this.prefix = options.prefix ?? "hrl:";
	}

	init(options: { windowMs: number }) {
		this.windowMs = options.windowMs;
	}

	private prefixKey(key: string): string {
		return `${this.prefix}${key}`;
	}

	async get(key: string): Promise<RateLimitEntry | undefined> {
		const raw = await this.namespace.get<StoredEntry>(this.prefixKey(key), "json");
		if (!raw) return undefined;
		const resetTime = new Date(raw.resetTime);
		// Discard entries whose window has already passed — don't reuse a stale resetTime
		if (resetTime <= new Date()) return undefined;
		return { totalHits: raw.totalHits, resetTime };
	}

	async increment(key: string): Promise<{ totalHits: number; resetTime: Date }> {
		const now = Date.now();
		const existing = await this.get(key);
		const resetTime = existing ? new Date(existing.resetTime) : new Date(now + this.windowMs);
		const totalHits = (existing?.totalHits ?? 0) + 1;

		const ttlSeconds = Math.ceil((resetTime.getTime() - now) / 1000);
		await this.namespace.put(
			this.prefixKey(key),
			JSON.stringify({ totalHits, resetTime }),
			{ expirationTtl: Math.max(ttlSeconds, 61) } // KV requires ≥ 60s; 61 gives a small buffer
		);

		return { totalHits, resetTime };
	}

	async decrement(key: string): Promise<void> {
		const existing = await this.get(key);
		if (!existing) return;
		const ttlSeconds = Math.ceil((existing.resetTime.getTime() - Date.now()) / 1000);
		await this.namespace.put(
			this.prefixKey(key),
			JSON.stringify({ totalHits: existing.totalHits - 1, resetTime: existing.resetTime }),
			{ expirationTtl: Math.max(ttlSeconds, 61) }
		);
	}

	async resetKey(key: string): Promise<void> {
		await this.namespace.delete(this.prefixKey(key));
	}
}
