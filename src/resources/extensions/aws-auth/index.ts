/**
 * AWS Auth Refresh Extension
 *
 * Automatically refreshes AWS credentials when Bedrock API requests fail
 * with authentication/token errors, then retries the user's message.
 *
 * ## How it works
 *
 * Hooks into `agent_end` to check if the last assistant message failed with
 * an AWS auth error (expired SSO token, missing credentials, etc.). If so:
 *
 *   1. Runs the configured `awsAuthRefresh` command (e.g. `aws sso login`)
 *   2. Streams the SSO auth URL and verification code to the TUI so users
 *      can copy/paste if the browser doesn't auto-open
 *   3. Calls `retryLastTurn()` which removes the failed assistant response
 *      and re-runs the agent from the user's original message
 *
 * ## Activation
 *
 * This extension is completely inert unless BOTH conditions are met:
 *   1. A Bedrock API request fails with a recognized AWS auth error
 *   2. `awsAuthRefresh` is configured in settings.json
 *
 * Non-Bedrock users and Bedrock users without `awsAuthRefresh` configured
 * are not affected in any way.
 *
 * ## Setup
 *
 * Add to ~/.gsd/agent/settings.json (or project-level .gsd/settings.json):
 *
 *   { "awsAuthRefresh": "aws sso login --profile my-profile" }
 *
 * ## Matched error patterns
 *
 * The extension recognizes errors from the AWS SDK, Bedrock, and SSO
 * credential providers including:
 *   - ExpiredTokenException / ExpiredToken
 *   - The security token included in the request is expired
 *   - The SSO session associated with this profile has expired or is invalid
 *   - Unable to locate credentials / Could not load credentials
 *   - UnrecognizedClientException
 *   - Error loading SSO Token / Token does not exist
 *   - SSOTokenProviderFailure
 */

import { exec } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ExtensionAPI } from "@gsd/pi-coding-agent";

/** Matches AWS SDK / Bedrock / SSO credential and token errors. */
const AWS_AUTH_ERROR_RE =
	/ExpiredToken|security token.*expired|unable to locate credentials|SSO.*(?:session|token).*(?:expired|not found|invalid)|UnrecognizedClient|Could not load credentials|Invalid identity token|token is expired|credentials.*(?:could not|cannot|failed to).*(?:load|resolve|find)|The.*token.*is.*not.*valid|token has expired|SSOTokenProviderFailure|Error loading SSO Token|Token.*does not exist/i;

/**
 * Reads the `awsAuthRefresh` command from settings.json.
 * Checks project-level first, then global (~/.gsd/agent/settings.json).
 */
function getAwsAuthRefreshCommand(): string | undefined {
	const configDir = process.env.PI_CONFIG_DIR || ".gsd";
	const paths = [
		join(process.cwd(), configDir, "settings.json"),
		join(homedir(), configDir, "agent", "settings.json"),
	];
	for (const settingsPath of paths) {
		if (!existsSync(settingsPath)) continue;
		try {
			const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
			if (settings.awsAuthRefresh) return settings.awsAuthRefresh;
		} catch {}
	}
	return undefined;
}

/**
 * Runs the refresh command with a 2-minute timeout (for SSO browser flows).
 * Streams stdout/stderr to capture and display the SSO auth URL and
 * verification code in real-time via TUI notifications.
 */
async function runRefresh(
	command: string,
	notify: (msg: string, level: "info" | "warning" | "error") => void,
): Promise<boolean> {
	notify("Refreshing AWS credentials...", "info");
	try {
		await new Promise<void>((resolve, reject) => {
			const child = exec(command, { timeout: 120_000, env: { ...process.env } });
			const onData = (data: Buffer | string) => {
				const text = data.toString();
				const urlMatch = text.match(/https?:\/\/\S+/);
				if (urlMatch) {
					notify(`Open this URL if the browser didn't launch: ${urlMatch[0]}`, "warning");
				}
				const codeMatch = text.match(/code[:\s]+([A-Z]{4}-[A-Z]{4})/i);
				if (codeMatch) {
					notify(`Verification code: ${codeMatch[1]}`, "info");
				}
			};
			child.stdout?.on("data", onData);
			child.stderr?.on("data", onData);
			child.on("close", (code) => {
				if (code === 0) resolve();
				else reject(new Error(`Refresh command exited with code ${code}`));
			});
			child.on("error", reject);
		});
		notify("AWS credentials refreshed successfully ✓", "info");
		return true;
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		const isTimeout = /timed out|ETIMEDOUT|killed/i.test(msg);
		if (isTimeout) {
			notify("AWS credential refresh timed out. The SSO login may have been cancelled or the browser window was closed.", "error");
		} else {
			notify(`AWS credential refresh failed: ${msg}`, "error");
		}
		return false;
	}
}

export default function (pi: ExtensionAPI) {
	pi.on("agent_end", async (event, ctx) => {
		const refreshCommand = getAwsAuthRefreshCommand();
		if (!refreshCommand) return;

		const messages = event.messages;
		const lastAssistant = messages[messages.length - 1];
		if (
			!lastAssistant ||
			lastAssistant.role !== "assistant" ||
			!("errorMessage" in lastAssistant) ||
			!lastAssistant.errorMessage ||
			!AWS_AUTH_ERROR_RE.test(lastAssistant.errorMessage)
		) {
			return;
		}

		const refreshed = await runRefresh(refreshCommand, (m, level) => ctx.ui.notify(m, level));
		if (!refreshed) return;

		pi.retryLastTurn();
	});
}
