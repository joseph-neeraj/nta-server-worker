import { handleVehicles } from "./vehicles";
import { handleVehicleDetails } from "./vehicle-details";

export default {
	async fetch(request, env, ctx): Promise<Response> {
		const { pathname } = new URL(request.url);

		if (pathname === "/v1/live/vehicles") return handleVehicles(request, env, ctx);
		if (pathname.startsWith("/v1/live/trips/")) return handleVehicleDetails(request, env, ctx);

		return new Response("Not Found", { status: 404 });
	},
} satisfies ExportedHandler<Env>;
