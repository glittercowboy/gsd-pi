// pi-coding-agent — secret redaction for session log persistence
//
// Called by prepareForPersistence() in session-manager.ts on every string
// before it lands in the JSONL transcript. Replaces well-known secret shapes
// with [REDACTED:<kind>] placeholders so credentials pasted by the user or
// read from .env-style files never persist to disk.
//
// Pattern selection bias: high-specificity shapes only. Loose patterns
// (e.g. FOO_SECRET=...) produce too many false positives in docs and code
// samples and are intentionally excluded.

interface SecretPattern {
	kind: string;
	regex: RegExp;
}

// Order matters: more-specific patterns first (sk-ant- before generic sk-).
const PATTERNS: readonly SecretPattern[] = [
	{ kind: "anthropic", regex: /sk-ant-[A-Za-z0-9_-]{20,}/g },
	{ kind: "llamacloud", regex: /llx-[A-Za-z0-9_-]{20,}/g },
	// Covers all three official OpenAI key shapes: legacy `sk-…`, project `sk-proj-…`,
	// and admin `sk-admin-…`. Hyphens and underscores appear inside real project keys
	// so the remainder class must allow them. `sk-ant-` is matched earlier by the
	// anthropic pattern and already replaced by the time this runs.
	{ kind: "openai", regex: /sk-(?:proj-|admin-)?[A-Za-z0-9_-]{20,}/g },
	{ kind: "aws-access-key", regex: /\b(?:AKIA|ASIA|AROA)[0-9A-Z]{16}\b/g },
	{ kind: "github-token", regex: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g },
	{ kind: "slack-token", regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
	{ kind: "google-api-key", regex: /\bAIza[0-9A-Za-z_-]{35}\b/g },
	{
		kind: "pem-private-key",
		regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
	},
];

export function redactSecrets(input: string): string {
	// Short-circuit: skip regex work on strings with no plausible secret markers.
	// Cheap heuristic — if none of these substrings are present, no pattern can match.
	if (
		!input.includes("sk-") &&
		!input.includes("llx-") &&
		!input.includes("AKIA") &&
		!input.includes("ASIA") &&
		!input.includes("AROA") &&
		!input.includes("gh") &&
		!input.includes("xox") &&
		!input.includes("AIza") &&
		!input.includes("PRIVATE KEY")
	) {
		return input;
	}

	let out = input;
	for (const { kind, regex } of PATTERNS) {
		out = out.replace(regex, `[REDACTED:${kind}]`);
	}
	return out;
}
