// @gsd/pi-coding-agent + token-telemetry — opt-in per-call token observability
//
// Emits a single JSON line per assistant message to stderr when
// `PI_TOKEN_TELEMETRY=1` is set. Captures the cache_read_input_tokens and
// cache_creation_input_tokens fields the providers already extract — so we
// can empirically measure prompt-cache effectiveness (e.g. for #5019 and
// future cache strategy work). Off by default — no behavior change.
//
// Capture pattern: `PI_TOKEN_TELEMETRY=1 npm start 2> token-telemetry.jsonl`

import type { AssistantMessage } from "@gsd/pi-ai";

/** Schema of one telemetry line. JSON-stable for downstream ingestion. */
export interface TokenTelemetryRecord {
	ts: number;
	model: string;
	stopReason: string;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	/**
	 * `usage.cost.total` from the provider. `0` when the provider's cost
	 * registry has no rates for this model (e.g. unknown third-party providers)
	 * — distinguish from a true zero-cost call by checking your model registry.
	 */
	costTotal: number;
	/**
	 * Fraction of new prompt tokens served from cache:
	 * `cacheRead / (cacheRead + input)`. Range [0, 1].
	 * - `0` when neither cacheRead nor input is present (no division by zero).
	 * - `1` on a full cache hit (input = 0, cacheRead > 0).
	 * Note: `input` here is `input_tokens` from the API, which already excludes
	 * cache reads/writes — the denominator is total prompt tokens consumed.
	 */
	cacheHitRatio: number;
}

/** Build a telemetry record from a finished assistant message. */
export function buildTokenTelemetryRecord(msg: AssistantMessage): TokenTelemetryRecord {
	const input = msg.usage?.input ?? 0;
	const output = msg.usage?.output ?? 0;
	const cacheRead = msg.usage?.cacheRead ?? 0;
	const cacheWrite = msg.usage?.cacheWrite ?? 0;
	const costTotal = msg.usage?.cost?.total ?? 0;
	const denom = cacheRead + input;
	const cacheHitRatio = denom > 0 ? cacheRead / denom : 0;

	return {
		ts: msg.timestamp,
		model: msg.model,
		stopReason: msg.stopReason,
		input,
		output,
		cacheRead,
		cacheWrite,
		costTotal,
		cacheHitRatio,
	};
}

/**
 * Emit a token-telemetry line if `PI_TOKEN_TELEMETRY=1`. No-op otherwise.
 *
 * Writes to stderr so it doesn't interfere with TUI/stdout. One JSON object
 * per line. Errors during emission are swallowed — telemetry must never
 * break the agent loop.
 */
export function emitTokenTelemetry(msg: AssistantMessage): void {
	if (process.env.PI_TOKEN_TELEMETRY !== "1") return;
	try {
		const record = buildTokenTelemetryRecord(msg);
		process.stderr.write(`${JSON.stringify(record)}\n`);
	} catch {
		// Telemetry must never break the agent loop. Swallow.
	}
}
