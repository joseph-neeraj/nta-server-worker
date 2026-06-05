import { gtfsrPaths, handleGtfsr } from "./gtfsr";
import { handleStatic } from "./static";

export default {
	async fetch(request, env, ctx): Promise<Response> {
		const { pathname } = new URL(request.url);

		if (gtfsrPaths.has(pathname)) {
			return handleGtfsr(request, env, ctx);
		}

		return handleStatic(request, env, ctx);
	},
} satisfies ExportedHandler<Env>;
