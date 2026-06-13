import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
	test: {
		poolOptions: {
			workers: {
				wrangler: { configPath: "./wrangler.jsonc" },
				miniflare: {
					// Override remote: true KV namespaces (set for wrangler dev) with
					// local in-memory stores so tests never hit the real Cloudflare KV API.
					kvNamespaces: ["RATE_LIMIT_KV", "STATIC_META_KV", "RT_FEED_KV"],
					// Inject test values for secrets that are set via `wrangler secret put`
					// and therefore absent from wrangler.jsonc. Real values are never used in tests.
					bindings: {
						JWT_SECRET: "test-jwt-secret",
						HMAC_SECRET: "test-hmac-secret",
					},
				},
			},
		},
	},
});
