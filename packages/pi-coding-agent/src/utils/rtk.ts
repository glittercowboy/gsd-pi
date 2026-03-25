import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

const GSD_RTK_PATH_ENV = "GSD_RTK_PATH";
const GSD_RTK_DISABLED_ENV = "GSD_RTK_DISABLED";
const RTK_TELEMETRY_DISABLED_ENV = "RTK_TELEMETRY_DISABLED";
const RTK_REWRITE_TIMEOUT_MS = 5_000;

function isTruthy(value: string | undefined): boolean {
	if (!value) return false;
	const normalized = value.trim().toLowerCase();
	return normalized === "1" || normalized === "true" || normalized === "yes";
}

function buildEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	return {
		...env,
		[RTK_TELEMETRY_DISABLED_ENV]: "1",
	};
}

export interface RewriteCommandForGsdOptions {
	binaryPath?: string;
	env?: NodeJS.ProcessEnv;
	spawnSyncImpl?: typeof spawnSync;
	timeoutMs?: number;
}

export function rewriteCommandForGsd(command: string, options: RewriteCommandForGsdOptions = {}): string {
	if (!command.trim()) return command;
	const env = options.env ?? process.env;
	if (isTruthy(env[GSD_RTK_DISABLED_ENV])) return command;

	const binaryPath = options.binaryPath ?? env[GSD_RTK_PATH_ENV];
	if (!binaryPath || !existsSync(binaryPath)) return command;

	const run = options.spawnSyncImpl ?? spawnSync;
	const result = run(binaryPath, ["rewrite", command], {
		encoding: "utf-8",
		env: buildEnv(env),
		stdio: ["ignore", "pipe", "ignore"],
		timeout: options.timeoutMs ?? RTK_REWRITE_TIMEOUT_MS,
	});

	if (result.error) return command;
	if (result.status !== 0 && result.status !== 3) return command;

	const rewritten = (result.stdout ?? "").trimEnd();
	return rewritten || command;
}
