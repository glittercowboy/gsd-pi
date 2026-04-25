/**
 * Layer 0 shell-hook runner.
 *
 * Bridges the Layer 2 extension event bus to user-configured shell commands
 * declared in `settings.json` under the `hooks` key. Each hook entry receives
 * the event payload as JSON on stdin and can mutate the pending action by
 * writing a JSON response to stdout.
 *
 * Trust model: hooks loaded from project-scoped settings are dropped unless
 * the user has opted in by creating `.pi/hooks.trusted` in the project root.
 * This prevents a cloned repository from executing arbitrary shell commands.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME } from "../config.js";
import type { ExtensionRunner } from "./extensions/runner.js";
import type {
	BeforeCommitEventResult,
	BeforePrEventResult,
	BeforePushEventResult,
	BeforeVerifyEventResult,
	BudgetThresholdEventResult,
	CommitEvent,
	InputEventResult,
	NotificationEvent,
	PrOpenedEvent,
	PushEvent,
	SessionEndEvent,
	SessionStartEvent,
	StopEvent,
	ToolCallEvent,
	ToolCallEventResult,
	ToolResultEvent,
	ToolResultEventResult,
	BeforeCommitEvent,
	BeforePrEvent,
	BeforePushEvent,
	BeforeVerifyEvent,
	BudgetThresholdEvent,
	InputEvent,
	MilestoneEndEvent,
	MilestoneStartEvent,
	SessionBeforeCompactEvent,
	SessionBeforeCompactResult,
	SessionCompactEvent,
	UnitEndEvent,
	UnitStartEvent,
	VerifyResultEvent,
} from "./extensions/types.js";
import type { HookEntry, HooksSettings, Settings } from "./settings-manager.js";

const TRUST_MARKER = "hooks.trusted";
const DEFAULT_TIMEOUT_MS = 30_000;

export type HookName = keyof HooksSettings;
export type HookScope = "global" | "project";

interface ScopedHook extends HookEntry {
	scope: HookScope;
}

export interface HookStdoutResult {
	block?: boolean;
	reason?: string;
	message?: string;
	title?: string;
	body?: string;
	action?: "pause" | "downgrade" | "continue";
}

export interface HookInvocation {
	name: HookName;
	scope: HookScope;
	command: string;
	exitCode: number;
	stdout: string;
	stderr: string;
	durationMs: number;
	timedOut: boolean;
	parsed?: HookStdoutResult;
}

export function isProjectHooksTrusted(cwd: string): boolean {
	return existsSync(join(cwd, CONFIG_DIR_NAME, TRUST_MARKER));
}

function collectHooks(
	name: HookName,
	globalSettings: Settings,
	projectSettings: Settings,
	cwd: string,
): ScopedHook[] {
	const result: ScopedHook[] = [];
	for (const entry of globalSettings.hooks?.[name] ?? []) {
		result.push({ ...entry, scope: "global" });
	}
	if (projectSettings.hooks?.[name]?.length && isProjectHooksTrusted(cwd)) {
		for (const entry of projectSettings.hooks[name] ?? []) {
			result.push({ ...entry, scope: "project" });
		}
	}
	return result;
}

function matchesFilter(entry: HookEntry, payload: Record<string, unknown>): boolean {
	const filter = entry.match;
	if (!filter) return true;

	if (filter.tool !== undefined) {
		const names = Array.isArray(filter.tool) ? filter.tool : [filter.tool];
		const toolName = payload.toolName ?? (payload as { tool?: string }).tool;
		if (typeof toolName !== "string" || !names.includes(toolName)) return false;
	}

	if (filter.command !== undefined) {
		const cmd = (payload.input as { command?: unknown } | undefined)?.command
			?? (payload as { command?: unknown }).command;
		if (typeof cmd !== "string" || !cmd.startsWith(filter.command)) return false;
	}

	return true;
}

async function runOne(
	name: HookName,
	hook: ScopedHook,
	payload: unknown,
	cwd: string,
): Promise<HookInvocation> {
	const timeout = hook.timeout ?? DEFAULT_TIMEOUT_MS;
	const startedAt = Date.now();

	return new Promise((resolve) => {
		const child = spawn(hook.command, {
			cwd,
			shell: true,
			stdio: ["pipe", "pipe", "pipe"],
			env: { ...process.env, ...hook.env, GSD_HOOK_EVENT: name, GSD_HOOK_SCOPE: hook.scope },
		});

		let stdout = "";
		let stderr = "";
		let timedOut = false;

		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGTERM");
			setTimeout(() => {
				if (child.exitCode === null) child.kill("SIGKILL");
			}, 2_000);
		}, timeout);

		child.stdout.on("data", (d) => { stdout += d.toString(); });
		child.stderr.on("data", (d) => { stderr += d.toString(); });

		child.on("error", (err) => {
			clearTimeout(timer);
			resolve({
				name,
				scope: hook.scope,
				command: hook.command,
				exitCode: 1,
				stdout,
				stderr: stderr || String(err),
				durationMs: Date.now() - startedAt,
				timedOut: false,
			});
		});

		child.on("close", (code) => {
			clearTimeout(timer);
			let parsed: HookStdoutResult | undefined;
			const trimmed = stdout.trim();
			if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
				try { parsed = JSON.parse(trimmed) as HookStdoutResult; } catch { /* tolerate non-JSON stdout */ }
			}
			resolve({
				name,
				scope: hook.scope,
				command: hook.command,
				exitCode: code ?? -1,
				stdout,
				stderr,
				durationMs: Date.now() - startedAt,
				timedOut,
				parsed,
			});
		});

		// Silence EPIPE if the child exits before consuming stdin.
		child.stdin.on("error", () => { /* no-op */ });
		try {
			child.stdin.write(JSON.stringify(payload), () => {
				try { child.stdin.end(); } catch { /* ignore */ }
			});
		} catch { /* child may have already exited */ }
	});
}

async function runChain(
	name: HookName,
	payload: Record<string, unknown>,
	hooks: ScopedHook[],
	cwd: string,
	onInvocation?: (i: HookInvocation) => void,
): Promise<HookStdoutResult | undefined> {
	let merged: HookStdoutResult | undefined;
	for (const hook of hooks) {
		if (!matchesFilter(hook, payload)) continue;
		const invocation = await runOne(name, hook, payload, cwd);
		onInvocation?.(invocation);

		if (invocation.exitCode !== 0 && hook.blocking !== false) {
			const reason = invocation.parsed?.reason
				?? (invocation.stderr.trim()
					|| `Hook ${hook.command} exited with code ${invocation.exitCode}`);
			return { ...(merged ?? {}), block: true, reason };
		}

		if (invocation.parsed) {
			if (invocation.parsed.block) return { ...(merged ?? {}), ...invocation.parsed };
			merged = { ...(merged ?? {}), ...invocation.parsed };
		}
	}
	return merged;
}

// ─── Public API ────────────────────────────────────────────────────────────

export interface HooksRunnerOptions {
	extensionRunner: ExtensionRunner;
	getGlobalSettings: () => Settings;
	getProjectSettings: () => Settings;
	cwd: string;
	onInvocation?: (invocation: HookInvocation) => void;
}

export interface HooksRunner {
	dispose(): void;
	/** Fire SessionStart once during bootstrap. */
	fireSessionStart(): Promise<void>;
	/** Fire SessionEnd during session teardown. */
	fireSessionEnd(reason: SessionEndEvent["reason"]): Promise<void>;
}

type HandlerFn = (event: unknown, ctx: unknown) => Promise<unknown>;

export function createHooksRunner(options: HooksRunnerOptions): HooksRunner {
	const { extensionRunner, cwd, onInvocation } = options;

	const dispatch = async (name: HookName, payload: Record<string, unknown>) => {
		const hooks = collectHooks(
			name,
			options.getGlobalSettings(),
			options.getProjectSettings(),
			cwd,
		);
		if (hooks.length === 0) return undefined;
		return runChain(name, payload, hooks, cwd, onInvocation);
	};

	const handlers = new Map<string, HandlerFn[]>();

	handlers.set("input", [async (event: unknown): Promise<InputEventResult | undefined> => {
		const e = event as InputEvent;
		const result = await dispatch("UserPromptSubmit", { text: e.text, source: e.source });
		if (result?.block) return { action: "handled" };
		return undefined;
	}]);

	handlers.set("tool_call", [async (event: unknown): Promise<ToolCallEventResult | undefined> => {
		const e = event as ToolCallEvent;
		const result = await dispatch("PreToolUse", {
			toolCallId: e.toolCallId,
			toolName: e.toolName,
			input: e.input,
		});
		if (result?.block) return { block: true, reason: result.reason };
		return undefined;
	}]);

	handlers.set("tool_result", [async (event: unknown): Promise<ToolResultEventResult | undefined> => {
		const e = event as ToolResultEvent;
		await dispatch("PostToolUse", {
			toolCallId: e.toolCallId,
			toolName: e.toolName,
			input: e.input,
			content: e.content,
			isError: e.isError,
			details: e.details,
		});
		return undefined;
	}]);

	handlers.set("stop", [async (event: unknown) => {
		const e = event as StopEvent;
		await dispatch("Stop", { reason: e.reason });
		return undefined;
	}]);

	handlers.set("notification", [async (event: unknown) => {
		const e = event as NotificationEvent;
		await dispatch("Notification", { kind: e.kind, message: e.message, details: e.details });
		if (e.kind === "blocked") {
			await dispatch("Blocked", { message: e.message, details: e.details });
		}
		return undefined;
	}]);

	handlers.set("session_end", [async (event: unknown) => {
		const e = event as SessionEndEvent;
		await dispatch("SessionEnd", { reason: e.reason, sessionFile: e.sessionFile });
		return undefined;
	}]);

	handlers.set("before_commit", [async (event: unknown): Promise<BeforeCommitEventResult | undefined> => {
		const e = event as BeforeCommitEvent;
		const result = await dispatch("PreCommit", { message: e.message, files: e.files, cwd: e.cwd, author: e.author });
		if (!result) return undefined;
		if (result.block) return { cancel: true, reason: result.reason };
		if (result.message !== undefined) return { message: result.message };
		return undefined;
	}]);

	handlers.set("commit", [async (event: unknown) => {
		const e = event as CommitEvent;
		await dispatch("PostCommit", { sha: e.sha, message: e.message, files: e.files, cwd: e.cwd });
		return undefined;
	}]);

	handlers.set("before_push", [async (event: unknown): Promise<BeforePushEventResult | undefined> => {
		const e = event as BeforePushEvent;
		const result = await dispatch("PrePush", { remote: e.remote, branch: e.branch, cwd: e.cwd });
		if (result?.block) return { cancel: true, reason: result.reason };
		return undefined;
	}]);

	handlers.set("push", [async (event: unknown) => {
		const e = event as PushEvent;
		await dispatch("PostPush", { remote: e.remote, branch: e.branch, cwd: e.cwd });
		return undefined;
	}]);

	handlers.set("before_pr", [async (event: unknown): Promise<BeforePrEventResult | undefined> => {
		const e = event as BeforePrEvent;
		const result = await dispatch("PrePr", {
			branch: e.branch,
			targetBranch: e.targetBranch,
			title: e.title,
			body: e.body,
			cwd: e.cwd,
		});
		if (!result) return undefined;
		if (result.block) return { cancel: true, reason: result.reason };
		if (result.title !== undefined || result.body !== undefined) {
			return { title: result.title, body: result.body };
		}
		return undefined;
	}]);

	handlers.set("pr_opened", [async (event: unknown) => {
		const e = event as PrOpenedEvent;
		await dispatch("PostPr", { url: e.url, branch: e.branch, targetBranch: e.targetBranch, cwd: e.cwd });
		return undefined;
	}]);

	handlers.set("before_verify", [async (event: unknown): Promise<BeforeVerifyEventResult | undefined> => {
		const e = event as BeforeVerifyEvent;
		const result = await dispatch("PreVerify", { unitType: e.unitType, unitId: e.unitId, cwd: e.cwd });
		if (result?.block) return { cancel: true, reason: result.reason };
		return undefined;
	}]);

	handlers.set("verify_result", [async (event: unknown) => {
		const e = event as VerifyResultEvent;
		await dispatch("PostVerify", {
			passed: e.passed,
			failures: e.failures,
			unitType: e.unitType,
			unitId: e.unitId,
			cwd: e.cwd,
		});
		return undefined;
	}]);

	handlers.set("budget_threshold", [async (event: unknown): Promise<BudgetThresholdEventResult | undefined> => {
		const e = event as BudgetThresholdEvent;
		const result = await dispatch("BudgetThreshold", {
			fraction: e.fraction,
			spent: e.spent,
			limit: e.limit,
			currency: e.currency,
		});
		if (result?.action) return { action: result.action };
		return undefined;
	}]);

	handlers.set("milestone_start", [async (event: unknown) => {
		const e = event as MilestoneStartEvent;
		await dispatch("PreMilestone", { milestoneId: e.milestoneId, title: e.title, cwd: e.cwd });
		return undefined;
	}]);

	handlers.set("milestone_end", [async (event: unknown) => {
		const e = event as MilestoneEndEvent;
		await dispatch("PostMilestone", { milestoneId: e.milestoneId, status: e.status, cwd: e.cwd });
		return undefined;
	}]);

	handlers.set("unit_start", [async (event: unknown) => {
		const e = event as UnitStartEvent;
		await dispatch("PreUnit", {
			unitType: e.unitType,
			unitId: e.unitId,
			milestoneId: e.milestoneId,
			cwd: e.cwd,
		});
		return undefined;
	}]);

	handlers.set("unit_end", [async (event: unknown) => {
		const e = event as UnitEndEvent;
		await dispatch("PostUnit", {
			unitType: e.unitType,
			unitId: e.unitId,
			milestoneId: e.milestoneId,
			status: e.status,
			cwd: e.cwd,
		});
		return undefined;
	}]);

	handlers.set("session_before_compact", [async (event: unknown): Promise<SessionBeforeCompactResult | undefined> => {
		const e = event as SessionBeforeCompactEvent;
		const result = await dispatch("PreCompact", { branchEntries: e.branchEntries.length });
		if (result?.block) return { cancel: true };
		return undefined;
	}]);

	handlers.set("session_compact", [async (event: unknown) => {
		const e = event as SessionCompactEvent;
		await dispatch("PostCompact", { fromExtension: e.fromExtension });
		return undefined;
	}]);

	const dispose = extensionRunner.installHookBridge("__hooks__", handlers);

	return {
		dispose,
		async fireSessionStart() {
			const payload: SessionStartEvent = { type: "session_start" };
			await dispatch("SessionStart", { cwd, type: payload.type });
		},
		async fireSessionEnd(reason) {
			await dispatch("SessionEnd", { reason });
		},
	};
}
