/**
 * Credential storage for API keys and OAuth tokens.
 * Handles loading, saving, and refreshing credentials from auth.json.
 *
 * Supports multiple credentials per provider with round-robin selection,
 * session-sticky hashing, and automatic rate-limit fallback.
 *
 * Uses file locking to prevent race conditions when multiple pi instances
 * try to refresh tokens simultaneously.
 */

import {
	getEnvApiKey,
	type OAuthCredentials,
	type OAuthLoginCallbacks,
	type OAuthProviderId,
} from "@gsd/pi-ai";
import { getOAuthApiKey, getOAuthProvider, getOAuthProviders } from "@gsd/pi-ai/oauth";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { getAgentDir } from "../config.js";
import { AUTH_LOCK_STALE_MS } from "./constants.js";
import { acquireLockAsync, acquireLockSyncWithRetry } from "./lock-utils.js";
import { resolveConfigValue } from "./resolve-config-value.js";

export type ApiKeyCredential = {
	type: "api_key";
	key: string;
};

export type OAuthCredential = {
	type: "oauth";
} & OAuthCredentials;

export type AuthCredential = ApiKeyCredential | OAuthCredential;

// ============================================================================
// Google OAuth token detection
// ============================================================================

/**
 * Providers that use Google AI Studio API keys (not OAuth tokens).
 * OAuth access tokens (ya29.*) are not valid API keys for these providers.
 */
const GOOGLE_API_KEY_PROVIDERS = new Set(["google"]);

/**
 * Detect if a string is a Google OAuth access token rather than an API key.
 * Google OAuth access tokens start with "ya29." — these are issued by
 * Google's OAuth2 token endpoint and are not valid as AI Studio API keys.
 *
 * Users who installed Google's Gemini CLI may have these tokens and
 * mistakenly set them as GEMINI_API_KEY.
 */
export function isGoogleOAuthToken(key: string): boolean {
	return key.startsWith("ya29.");
}

/**
 * Validate that an API key is not a Google OAuth token being used for
 * a provider that requires actual API keys (e.g., Google AI Studio).
 * Throws a descriptive error if the key appears to be an OAuth token.
 */
function validateNotGoogleOAuthToken(provider: string, key: string): void {
	if (GOOGLE_API_KEY_PROVIDERS.has(provider) && isGoogleOAuthToken(key)) {
		throw new Error(
			`The provided key for "${provider}" appears to be a Google OAuth access token (ya29.*), ` +
				`not a valid API key. Google AI Studio requires an API key starting with "AIza...". ` +
				`\n\nIf you're using Google's Gemini CLI, its OAuth tokens are not compatible. ` +
				`Either:\n` +
				`  1. Get an API key from https://aistudio.google.com/apikey and set GEMINI_API_KEY\n` +
				`  2. Use '/login google-gemini-cli' to authenticate via Cloud Code Assist`,
		);
	}
}

/**
 * On-disk format: each provider maps to a single credential or an array of credentials.
 * Single credentials are normalized to arrays at load time for internal use.
 */
export type AuthStorageData = Record<string, AuthCredential | AuthCredential[]>;

type LockResult<T> = {
	result: T;
	next?: string;
};

export interface AuthStorageBackend {
	withLock<T>(fn: (current: string | undefined) => LockResult<T>): T;
	withLockAsync<T>(fn: (current: string | undefined) => Promise<LockResult<T>>): Promise<T>;
}

export class FileAuthStorageBackend implements AuthStorageBackend {
	constructor(private authPath: string = join(getAgentDir(), "auth.json")) {}

	private ensureParentDir(): void {
		const dir = dirname(this.authPath);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true, mode: 0o700 });
		}
	}

	private ensureFileExists(): void {
		if (!existsSync(this.authPath)) {
			writeFileSync(this.authPath, "{}", "utf-8");
			chmodSync(this.authPath, 0o600);
		}
	}

	withLock<T>(fn: (current: string | undefined) => LockResult<T>): T {
		this.ensureParentDir();
		this.ensureFileExists();

		let release: (() => void) | undefined;
		try {
			release = acquireLockSyncWithRetry(this.authPath);
			const current = existsSync(this.authPath) ? readFileSync(this.authPath, "utf-8") : undefined;
			const { result, next } = fn(current);
			if (next !== undefined) {
				writeFileSync(this.authPath, next, "utf-8");
				chmodSync(this.authPath, 0o600);
			}
			return result;
		} finally {
			if (release) {
				release();
			}
		}
	}

	async withLockAsync<T>(fn: (current: string | undefined) => Promise<LockResult<T>>): Promise<T> {
		this.ensureParentDir();
		this.ensureFileExists();

		let release: (() => Promise<void>) | undefined;
		let lockCompromised = false;
		let lockCompromisedError: Error | undefined;
		const throwIfCompromised = () => {
			if (lockCompromised) {
				throw lockCompromisedError ?? new Error("Auth storage lock was compromised");
			}
		};

		try {
			release = await acquireLockAsync(this.authPath, {
				staleMs: AUTH_LOCK_STALE_MS,
				onCompromised: (err) => {
					lockCompromised = true;
					lockCompromisedError = err;
				},
			});

			throwIfCompromised();
			const current = existsSync(this.authPath) ? readFileSync(this.authPath, "utf-8") : undefined;
			const { result, next } = await fn(current);
			throwIfCompromised();
			if (next !== undefined) {
				writeFileSync(this.authPath, next, "utf-8");
				chmodSync(this.authPath, 0o600);
			}
			throwIfCompromised();
			return result;
		} finally {
			if (release) {
				try {
					await release();
				} catch {
					// Ignore unlock errors when lock is compromised.
				}
			}
		}
	}
}

export class InMemoryAuthStorageBackend implements AuthStorageBackend {
	private value: string | undefined;

	withLock<T>(fn: (current: string | undefined) => LockResult<T>): T {
		const { result, next } = fn(this.value);
		if (next !== undefined) {
			this.value = next;
		}
		return result;
	}

	async withLockAsync<T>(fn: (current: string | undefined) => Promise<LockResult<T>>): Promise<T> {
		const { result, next } = await fn(this.value);
		if (next !== undefined) {
			this.value = next;
		}
		return result;
	}
}

// ============================================================================
// Backoff durations for different error types (milliseconds)
// ============================================================================

const BACKOFF_RATE_LIMIT_MS = 30_000; // 30s for rate limit / 429
const BACKOFF_QUOTA_EXHAUSTED_MS = 30 * 60_000; // 30min for quota exhausted
const BACKOFF_SERVER_ERROR_MS = 20_000; // 20s for 5xx server errors
const BACKOFF_DEFAULT_MS = 60_000; // 60s fallback

export type UsageLimitErrorType = "rate_limit" | "quota_exhausted" | "server_error" | "unknown";

/**
 * Get backoff duration for an error type.
 */
function getBackoffDuration(errorType: UsageLimitErrorType): number {
	switch (errorType) {
		case "rate_limit":
			return BACKOFF_RATE_LIMIT_MS;
		case "quota_exhausted":
			return BACKOFF_QUOTA_EXHAUSTED_MS;
		case "server_error":
			return BACKOFF_SERVER_ERROR_MS;
		default:
			return BACKOFF_DEFAULT_MS;
	}
}

/**
 * Simple string hash for session-sticky credential selection.
 * Returns a positive integer.
 */
function hashString(str: string): number {
	let hash = 0;
	for (let i = 0; i < str.length; i++) {
		const char = str.charCodeAt(i);
		hash = ((hash << 5) - hash + char) | 0;
	}
	return Math.abs(hash);
}

/**
 * Credential storage backed by a JSON file.
 * Supports multiple credentials per provider with round-robin rotation and rate-limit fallback.
 */
export class AuthStorage {
	private data: AuthStorageData = {};
	private runtimeOverrides: Map<string, string> = new Map();
	private fallbackResolver?: (provider: string) => string | undefined;
	private loadError: Error | null = null;
	private errors: Error[] = [];
	private credentialChangeListeners: Set<() => void> = new Set();

	/**
	 * Round-robin index per provider. Incremented on each call to getApiKey
	 * when no sessionId is provided.
	 */
	private providerRoundRobinIndex: Map<string, number> = new Map();

	/**
	 * Backoff tracking per provider per credential index.
	 * Map<provider, Map<credentialIndex, backoffExpiresAt>>
	 */
	private credentialBackoff: Map<string, Map<number, number>> = new Map();

	/**
	 * Provider-level backoff tracking.
	 * Set when all credentials for a provider are backed off.
	 * Map<provider, backoffExpiresAt>
	 */
	private providerBackoff: Map<string, number> = new Map();

	private constructor(private storage: AuthStorageBackend) {
		this.reload();
	}

	static create(authPath?: string): AuthStorage {
		return new AuthStorage(new FileAuthStorageBackend(authPath ?? join(getAgentDir(), "auth.json")));
	}

	static fromStorage(storage: AuthStorageBackend): AuthStorage {
		return new AuthStorage(storage);
	}

	static inMemory(data: AuthStorageData = {}): AuthStorage {
		const storage = new InMemoryAuthStorageBackend();
		storage.withLock(() => ({ result: undefined, next: JSON.stringify(data, null, 2) }));
		return AuthStorage.fromStorage(storage);
	}

	/**
	 * Set a runtime API key override (not persisted to disk).
	 * Used for CLI --api-key flag.
	 */
	setRuntimeApiKey(provider: string, apiKey: string): void {
		this.runtimeOverrides.set(provider, apiKey);
	}

	/**
	 * Remove a runtime API key override.
	 */
	removeRuntimeApiKey(provider: string): void {
		this.runtimeOverrides.delete(provider);
	}

	/**
	 * Set a fallback resolver for API keys not found in auth.json or env vars.
	 * Used for custom provider keys from models.json.
	 */
	setFallbackResolver(resolver: (provider: string) => string | undefined): void {
		this.fallbackResolver = resolver;
	}

	/**
	 * Register a callback to be notified when credentials change (e.g., after OAuth token refresh).
	 * Returns a function to unregister the listener.
	 */
	onCredentialChange(listener: () => void): () => void {
		this.credentialChangeListeners.add(listener);
		return () => this.credentialChangeListeners.delete(listener);
	}

	private notifyCredentialChange(): void {
		for (const listener of this.credentialChangeListeners) {
			try {
				listener();
			} catch {
				// Don't let listener errors break the refresh flow
			}
		}
	}

	private recordError(error: unknown): void {
		const normalizedError = error instanceof Error ? error : new Error(String(error));
		this.errors.push(normalizedError);
	}

	private parseStorageData(content: string | undefined): AuthStorageData {
		if (!content) {
			return {};
		}
		return JSON.parse(content) as AuthStorageData;
	}

	/**
	 * Normalize a storage entry to an array of credentials.
	 * Handles both single credential (backward compat) and array formats.
	 */
	getCredentialsForProvider(provider: string): AuthCredential[] {
		const entry = this.data[provider];
		if (!entry) return [];
		if (Array.isArray(entry)) return entry;
		return [entry];
	}

	/**
	 * Reload credentials from storage.
	 */
	reload(): void {
		let content: string | undefined;
		try {
			this.storage.withLock((current) => {
				content = current;
				return { result: undefined };
			});
			this.data = this.parseStorageData(content);
			this.loadError = null;
		} catch (error) {
			this.loadError = error as Error;
			this.recordError(error);
		}
	}

	private persistProviderChange(provider: string, credential: AuthCredential | AuthCredential[] | undefined): void {
		if (this.loadError) {
			return;
		}

		try {
			this.storage.withLock((current) => {
				const currentData = this.parseStorageData(current);
				const merged: AuthStorageData = { ...currentData };
				if (credential) {
					merged[provider] = credential;
				} else {
					delete merged[provider];
				}
				return { result: undefined, next: JSON.stringify(merged, null, 2) };
			});
		} catch (error) {
			this.recordError(error);
		}
	}

	/**
	 * Get the first credential for a provider (backward-compatible).
	 */
	get(provider: string): AuthCredential | undefined {
		const creds = this.getCredentialsForProvider(provider);
		return creds[0] ?? undefined;
	}

	/**
	 * Set credential for a provider. For API key credentials, appends to
	 * existing credentials (accumulation on duplicate login). For OAuth,
	 * replaces (only one OAuth token per provider makes sense).
	 */
	set(provider: string, credential: AuthCredential): void {
		if (credential.type === "api_key") {
			// Block Google OAuth tokens being stored as API keys for AI Studio providers
			validateNotGoogleOAuthToken(provider, credential.key);

			const existing = this.getCredentialsForProvider(provider);
			// Deduplicate: don't add if same key already exists
			const isDuplicate = existing.some(
				(c) => c.type === "api_key" && c.key === credential.key,
			);
			if (isDuplicate) return;

			const updated = [...existing, credential];
			this.data[provider] = updated.length === 1 ? updated[0] : updated;
			this.persistProviderChange(provider, updated.length === 1 ? updated[0] : updated);
		} else {
			// OAuth: replace any existing OAuth credential, keep API keys
			const existing = this.getCredentialsForProvider(provider);
			const apiKeys = existing.filter((c) => c.type === "api_key");
			if (apiKeys.length === 0) {
				this.data[provider] = credential;
				this.persistProviderChange(provider, credential);
			} else {
				const updated = [...apiKeys, credential];
				this.data[provider] = updated;
				this.persistProviderChange(provider, updated);
			}
		}
	}

	/**
	 * Remove all credentials for a provider.
	 */
	remove(provider: string): void {
		delete this.data[provider];
		this.providerRoundRobinIndex.delete(provider);
		this.credentialBackoff.delete(provider);
		this.providerBackoff.delete(provider);
		this.persistProviderChange(provider, undefined);
	}

	/**
	 * List all providers with credentials.
	 */
	list(): string[] {
		return Object.keys(this.data);
	}

	/**
	 * Check if credentials exist for a provider in auth.json.
	 */
	has(provider: string): boolean {
		return provider in this.data;
	}

	/**
	 * Check if any form of auth is configured for a provider.
	 * Unlike getApiKey(), this doesn't refresh OAuth tokens.
	 */
	hasAuth(provider: string): boolean {
		if (this.runtimeOverrides.has(provider)) return true;
		if (this.data[provider]) return true;
		if (getEnvApiKey(provider)) return true;
		if (this.fallbackResolver?.(provider)) return true;
		return false;
	}

	/**
	 * Get all credentials (for passing to getOAuthApiKey).
	 * Returns normalized format where each provider has a single credential
	 * (the first one) for backward compatibility with OAuth refresh.
	 *
	 * NOTE: For providers with multiple API keys, only the first credential is
	 * returned. This is intentional — callers use this for OAuth refresh only,
	 * which is always single-credential. Do not use for API key enumeration.
	 */
	getAll(): Record<string, AuthCredential> {
		const result: Record<string, AuthCredential> = {};
		for (const [provider, entry] of Object.entries(this.data)) {
			result[provider] = Array.isArray(entry) ? entry[0] : entry;
		}
		return result;
	}

	drainErrors(): Error[] {
		const drained = [...this.errors];
		this.errors = [];
		return drained;
	}

	/**
	 * Login to an OAuth provider.
	 */
	async login(providerId: OAuthProviderId, callbacks: OAuthLoginCallbacks): Promise<void> {
		const provider = getOAuthProvider(providerId);
		if (!provider) {
			throw new Error(`Unknown OAuth provider: ${providerId}`);
		}

		const credentials = await provider.login(callbacks);
		this.set(providerId, { type: "oauth", ...credentials });
	}

	/**
	 * Logout from a provider.
	 */
	logout(provider: string): void {
		this.remove(provider);
	}

	/**
	 * Returns true when the provider has credentials configured but all of them
	 * are currently in a backoff window (e.g. rate-limited or quota exhausted).
	 * Returns false when there are no credentials or at least one is available.
	 */
	areAllCredentialsBackedOff(provider: string): boolean {
		const credentials = this.getCredentialsForProvider(provider);
		if (credentials.length === 0) return false;
		for (let i = 0; i < credentials.length; i++) {
			if (!this.isCredentialBackedOff(provider, i)) return false;
		}
		return true;
	}

	/**
	 * Mark an entire provider as exhausted.
	 * Called when all credentials for a provider are backed off.
	 */
	markProviderExhausted(provider: string, errorType: UsageLimitErrorType): void {
		const backoffMs = getBackoffDuration(errorType);
		this.providerBackoff.set(provider, Date.now() + backoffMs);
	}

	/**
	 * Check if a provider is currently available (not backed off at provider level).
	 */
	isProviderAvailable(provider: string): boolean {
		const expiresAt = this.providerBackoff.get(provider);
		if (expiresAt === undefined) return true;
		if (Date.now() >= expiresAt) {
			this.providerBackoff.delete(provider);
			return true;
		}
		return false;
	}

	/**
	 * Get milliseconds remaining until provider backoff expires.
	 * Returns 0 if provider is available.
	 */
	getProviderBackoffRemaining(provider: string): number {
		const expiresAt = this.providerBackoff.get(provider);
		if (expiresAt === undefined) return 0;
		const remaining = expiresAt - Date.now();
		if (remaining <= 0) {
			this.providerBackoff.delete(provider);
			return 0;
		}
		return remaining;
	}

	/**
	 * Check if a credential index is currently backed off.
	 */
	private isCredentialBackedOff(provider: string, index: number): boolean {
		const providerBackoff = this.credentialBackoff.get(provider);
		if (!providerBackoff) return false;
		const expiresAt = providerBackoff.get(index);
		if (expiresAt === undefined) return false;
		if (Date.now() >= expiresAt) {
			providerBackoff.delete(index);
			return false;
		}
		return true;
	}

	/**
	 * Select the best credential index for a provider.
	 * - If sessionId is provided, uses session-sticky hashing as the starting point.
	 * - Otherwise, uses round-robin as the starting point.
	 * - Skips credentials that are currently backed off.
	 * - Returns -1 if all credentials are backed off.
	 */
	private selectCredentialIndex(provider: string, credentials: AuthCredential[], sessionId?: string): number {
		if (credentials.length === 0) return -1;
		if (credentials.length === 1) {
			return this.isCredentialBackedOff(provider, 0) ? -1 : 0;
		}

		let startIndex: number;
		if (sessionId) {
			startIndex = hashString(sessionId) % credentials.length;
		} else {
			const current = this.providerRoundRobinIndex.get(provider) ?? 0;
			startIndex = current % credentials.length;
			this.providerRoundRobinIndex.set(provider, current + 1);
		}

		// Try starting from the preferred index, wrapping around
		for (let offset = 0; offset < credentials.length; offset++) {
			const index = (startIndex + offset) % credentials.length;
			if (!this.isCredentialBackedOff(provider, index)) {
				return index;
			}
		}

		// All credentials are backed off
		return -1;
	}

	/**
	 * Mark a credential as rate-limited. Finds the credential that was most
	 * recently used for this provider+session and backs it off.
	 *
	 * @returns true if another credential is available (caller should retry),
	 *          false if all credentials for this provider are backed off.
	 */
	markUsageLimitReached(
		provider: string,
		sessionId?: string,
		options?: { errorType?: UsageLimitErrorType },
	): boolean {
		const credentials = this.getCredentialsForProvider(provider);
		if (credentials.length === 0) return false;

		const errorType = options?.errorType ?? "rate_limit";

		// For unknown/transport errors (e.g. connection reset, "terminated"),
		// don't back off the only credential — it would make getApiKey() return
		// undefined and surface a misleading "Authentication failed" message.
		if (errorType === "unknown" && credentials.length === 1) {
			return false;
		}

		const backoffMs = getBackoffDuration(errorType);

		// Determine which credential was just used (same logic as selectCredentialIndex
		// but without incrementing round-robin)
		let usedIndex: number;
		if (credentials.length === 1) {
			usedIndex = 0;
		} else if (sessionId) {
			usedIndex = hashString(sessionId) % credentials.length;
		} else {
			// Round-robin was already incremented in getApiKey, so the last-used
			// index is (current - 1). Note: in a concurrent scenario where another
			// getApiKey call fires between the original request and this backoff call,
			// we may back off the wrong credential index. This is acceptable because:
			// (a) pi runs single-threaded event loop, (b) backing off the wrong key
			// is safe — it self-heals when the backoff expires.
			const current = this.providerRoundRobinIndex.get(provider) ?? 0;
			usedIndex = ((current - 1) % credentials.length + credentials.length) % credentials.length;
		}

		// Set backoff for this credential
		let providerBackoff = this.credentialBackoff.get(provider);
		if (!providerBackoff) {
			providerBackoff = new Map();
			this.credentialBackoff.set(provider, providerBackoff);
		}
		providerBackoff.set(usedIndex, Date.now() + backoffMs);

		// Check if any credential is still available
		for (let i = 0; i < credentials.length; i++) {
			if (!this.isCredentialBackedOff(provider, i)) {
				return true;
			}
		}
		return false;
	}

	/**
	 * Refresh OAuth token with backend locking to prevent race conditions.
	 * Multiple pi instances may try to refresh simultaneously when tokens expire.
	 */
	private async refreshOAuthTokenWithLock(
		providerId: OAuthProviderId,
	): Promise<{ apiKey: string; newCredentials: OAuthCredentials } | null> {
		const provider = getOAuthProvider(providerId);
		if (!provider) {
			return null;
		}

		const result = await this.storage.withLockAsync(async (current) => {
			const currentData = this.parseStorageData(current);
			this.data = currentData;
			this.loadError = null;

			// Find the OAuth credential for this provider
			const creds = this.getCredentialsForProvider(providerId);
			const cred = creds.find((c) => c.type === "oauth");
			if (!cred || cred.type !== "oauth") {
				return { result: null };
			}

			if (Date.now() < cred.expires) {
				return { result: { apiKey: provider.getApiKey(cred), newCredentials: cred } };
			}

			const oauthCreds: Record<string, OAuthCredentials> = {};
			for (const [key, value] of Object.entries(currentData)) {
				const first = Array.isArray(value) ? value.find((c) => c.type === "oauth") : value;
				if (first?.type === "oauth") {
					oauthCreds[key] = first;
				}
			}

			const refreshed = await getOAuthApiKey(providerId, oauthCreds);
			if (!refreshed) {
				return { result: null };
			}

			// Update the OAuth credential in-place within the array
			const existingEntry = currentData[providerId];
			const newOAuthCred: OAuthCredential = { type: "oauth", ...refreshed.newCredentials };
			let updatedEntry: AuthCredential | AuthCredential[];

			if (Array.isArray(existingEntry)) {
				updatedEntry = existingEntry.map((c) => (c.type === "oauth" ? newOAuthCred : c));
			} else {
				updatedEntry = newOAuthCred;
			}

			const merged: AuthStorageData = {
				...currentData,
				[providerId]: updatedEntry,
			};
			this.data = merged;
			this.loadError = null;
			return { result: refreshed, next: JSON.stringify(merged, null, 2) };
		});

		// Notify listeners after credential change (e.g., model registry refresh)
		if (result) {
			queueMicrotask(() => this.notifyCredentialChange());
		}

		return result;
	}

	/**
	 * Resolve an API key from a single credential.
	 */
	private async resolveCredentialApiKey(
		providerId: string,
		cred: AuthCredential,
	): Promise<string | undefined> {
		if (cred.type === "api_key") {
			return resolveConfigValue(cred.key);
		}

		if (cred.type === "oauth") {
			const provider = getOAuthProvider(providerId);
			if (!provider) return undefined;

			const needsRefresh = Date.now() >= cred.expires;
			if (needsRefresh) {
				try {
					const result = await this.refreshOAuthTokenWithLock(providerId);
					if (result) return result.apiKey;
				} catch (error) {
					this.recordError(error);
					this.reload();
					const updatedCreds = this.getCredentialsForProvider(providerId);
					const updatedOAuth = updatedCreds.find((c) => c.type === "oauth");
					if (updatedOAuth?.type === "oauth" && Date.now() < updatedOAuth.expires) {
						return provider.getApiKey(updatedOAuth);
					}
					return undefined;
				}
			} else {
				return provider.getApiKey(cred);
			}
		}

		return undefined;
	}

	/**
	 * Get API key for a provider.
	 * Priority:
	 * 1. Runtime override (CLI --api-key)
	 * 2. Credential(s) from auth.json (with round-robin / session-sticky selection)
	 * 3. Environment variable
	 * 4. Fallback resolver (models.json custom providers)
	 *
	 * @param providerId - The provider to get an API key for
	 * @param sessionId - Optional session ID for sticky credential selection
	 */
	async getApiKey(providerId: string, sessionId?: string, options?: { baseUrl?: string }): Promise<string | undefined> {
		// If the model has a local baseUrl, return a dummy key to avoid auth blocking
		if (options?.baseUrl) {
			try {
				const hostname = new URL(options.baseUrl).hostname;
				if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "0.0.0.0" || hostname === "::1") {
					return "local-no-key-needed";
				}
			} catch {
				if (options.baseUrl.startsWith("unix:")) {
					return "local-no-key-needed";
				}
			}
		}

		// Runtime override takes highest priority
		const runtimeKey = this.runtimeOverrides.get(providerId);
		if (runtimeKey) {
			// Block Google OAuth tokens used as runtime API key overrides
			if (GOOGLE_API_KEY_PROVIDERS.has(providerId) && isGoogleOAuthToken(runtimeKey)) {
				this.recordError(
					new Error(
						`Blocked Google OAuth access token (ya29.*) for provider "${providerId}". ` +
							`Use an API key from https://aistudio.google.com/apikey or '/login google-gemini-cli'.`,
					),
				);
				return undefined;
			}
			return runtimeKey;
		}

		const credentials = this.getCredentialsForProvider(providerId);

		if (credentials.length > 0) {
			const index = this.selectCredentialIndex(providerId, credentials, sessionId);
			if (index >= 0) {
				const resolved = await this.resolveCredentialApiKey(providerId, credentials[index]);
				if (resolved) return resolved;
				// Credential unresolvable (e.g. type:"oauth" for a non-OAuth provider) —
				// fall through to env / fallback instead of returning undefined (#2083)
			}
			// All credentials backed off or unresolvable - fall through to env/fallback
		}

		// Fall back to environment variable
		const envKey = getEnvApiKey(providerId);
		if (envKey) {
			// Block Google OAuth tokens from environment variables (e.g., GEMINI_API_KEY=ya29.*)
			if (GOOGLE_API_KEY_PROVIDERS.has(providerId) && isGoogleOAuthToken(envKey)) {
				this.recordError(
					new Error(
						`GEMINI_API_KEY contains a Google OAuth access token (ya29.*), not an API key. ` +
							`Get an API key from https://aistudio.google.com/apikey or use '/login google-gemini-cli'.`,
					),
				);
				return undefined;
			}
			return envKey;
		}

		// Fall back to custom resolver (e.g., models.json custom providers)
		return this.fallbackResolver?.(providerId) ?? undefined;
	}

	/**
	 * Get all registered OAuth providers
	 */
	getOAuthProviders() {
		return getOAuthProviders();
	}
}
