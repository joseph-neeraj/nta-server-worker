import { ErrorResponse } from "../generated/res/nta";

/**
 * Build a standardised error response in whichever format the client requested.
 * Falls back to JSON for any non-protobuf Accept value.
 */
export function buildErrorResponse(
	code: number,
	description: string,
	accept: string | null,
	endUserFeedback = "",
): Response {
	const payload: ErrorResponse = { code, description, endUserFeedback };
	if (accept === "application/x-protobuf") {
		const bytes = ErrorResponse.encode(payload).finish();
		return new Response(bytes, {
			status: code,
			headers: { "Content-Type": "application/x-protobuf" },
		});
	}
	return new Response(JSON.stringify(ErrorResponse.toJSON(payload)), {
		status: code,
		headers: { "Content-Type": "application/json" },
	});
}
