// GSD2 — Ollama Extension: NDJSON streaming parser

/**
 * Parses a streaming NDJSON (newline-delimited JSON) response body into
 * typed objects. Used for Ollama's /api/chat and /api/pull endpoints.
 *
 * @param strict When true, malformed JSON lines throw instead of being skipped.
 *   Use strict mode for inference streams where silent data loss is unacceptable.
 *   Use permissive mode (default) for progress endpoints like /api/pull.
 */

export async function* parseNDJsonStream<T>(
	body: ReadableStream<Uint8Array>,
	signal?: AbortSignal,
	strict = false,
): AsyncGenerator<T> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";

	try {
		while (true) {
			if (signal?.aborted) break;

			const { done, value } = await reader.read();
			if (done) break;

			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";

			for (const line of lines) {
				const trimmed = line.trim();
				if (!trimmed) continue;
				try {
					yield JSON.parse(trimmed) as T;
				} catch (err) {
					if (strict) {
						throw new Error(
							`Malformed NDJSON line from Ollama: ${trimmed.slice(0, 200)}`,
						);
					}
					// Permissive mode: skip malformed lines
				}
			}
		}

		// Flush remaining buffer (skip if aborted)
		if (buffer.trim() && !signal?.aborted) {
			try {
				yield JSON.parse(buffer.trim()) as T;
			} catch (err) {
				if (strict) {
					throw new Error(
						`Malformed NDJSON line from Ollama: ${buffer.trim().slice(0, 200)}`,
					);
				}
			}
		}
	} finally {
		reader.releaseLock();
	}
}
