import { Hono } from "hono";
import { jwt } from "hono/jwt";
import { rateLimiter } from "hono-rate-limiter";
import { WorkersKVStore } from "@hono-rate-limiter/cloudflare";
import { handleVehicles } from "./vehicles";
import { handleVehicleDetails } from "./vehicle-details";
import { handleInit } from "./init";

const app = new Hono<{ Bindings: Env }>();

// Unauthenticated — must be registered before the /v1/* middleware below

// IP-based rate limit on /init — generous ceiling to accommodate NAT/shared IPs.
// CF-Connecting-IP is the real client IP as seen by Cloudflare.
app.use("/init", (c, next) =>
	rateLimiter<{ Bindings: Env }>({
		windowMs: 60 * 60 * 1000,  // 1 hour window (well above KV's 60s minimum expiration requirement)
		limit: 120,                 // 120 token requests per IP per hour
		keyGenerator: (c) => c.req.header("CF-Connecting-IP") ?? "unknown",
		store: new WorkersKVStore({ namespace: c.env.RATE_LIMIT_KV, prefix: "rl:ip:" }),
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
		store: new WorkersKVStore({ namespace: c.env.RATE_LIMIT_KV, prefix: "rl:tok:" }),
	})(c, next)
);

app.get("/v1/live/vehicles", (c) => handleVehicles(c.req.raw, c.env, c.executionCtx as ExecutionContext));
app.get("/v1/live/trips/:trip_id", (c) => handleVehicleDetails(c.req.raw, c.env, c.executionCtx as ExecutionContext));

export default app;
