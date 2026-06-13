import { Hono, type Context, type Next } from "hono";
import { jwt } from "hono/jwt";
import { rateLimiter } from "hono-rate-limiter";
import { buildErrorResponse } from "./lib/error-response";
import { handleVehicles } from "./handlers/vehicles";
import { handleTripFetch } from "./handlers/trip";
import { handleStops } from "./handlers/stops";
import { handleStaticVersion } from "./handlers/static-version";
import { handleStopSchedule } from "./handlers/stop-schedule";
import { handleInit } from "./handlers/init";
import { SafeKVStore } from "./lib/kv-rate-limit-store";
import { NtaPollerDO } from "./durable-objects/nta-poller";
import { POLLER_NAME } from "./lib/nta-client";

const app = new Hono<{ Bindings: Env }>();

// Validates Accept header for endpoints that serve proto or JSON.
// Applied per-route so /v1/static/version (JSON-only) is unaffected.
function requireProtoAccept(c: Context<{ Bindings: Env }>, next: Next) {
	const accept = c.req.header("Accept");
	const jsonEnabled = c.env.ENABLE_JSON === "true";
	if (accept !== "application/x-protobuf" && (accept !== "application/json" || !jsonEnabled)) {
		return buildErrorResponse(406, "Not Acceptable", null, "This endpoint only supports application/x-protobuf or application/json.");
	}
	return next();
}

// Unauthenticated — must be registered before the /v1/* middleware below

// IP-based rate limit on /init — generous ceiling to accommodate NAT/shared IPs.
// CF-Connecting-IP is the real client IP as seen by Cloudflare.
app.use("/init", (c, next) =>
	rateLimiter<{ Bindings: Env }>({
		windowMs: 60 * 60 * 1000,  // 1 hour window (well above KV's 60s minimum expiration requirement)
		limit: 120,                 // 120 token requests per IP per hour
		keyGenerator: (c) => c.req.header("CF-Connecting-IP") ?? "unknown",
		store: new SafeKVStore({ namespace: c.env.RATE_LIMIT_KV, prefix: "rl:ip:" }),
	})(c, next)
);

app.post("/init", handleInit);

// Verify JWT on all /v1/* routes — rejects missing/expired/invalid tokens with 401
app.use("/v1/*", (c, next) => jwt({ secret: c.env.JWT_SECRET, alg: "HS256" })(c, next));

// Rate limit by token identity (jti claim), not by IP.
// Each user gets his own independent bucket.
// WorkersKVStore is instantiated per-request so it can access c.env.RATE_LIMIT_KV.
app.use("/v1/*", (c, next) =>
	rateLimiter<{ Bindings: Env }>({
		windowMs: 5 * 60 * 1000,   // 5 minute window — NOTE: Cloudflare KV requires expiration ≥ 60s in future,
		                            // so windowMs must be meaningfully above 60s or KV PUT will return 400.
		limit: 600,                 // 600 requests per token per 5 minutes (= 120/min proportionate)
		// jwtPayload is set by the jwt() middleware above after token verification
		keyGenerator: (c) => (c.get("jwtPayload") as { jti: string }).jti,
		store: new SafeKVStore({ namespace: c.env.RATE_LIMIT_KV, prefix: "rl:tok:" }),
	})(c, next)
);

app.get("/v1/live/vehicles", requireProtoAccept, (c) => handleVehicles(c.req.raw, c.env, c.executionCtx as ExecutionContext));
app.get("/v1/live/trips/:trip_id", requireProtoAccept, (c) => handleTripFetch(c.req.raw, c.env, c.executionCtx as ExecutionContext));
app.get("/v1/live/stops/:stop_id", requireProtoAccept, (c) => handleStopSchedule(c.req.raw, c.env, c.executionCtx as ExecutionContext));
app.get("/v1/static/stops", requireProtoAccept, (c) => handleStops(c.req.raw, c.env, c.executionCtx as ExecutionContext));
app.get("/v1/static/version", (c) => handleStaticVersion(c.req.raw, c.env));

// Durable Object that polls NTA and serves the freshest feeds to the request
// path (persisted to its own storage, mirrored to KV as a fallback — see nta-poller.ts).
export { NtaPollerDO };

export default {
	fetch: app.fetch,
	// Cron watchdog: ensure the single global poller's alarm loop is running.
	// idempotent — start() is a no-op if the alarm is already scheduled.
	async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
		ctx.waitUntil(env.NTA_POLLER.getByName(POLLER_NAME).start());
	},
} satisfies ExportedHandler<Env>;
