export type ThinkSegmentType = "text" | "thinking";

export interface ThinkSegment {
	type: ThinkSegmentType;
	text: string;
}

interface ThinkTagParserState {
	mode: ThinkSegmentType;
	pending: string;
}

const OPEN_TAG = "<think>";
const CLOSE_TAG = "</think>";

function trailingPartialLength(text: string, token: string): number {
	const max = Math.min(text.length, token.length - 1);
	for (let len = max; len > 0; len--) {
		if (token.startsWith(text.slice(-len))) return len;
	}
	return 0;
}

/**
 * Stateful parser for streaming `<think>...</think>` wrappers emitted by some
 * OpenAI-compatible providers. Converts tagged sections into logical
 * text/thinking segments while handling chunk boundaries safely.
 */
export class ThinkTagParser {
	private state: ThinkTagParserState = { mode: "text", pending: "" };

	consume(delta: string): ThinkSegment[] {
		this.state.pending += delta;
		return this.drain(false);
	}

	flush(): ThinkSegment[] {
		return this.drain(true);
	}

	private drain(flushAll: boolean): ThinkSegment[] {
		const out: ThinkSegment[] = [];
		const push = (type: ThinkSegmentType, text: string) => {
			if (!text) return;
			out.push({ type, text });
		};

		while (this.state.pending.length > 0) {
			if (this.state.mode === "text") {
				const openIdx = this.state.pending.indexOf(OPEN_TAG);
				if (openIdx >= 0) {
					push("text", this.state.pending.slice(0, openIdx));
					this.state.pending = this.state.pending.slice(openIdx + OPEN_TAG.length);
					this.state.mode = "thinking";
					continue;
				}

				if (flushAll) {
					push("text", this.state.pending);
					this.state.pending = "";
					break;
				}

				const keep = trailingPartialLength(this.state.pending, OPEN_TAG);
				const safeEnd = Math.max(0, this.state.pending.length - keep);
				push("text", this.state.pending.slice(0, safeEnd));
				this.state.pending = this.state.pending.slice(safeEnd);
				break;
			}

			const closeIdx = this.state.pending.indexOf(CLOSE_TAG);
			if (closeIdx >= 0) {
				push("thinking", this.state.pending.slice(0, closeIdx));
				this.state.pending = this.state.pending.slice(closeIdx + CLOSE_TAG.length);
				this.state.mode = "text";
				continue;
			}

			if (flushAll) {
				push("thinking", this.state.pending);
				this.state.pending = "";
				break;
			}

			const keep = trailingPartialLength(this.state.pending, CLOSE_TAG);
			const safeEnd = Math.max(0, this.state.pending.length - keep);
			push("thinking", this.state.pending.slice(0, safeEnd));
			this.state.pending = this.state.pending.slice(safeEnd);
			break;
		}

		return out;
	}
}
