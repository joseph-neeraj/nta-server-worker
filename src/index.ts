import { handleVehicles } from "./vehicles";
import { handleVehicleDetails } from "./vehicle-details";

export default {
	async fetch(request, env, ctx): Promise<Response> {
		const { pathname } = new URL(request.url);

		if (pathname === "/vehicles") return handleVehicles(request, env, ctx);
		if (pathname === "/vehicle-details") return handleVehicleDetails(request, env, ctx);

		return new Response("Not Found", { status: 404 });
	},
} satisfies ExportedHandler<Env>;
