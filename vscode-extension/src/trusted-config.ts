/**
 * Trust-boundary helper for VS Code startup configuration. A workspace can
 * be supplied by an untrusted repository (`.code-workspace` or
 * `.vscode/settings.json`); when the GSD extension auto-activates we must
 * NOT honor those values for sensitive options like `binaryPath` or
 * `autoStart`. Only `globalValue` (user settings) and `defaultValue`
 * (extension manifest) are trusted.
 *
 * Lives in its own module — and explicitly does NOT import the `vscode`
 * API — so the security-regression test can exercise the real predicate
 * outside the VS Code host.
 */
export interface InspectedConfigurationValue<T> {
	defaultValue?: T;
	globalValue?: T;
	workspaceValue?: T;
	workspaceFolderValue?: T;
	defaultLanguageValue?: T;
	globalLanguageValue?: T;
	workspaceLanguageValue?: T;
	workspaceFolderLanguageValue?: T;
}

export function pickTrustedConfigurationValue<T>(
	inspected: InspectedConfigurationValue<T> | undefined,
	fallback: T,
): T {
	return inspected?.globalValue ?? inspected?.defaultValue ?? fallback;
}
