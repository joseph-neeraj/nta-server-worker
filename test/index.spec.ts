import {
	env,
	createExecutionContext,
	waitOnExecutionContext,
} from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { sign } from "hono/jwt";
import worker from "../src/index";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// POST to /init with an optional IP header and any extra headers.
// No HMAC is set — the handler returns 401, which is intentional for routing
// and rate-limit tests: 401 proves the request reached the handler, not Hono.
async function postInit(ip?: string, extraHeaders: Record<string, string> = {}): Promise<Response> {
	const headers: Record<string, string> = {
		...(ip !== undefined ? { "CF-Connecting-IP": ip } : {}),
		...extraHeaders,
	};
	const ctx = createExecutionContext();
	const res = await worker.fetch(
		new Request("http://worker.example/init", { method: "POST", headers }),
		env,
		ctx,
	);
	await waitOnExecutionContext(ctx);
	return res;
}

async function initWithMethod(method: string): Promise<Response> {
	const ctx = createExecutionContext();
	const res = await worker.fetch(
		new Request("http://worker.example/init", {
			method,
			headers: { "CF-Connecting-IP": "1.2.3.4" },
		}),
		env,
		ctx,
	);
	await waitOnExecutionContext(ctx);
	return res;
}

// Pre-seeds the IP rate-limit bucket for `ip` to simulate `totalHits` prior requests.
// Uses the same KV key format and entry shape as SafeKVStore so the next real
// request will read this entry and apply the limit correctly.
const RL_IP_PREFIX = "rl:ip:";
const ONE_HOUR_MS = 60 * 60 * 1000;

async function seedBucket(ip: string, totalHits: number): Promise<void> {
	const resetTime = new Date(Date.now() + ONE_HOUR_MS);
	await env.RATE_LIMIT_KV.put(
		`${RL_IP_PREFIX}${ip}`,
		JSON.stringify({ totalHits, resetTime }),
		{ expirationTtl: 3600 },
	);
}

// Writes an already-expired bucket entry.
// SafeKVStore.get() discards entries whose resetTime <= new Date(),
// so the next request will start a fresh window.
async function expireBucket(ip: string): Promise<void> {
	const resetTime = new Date(Date.now() - 1000); // 1 second in the past
	await env.RATE_LIMIT_KV.put(
		`${RL_IP_PREFIX}${ip}`,
		JSON.stringify({ totalHits: 120, resetTime }),
		{ expirationTtl: 61 }, // KV minimum TTL
	);
}

// ---------------------------------------------------------------------------
// Method routing
// ---------------------------------------------------------------------------

describe("/init — method routing", () => {
	it("GET /init → 404", async () => {
		expect((await initWithMethod("GET")).status).toBe(404);
	});

	it("PUT /init → 404", async () => {
		expect((await initWithMethod("PUT")).status).toBe(404);
	});

	it("DELETE /init → 404", async () => {
		expect((await initWithMethod("DELETE")).status).toBe(404);
	});

	it("POST /init reaches the handler (not a routing 404)", async () => {
		// Handler returns 401 (invalid HMAC) — any non-404 proves the route is wired
		const res = await postInit("10.0.0.1");
		expect(res.status).not.toBe(404);
	});
});

// ---------------------------------------------------------------------------
// IP rate limiting
// Each test uses a unique IP so buckets don't bleed across tests.
// Buckets are pre-seeded by writing directly into RATE_LIMIT_KV using the
// same key format and entry shape as SafeKVStore — faster than making 120
// real HTTP requests and avoids hitting the rate limiter during setup.
// ---------------------------------------------------------------------------

describe("/init — IP rate limiting", () => {
	it("120 requests from the same IP all reach the handler (none are 429)", async () => {
		// 119 prior hits → the 120th request (the one we make) is still within the limit
		await seedBucket("rl-under-limit", 119);
		const res = await postInit("rl-under-limit");
		expect(res.status).not.toBe(429);
	});

	it("121st request from the same IP is blocked with 429", async () => {
		// 120 prior hits → the next (121st) request exceeds the limit
		await seedBucket("rl-at-limit", 120);
		const blocked = await postInit("rl-at-limit");
		expect(blocked.status).toBe(429);
	});

	it("IP A exhausted does not block IP B", async () => {
		await seedBucket("rl-ip-a", 120); // A is at the limit
		const res = await postInit("rl-ip-b"); // B has its own fresh bucket
		expect(res.status).not.toBe(429);
	});

	it("requests without CF-Connecting-IP share the 'unknown' bucket", async () => {
		// Seed the "unknown" key — keyGenerator returns "unknown" when the header is absent
		await seedBucket("unknown", 120);
		const blocked = await postInit(/* no IP */);
		expect(blocked.status).toBe(429);
	});

	it("after the 1-hour window expires, the same IP can make requests again", async () => {
		const ip = "rl-window-reset";
		await seedBucket(ip, 120);
		expect((await postInit(ip)).status).toBe(429); // confirm bucket is exhausted

		// Write an expired entry — SafeKVStore.get() checks resetTime <= new Date()
		// and discards stale entries, giving the next request a fresh window.
		await expireBucket(ip);
		const res = await postInit(ip);
		expect(res.status).not.toBe(429);
	});
});

// ---------------------------------------------------------------------------
// Helpers for /v1/* tests
//
// /v1/static/version is used as the probe route throughout: it has no external
// dependencies (KV miss falls back to today's date) so it always returns 200
// when authentication and rate-limiting pass. Any non-200 is middleware.
// ---------------------------------------------------------------------------

async function getVersion(authHeader?: string): Promise<Response> {
	const ctx = createExecutionContext();
	const res = await worker.fetch(
		new Request("http://worker.example/v1/static/version", {
			headers: authHeader ? { Authorization: authHeader } : {},
		}),
		env,
		ctx,
	);
	await waitOnExecutionContext(ctx);
	return res;
}

// Signs a JWT with env.JWT_SECRET (the same secret the middleware uses).
// Override any claim by passing extras — used to forge expired or malformed tokens.
async function makeToken(extras: Record<string, unknown> = {}): Promise<string> {
	const now = Math.floor(Date.now() / 1000);
	return sign(
		{ jti: crypto.randomUUID(), iat: now, exp: now + 3600, ...extras },
		env.JWT_SECRET,
	);
}

// Pre-seeds the token rate-limit bucket for a given jti.
const RL_TOK_PREFIX = "rl:tok:";
const FIVE_MIN_MS = 5 * 60 * 1000;

async function seedTokenBucket(jti: string, totalHits: number): Promise<void> {
	const resetTime = new Date(Date.now() + FIVE_MIN_MS);
	await env.RATE_LIMIT_KV.put(
		`${RL_TOK_PREFIX}${jti}`,
		JSON.stringify({ totalHits, resetTime }),
		{ expirationTtl: 300 },
	);
}

async function expireTokenBucket(jti: string): Promise<void> {
	const resetTime = new Date(Date.now() - 1000); // already past
	await env.RATE_LIMIT_KV.put(
		`${RL_TOK_PREFIX}${jti}`,
		JSON.stringify({ totalHits: 600, resetTime }),
		{ expirationTtl: 61 },
	);
}

// ---------------------------------------------------------------------------
// /v1/* — JWT authentication
// ---------------------------------------------------------------------------

describe("/v1/* — JWT authentication", () => {
	it("missing Authorization header → 401", async () => {
		expect((await getVersion()).status).toBe(401);
	});

	it("Authorization header present but not Bearer scheme → 401", async () => {
		expect((await getVersion("Basic dXNlcjpwYXNz")).status).toBe(401);
	});

	it("Bearer token is not a valid JWT → 401", async () => {
		expect((await getVersion("Bearer not.a.jwt")).status).toBe(401);
	});

	it("Bearer token signed with wrong secret → 401", async () => {
		const bad = await sign(
			{ jti: crypto.randomUUID(), iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 },
			"wrong-secret",
		);
		expect((await getVersion(`Bearer ${bad}`)).status).toBe(401);
	});

	it("Bearer token with correct secret but expired → 401", async () => {
		const past = Math.floor(Date.now() / 1000) - 10;
		const expired = await makeToken({ exp: past });
		expect((await getVersion(`Bearer ${expired}`)).status).toBe(401);
	});

	it("valid Bearer token → passes JWT middleware (not 401)", async () => {
		const token = await makeToken();
		expect((await getVersion(`Bearer ${token}`)).status).not.toBe(401);
	});
});

// ---------------------------------------------------------------------------
// /v1/* — token rate limiting
// Each test uses a distinct jti so buckets don't bleed across tests.
// ---------------------------------------------------------------------------

describe("/v1/* — token rate limiting", () => {
	it("600 requests with the same token all pass (none are 429)", async () => {
		const jti = crypto.randomUUID();
		// 599 prior hits → the 600th (the one we make) is still within the limit
		await seedTokenBucket(jti, 599);
		const token = await makeToken({ jti });
		expect((await getVersion(`Bearer ${token}`)).status).not.toBe(429);
	});

	it("601st request with the same token is blocked with 429", async () => {
		const jti = crypto.randomUUID();
		await seedTokenBucket(jti, 600);
		const token = await makeToken({ jti });
		expect((await getVersion(`Bearer ${token}`)).status).toBe(429);
	});

	it("token A exhausted does not block token B", async () => {
		const jtiA = crypto.randomUUID();
		const jtiB = crypto.randomUUID();
		await seedTokenBucket(jtiA, 600); // A is at the limit
		const tokenB = await makeToken({ jti: jtiB });
		expect((await getVersion(`Bearer ${tokenB}`)).status).not.toBe(429);
	});

	it("rate limit is keyed by jti — same secret, different jti, independent buckets", async () => {
		const jtiA = crypto.randomUUID();
		const jtiB = crypto.randomUUID();
		await seedTokenBucket(jtiA, 600);
		// Token B has the same secret and structure but a different jti — fresh bucket
		const tokenB = await makeToken({ jti: jtiB });
		const res = await getVersion(`Bearer ${tokenB}`);
		expect(res.status).not.toBe(429);
	});

	it("after the 5-minute window expires, the same token can make requests again", async () => {
		const jti = crypto.randomUUID();
		await seedTokenBucket(jti, 600);
		const token = await makeToken({ jti });
		expect((await getVersion(`Bearer ${token}`)).status).toBe(429); // confirm exhausted

		// Expire the bucket — SafeKVStore.get() discards entries with resetTime in the past
		await expireTokenBucket(jti);
		expect((await getVersion(`Bearer ${token}`)).status).not.toBe(429);
	});
});

// ---------------------------------------------------------------------------
// /v1/* — route wiring
//
// For each endpoint, two things are verified:
//   1. requireProtoAccept is active — a request without a supported Accept
//      header (but with a valid JWT) gets 406 before reaching the handler.
//   2. The route is wired — a request with Accept: application/x-protobuf
//      passes the Accept check and reaches the handler (not a 404).
//      The handler itself may return any status; 404 is the only value that
//      would indicate the route is missing entirely.
//
// /v1/static/version is deliberately excluded: it is JSON-only and does not
// use requireProtoAccept — it is covered by the JWT tests above.
// ---------------------------------------------------------------------------

describe("/v1/* — route wiring", async () => {
	const token = await makeToken();
	const validAuth = `Bearer ${token}`;

	// Each entry: [method, path, description]
	const routes: [string, string, string][] = [
		["GET", "/v1/live/vehicles",           "vehicles"],
		["GET", "/v1/live/trips/trip-123",     "trips/:trip_id"],
		["GET", "/v1/live/stops/stop-456",     "stops/:stop_id"],
		["GET", "/v1/static/stops",            "static stops"],
	];

	for (const [method, path, label] of routes) {
		it(`${label}: no Accept header → 406 (requireProtoAccept)`, async () => {
			const ctx = createExecutionContext();
			const res = await worker.fetch(
				new Request(`http://worker.example${path}`, {
					method,
					headers: { Authorization: validAuth },
					// no Accept header — fails requireProtoAccept
				}),
				env, ctx,
			);
			await waitOnExecutionContext(ctx);
			expect(res.status).toBe(406);
		});

		it(`${label}: Accept: application/x-protobuf → route is wired (not 404)`, async () => {
			const ctx = createExecutionContext();
			const res = await worker.fetch(
				new Request(`http://worker.example${path}`, {
					method,
					headers: { Authorization: validAuth, Accept: "application/x-protobuf" },
				}),
				env, ctx,
			);
			await waitOnExecutionContext(ctx);
			expect(res.status).not.toBe(404);
		});
	}
});

