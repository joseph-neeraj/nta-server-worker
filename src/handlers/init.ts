import { sign } from "hono/jwt";
import type { Context } from "hono";

// Verifies the HMAC-SHA256 signature on the /init request.
//
// The mobile app signs the request with a shared secret (HMAC_SECRET) using:
//   message = method + pathname + timestamp
//
// The X-Timestamp header is checked against the current time to reject replayed
// requests — anything older than 30 seconds is refused.
export async function verifyHmac(request: Request, secret: string): Promise<boolean> {
	const timestamp = request.headers.get("X-Timestamp");
	const signature = request.headers.get("X-Signature");

	if (!timestamp || !signature) return false;

	// Reject stale requests (replay attack prevention)
	const now = Math.floor(Date.now() / 1000);
	if (Math.abs(now - parseInt(timestamp, 10)) > 30) return false;

	const url = new URL(request.url);
	const message = request.method + url.pathname + timestamp;

	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["verify"]
	);

	let sigBytes: Uint8Array;
	try {
		sigBytes = Uint8Array.from(atob(signature), (c) => c.charCodeAt(0));
	} catch {
		// atob throws if the signature is not valid base64
		return false;
	}

	const msgBytes = new TextEncoder().encode(message);
	return crypto.subtle.verify("HMAC", key, sigBytes, msgBytes);
}

// POST /init
//
// Entry point for a new app session. Requires a valid HMAC-signed request.
// Returns a short-lived JWT (1 hour) containing a unique `jti` claim, which
// is used downstream as the rate-limit key for all API requests.
export async function handleInit(c: Context<{ Bindings: Env }>): Promise<Response> {
	const valid = await verifyHmac(c.req.raw, c.env.HMAC_SECRET);
	if (!valid) {
		return c.json({ error: "Unauthorized" }, 401);
	}

	const now = Math.floor(Date.now() / 1000);
	const token = await sign(
		{
			jti: crypto.randomUUID(),   // unique per session — used as the rate-limit key
			iat: now,
			exp: now + 3600,            // 1 hour expiry
			platform: c.req.header("X-Platform") ?? "unknown", // ios | android
		},
		c.env.JWT_SECRET
	);

	return c.json({ token });
}
