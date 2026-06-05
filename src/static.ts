// Static GTFS data endpoints — served from D1 (nta_static database)
// No caching: these are queried directly on each request.

export async function handleStatic(_request: Request, _env: Env, _ctx: ExecutionContext): Promise<Response> {
	return new Response("Not Found", { status: 404 });
}
