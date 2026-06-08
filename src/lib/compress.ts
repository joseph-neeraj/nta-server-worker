// Thin wrappers around the Workers CompressionStream / DecompressionStream APIs.
// Collect the transformed stream into a single Uint8Array via a Response.

export async function gzip(data: Uint8Array): Promise<Uint8Array> {
	const stream = new Blob([data]).stream().pipeThrough(new CompressionStream("gzip"));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function gunzip(data: Uint8Array): Promise<Uint8Array> {
	const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("gzip"));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}
