// GSD2 — Ollama Extension: Stateful <think> tag stream parser

/**
 * Extracts <think>...</think> thinking blocks from a streaming text response.
 * Handles the case where tag boundaries span multiple chunks by buffering
 * up to 8 characters (length of "</think>") at chunk boundaries.
 *
 * Used for reasoning models like deepseek-r1 and qwq that embed thinking
 * inline in their text output.
 */

export type ParsedChunk =
	| { type: "thinking"; text: string }
	| { type: "text"; text: string };

const OPEN_TAG = "<think>";
const CLOSE_TAG = "</think>";
const MAX_TAG_LEN = Math.max(OPEN_TAG.length, CLOSE_TAG.length);

export class ThinkingTagParser {
	private buffer = "";
	private inThinking = false;

	/**
	 * Feed a chunk of text and get back parsed segments.
	 * May return zero or more segments depending on tag boundaries.
	 */
	push(chunk: string): ParsedChunk[] {
		const results: ParsedChunk[] = [];
		let input = this.buffer + chunk;
		this.buffer = "";

		while (input.length > 0) {
			if (this.inThinking) {
				const closeIdx = input.indexOf(CLOSE_TAG);
				if (closeIdx !== -1) {
					// Found close tag — emit thinking content before it
					const thinking = input.slice(0, closeIdx);
					if (thinking) results.push({ type: "thinking", text: thinking });
					this.inThinking = false;
					input = input.slice(closeIdx + CLOSE_TAG.length);
				} else if (this.couldBePartialTag(input, CLOSE_TAG)) {
					// Possible partial close tag at end — buffer only the matching tail
					const tailLen = this.getPartialTagTailLength(input, CLOSE_TAG);
					const safe = input.slice(0, input.length - tailLen);
					if (safe) results.push({ type: "thinking", text: safe });
					this.buffer = input.slice(-tailLen);
					break;
				} else {
					// No close tag — emit all as thinking
					results.push({ type: "thinking", text: input });
					break;
				}
			} else {
				const openIdx = input.indexOf(OPEN_TAG);
				if (openIdx !== -1) {
					// Found open tag — emit text before it
					const text = input.slice(0, openIdx);
					if (text) results.push({ type: "text", text });
					this.inThinking = true;
					input = input.slice(openIdx + OPEN_TAG.length);
				} else if (this.couldBePartialTag(input, OPEN_TAG)) {
					// Possible partial open tag at end — buffer only the matching tail
					const tailLen = this.getPartialTagTailLength(input, OPEN_TAG);
					const safe = input.slice(0, input.length - tailLen);
					if (safe) results.push({ type: "text", text: safe });
					this.buffer = input.slice(-tailLen);
					break;
				} else {
					// No open tag — emit all as text
					results.push({ type: "text", text: input });
					break;
				}
			}
		}

		return results;
	}

	/**
	 * Flush any remaining buffered content. Call at end of stream.
	 */
	flush(): ParsedChunk[] {
		if (!this.buffer) return [];

		const result: ParsedChunk = {
			type: this.inThinking ? "thinking" : "text",
			text: this.buffer,
		};
		this.buffer = "";
		return [result];
	}

	/**
	 * Check if the end of input could be the start of a partial tag.
	 * Only buffers when the tail of input matches a prefix of the tag.
	 */
	private couldBePartialTag(input: string, tag: string): boolean {
		return this.getPartialTagTailLength(input, tag) > 0;
	}

	/**
	 * Get the length of the tail of input that matches a prefix of the tag.
	 * Returns 0 if no partial match.
	 */
	private getPartialTagTailLength(input: string, tag: string): number {
		const maxCheck = Math.min(input.length, tag.length - 1);
		for (let len = maxCheck; len >= 1; len--) {
			const tail = input.slice(-len);
			if (tag.startsWith(tail)) {
				return len;
			}
		}
		return 0;
	}
}
