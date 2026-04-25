/**
 * Gemini CLI OAuth flow (Google Cloud Code Assist)
 * Standard Gemini models only (gemini-2.0-flash, gemini-2.5-*)
 *
 * NOTE: This module uses Node.js http.createServer for the OAuth callback.
 * It is only intended for CLI use, not browser environments.
 */

import {
	type CallbackServerInfo,
	getGoogleUserEmail,
	parseRedirectUrl,
	refreshGoogleOAuthToken,
	startCallbackServer,
} from "./google-oauth-utils.js";
import { generatePKCE } from "./pkce.js";
import type { OAuthCredentials, OAuthLoginCallbacks, OAuthProviderInterface } from "./types.js";

type GeminiCredentials = OAuthCredentials & {
	projectId: string;
};

// Gemini CLI OAuth credentials (Google Cloud Code Assist)
//
// NOTE: These credentials are public in the source code. They should NOT be
// obfuscated because security scanners flag obfuscated data as potentially
// malicious (see: https://socket.dev/npm/package/gsd-pi/alerts/2.70.1?alert_name=obfuscatedFile)
//
// Google's OAuth implementation requires client_secret for Desktop App OAuth
// clients even though it cannot be kept secret in distributed applications.
// The actual security relies on:
// - PKCE (Proof Key for Code Exchange) via code_verifier
// - Redirect URI validation (localhost only)
// - User consent and token scope limits
//
// See: https://developers.google.com/identity/protocols/oauth2/native-app
const CLIENT_ID = "681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com";
const CLIENT_SECRET = "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";
const REDIRECT_URI = "http://localhost:8085/oauth2callback";
const SCOPES = [
	"https://www.googleapis.com/auth/cloud-platform",
	"https://www.googleapis.com/auth/userinfo.email",
	"https://www.googleapis.com/auth/userinfo.profile",
];
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const CODE_ASSIST_ENDPOINT = "https://cloudcode-pa.googleapis.com";

// Callback server configuration
const CALLBACK_PORT = 8085;
const CALLBACK_PATH = "/oauth2callback";

interface LoadCodeAssistPayload {
	cloudaicompanionProject?: string;
	currentTier?: { id?: string };
	allowedTiers?: Array<{ id?: string; isDefault?: boolean }>;
}

/**
 * Long-running operation response from onboardUser
 */
interface LongRunningOperationResponse {
	name?: string;
	done?: boolean;
	response?: {
		cloudaicompanionProject?: { id?: string };
	};
}

// Tier IDs as used by the Cloud Code API
const TIER_FREE = "free-tier";
const TIER_LEGACY = "legacy-tier";
const TIER_STANDARD = "standard-tier";

interface GoogleRpcErrorResponse {
	error?: {
		details?: Array<{ reason?: string }>;
	};
}

/**
 * Wait helper for onboarding retries
 */
function wait(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Get default tier from allowed tiers
 */
function getDefaultTier(allowedTiers?: Array<{ id?: string; isDefault?: boolean }>): { id?: string } {
	if (!allowedTiers || allowedTiers.length === 0) return { id: TIER_LEGACY };
	const defaultTier = allowedTiers.find((t) => t.isDefault);
	return defaultTier ?? { id: TIER_LEGACY };
}

function isVpcScAffectedUser(payload: unknown): boolean {
	if (!payload || typeof payload !== "object") return false;
	if (!("error" in payload)) return false;
	const error = (payload as GoogleRpcErrorResponse).error;
	if (!error?.details || !Array.isArray(error.details)) return false;
	return error.details.some((detail) => detail.reason === "SECURITY_POLICY_VIOLATED");
}

/**
 * Poll a long-running operation until completion
 */
async function pollOperation(
	operationName: string,
	headers: Record<string, string>,
	onProgress?: (message: string) => void,
): Promise<LongRunningOperationResponse> {
	let attempt = 0;
	while (true) {
		if (attempt > 0) {
			onProgress?.(`Waiting for project provisioning (attempt ${attempt + 1})...`);
			await wait(5000);
		}

		const response = await fetch(`${CODE_ASSIST_ENDPOINT}/v1internal/${operationName}`, {
			method: "GET",
			headers,
			signal: AbortSignal.timeout(30_000),
		});

		if (!response.ok) {
			throw new Error(`Failed to poll operation: ${response.status} ${response.statusText}`);
		}

		const data = (await response.json()) as LongRunningOperationResponse;
		if (data.done) {
			return data;
		}

		attempt += 1;
	}
}

/**
 * Discover or provision a Google Cloud project for the user
 */
async function discoverProject(accessToken: string, onProgress?: (message: string) => void): Promise<string> {
	// Check for user-provided project ID via environment variable
	const envProjectId = process.env.GOOGLE_CLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT_ID;

	const headers = {
		Authorization: `Bearer ${accessToken}`,
		"Content-Type": "application/json",
		"User-Agent": "google-api-nodejs-client/9.15.1",
		"X-Goog-Api-Client": "gl-node/22.17.0",
	};

	// Try to load existing project via loadCodeAssist
	onProgress?.("Checking for existing Cloud Code Assist project...");
	const loadResponse = await fetch(`${CODE_ASSIST_ENDPOINT}/v1internal:loadCodeAssist`, {
		method: "POST",
		headers,
		body: JSON.stringify({
			cloudaicompanionProject: envProjectId,
			metadata: {
				ideType: "IDE_UNSPECIFIED",
				platform: "PLATFORM_UNSPECIFIED",
				pluginType: "GEMINI",
				duetProject: envProjectId,
			},
		}),
		signal: AbortSignal.timeout(30_000),
	});

	let data: LoadCodeAssistPayload;

	if (!loadResponse.ok) {
		let errorPayload: unknown;
		try {
			errorPayload = await loadResponse.clone().json();
		} catch {
			errorPayload = undefined;
		}

		if (isVpcScAffectedUser(errorPayload)) {
			data = { currentTier: { id: TIER_STANDARD } };
		} else {
			const errorText = await loadResponse.text();
			throw new Error(`loadCodeAssist failed: ${loadResponse.status} ${loadResponse.statusText}: ${errorText}`);
		}
	} else {
		data = (await loadResponse.json()) as LoadCodeAssistPayload;
	}

	// If user already has a current tier and project, use it
	if (data.currentTier) {
		if (data.cloudaicompanionProject) {
			return data.cloudaicompanionProject;
		}
		// User has a tier but no managed project - they need to provide one via env var
		if (envProjectId) {
			return envProjectId;
		}
		throw new Error(
			"This account requires setting the GOOGLE_CLOUD_PROJECT or GOOGLE_CLOUD_PROJECT_ID environment variable. " +
				"See https://goo.gle/gemini-cli-auth-docs#workspace-gca",
		);
	}

	// User needs to be onboarded - get the default tier
	const tier = getDefaultTier(data.allowedTiers);
	const tierId = tier?.id ?? TIER_FREE;

	if (tierId !== TIER_FREE && !envProjectId) {
		throw new Error(
			"This account requires setting the GOOGLE_CLOUD_PROJECT or GOOGLE_CLOUD_PROJECT_ID environment variable. " +
				"See https://goo.gle/gemini-cli-auth-docs#workspace-gca",
		);
	}

	onProgress?.("Provisioning Cloud Code Assist project (this may take a moment)...");

	// Build onboard request - for free tier, don't include project ID (Google provisions one)
	// For other tiers, include the user's project ID if available
	const onboardBody: Record<string, unknown> = {
		tierId,
		metadata: {
			ideType: "IDE_UNSPECIFIED",
			platform: "PLATFORM_UNSPECIFIED",
			pluginType: "GEMINI",
		},
	};

	if (tierId !== TIER_FREE && envProjectId) {
		onboardBody.cloudaicompanionProject = envProjectId;
		(onboardBody.metadata as Record<string, unknown>).duetProject = envProjectId;
	}

	// Start onboarding - this returns a long-running operation
	const onboardResponse = await fetch(`${CODE_ASSIST_ENDPOINT}/v1internal:onboardUser`, {
		method: "POST",
		headers,
		body: JSON.stringify(onboardBody),
		signal: AbortSignal.timeout(30_000),
	});

	if (!onboardResponse.ok) {
		const errorText = await onboardResponse.text();
		throw new Error(`onboardUser failed: ${onboardResponse.status} ${onboardResponse.statusText}: ${errorText}`);
	}

	let lroData = (await onboardResponse.json()) as LongRunningOperationResponse;

	// If the operation isn't done yet, poll until completion
	if (!lroData.done && lroData.name) {
		lroData = await pollOperation(lroData.name, headers, onProgress);
	}

	// Try to get project ID from the response
	const projectId = lroData.response?.cloudaicompanionProject?.id;
	if (projectId) {
		return projectId;
	}

	// If no project ID from onboarding, fall back to env var
	if (envProjectId) {
		return envProjectId;
	}

	throw new Error(
		"Could not discover or provision a Google Cloud project. " +
			"Try setting the GOOGLE_CLOUD_PROJECT or GOOGLE_CLOUD_PROJECT_ID environment variable. " +
			"See https://goo.gle/gemini-cli-auth-docs#workspace-gca",
	);
}

/**
 * Refresh Google Cloud Code Assist token
 */
export async function refreshGoogleCloudToken(refreshToken: string, projectId: string): Promise<OAuthCredentials> {
	return refreshGoogleOAuthToken(refreshToken, CLIENT_ID, CLIENT_SECRET, "Google Cloud", { projectId });
}

/**
 * Login with Gemini CLI (Google Cloud Code Assist) OAuth
 *
 * @param onAuth - Callback with URL and optional instructions
 * @param onProgress - Optional progress callback
 * @param onManualCodeInput - Optional promise that resolves with user-pasted redirect URL.
 *                            Races with browser callback - whichever completes first wins.
 */
export async function loginGeminiCli(
	onAuth: (info: { url: string; instructions?: string }) => void,
	onProgress?: (message: string) => void,
	onManualCodeInput?: () => Promise<string>,
): Promise<OAuthCredentials> {
	const { verifier, challenge } = await generatePKCE();

	// Start local server for callback
	onProgress?.("Starting local server for OAuth callback...");
	const server: CallbackServerInfo = await startCallbackServer(CALLBACK_PORT, CALLBACK_PATH, "Gemini CLI");

	let code: string | undefined;

	try {
		// Build authorization URL
		const authParams = new URLSearchParams({
			client_id: CLIENT_ID,
			response_type: "code",
			redirect_uri: REDIRECT_URI,
			scope: SCOPES.join(" "),
			code_challenge: challenge,
			code_challenge_method: "S256",
			state: verifier,
			access_type: "offline",
			prompt: "consent",
		});

		const authUrl = `${AUTH_URL}?${authParams.toString()}`;

		// Notify caller with URL to open
		onAuth({
			url: authUrl,
			instructions: "Complete the sign-in in your browser.",
		});

		// Wait for the callback, racing with manual input if provided
		onProgress?.("Waiting for OAuth callback...");

		if (onManualCodeInput) {
			// Race between browser callback and manual input
			let manualInput: string | undefined;
			let manualError: Error | undefined;
			const manualPromise = onManualCodeInput()
				.then((input) => {
					manualInput = input;
					server.cancelWait();
				})
				.catch((err) => {
					manualError = err instanceof Error ? err : new Error(String(err));
					server.cancelWait();
				});

			const result = await server.waitForCode();

			// If manual input was cancelled, throw that error
			if (manualError) {
				throw manualError;
			}

			if (result?.code) {
				// Browser callback won - verify state
				if (result.state !== verifier) {
					throw new Error("OAuth state mismatch - possible CSRF attack");
				}
				code = result.code;
			} else if (manualInput) {
				// Manual input won
				const parsed = parseRedirectUrl(manualInput);
				if (parsed.state && parsed.state !== verifier) {
					throw new Error("OAuth state mismatch - possible CSRF attack");
				}
				code = parsed.code;
			}

			// If still no code, wait for manual promise and try that
			if (!code) {
				await manualPromise;
				if (manualError) {
					throw manualError;
				}
				if (manualInput) {
					const parsed = parseRedirectUrl(manualInput);
					if (parsed.state && parsed.state !== verifier) {
						throw new Error("OAuth state mismatch - possible CSRF attack");
					}
					code = parsed.code;
				}
			}
		} else {
			// Original flow: just wait for callback
			const result = await server.waitForCode();
			if (result?.code) {
				if (result.state !== verifier) {
					throw new Error("OAuth state mismatch - possible CSRF attack");
				}
				code = result.code;
			}
		}

		if (!code) {
			throw new Error("No authorization code received");
		}

		// Exchange code for tokens
		onProgress?.("Exchanging authorization code for tokens...");
		const tokenResponse = await fetch(TOKEN_URL, {
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
			},
			body: new URLSearchParams({
				client_id: CLIENT_ID,
				client_secret: CLIENT_SECRET,
				code,
				grant_type: "authorization_code",
				redirect_uri: REDIRECT_URI,
				code_verifier: verifier,
			}),
			signal: AbortSignal.timeout(30_000),
		});

		if (!tokenResponse.ok) {
			const error = await tokenResponse.text();
			throw new Error(`Token exchange failed: ${error}`);
		}

		const tokenData = (await tokenResponse.json()) as {
			access_token: string;
			refresh_token: string;
			expires_in: number;
		};

		if (!tokenData.refresh_token) {
			throw new Error("No refresh token received. Please try again.");
		}

		// Get user email
		onProgress?.("Getting user info...");
		const email = await getGoogleUserEmail(tokenData.access_token);

		// Discover project
		const projectId = await discoverProject(tokenData.access_token, onProgress);

		// Calculate expiry time (current time + expires_in seconds - 5 min buffer)
		const expiresAt = Date.now() + tokenData.expires_in * 1000 - 5 * 60 * 1000;

		const credentials: OAuthCredentials = {
			refresh: tokenData.refresh_token,
			access: tokenData.access_token,
			expires: expiresAt,
			projectId,
			email,
		};

		return credentials;
	} finally {
		server.server.close();
	}
}

export const geminiCliOAuthProvider: OAuthProviderInterface = {
	id: "google-gemini-cli",
	name: "Google Cloud Code Assist (Gemini CLI)",
	usesCallbackServer: true,

	async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
		return loginGeminiCli(callbacks.onAuth, callbacks.onProgress, callbacks.onManualCodeInput);
	},

	async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
		const creds = credentials as GeminiCredentials;
		if (!creds.projectId) {
			throw new Error("Google Cloud credentials missing projectId");
		}
		return refreshGoogleCloudToken(creds.refresh, creds.projectId);
	},

	getApiKey(credentials: OAuthCredentials): string {
		const creds = credentials as GeminiCredentials;
		return JSON.stringify({ token: creds.access, projectId: creds.projectId });
	},
};
