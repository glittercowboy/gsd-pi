import type { ExtensionUIContext } from "@gsd/agent-types";

import { Theme } from "@gsd/pi-coding-agent";
import { getAvailableThemesWithPaths, getThemeByName, setTheme, setThemeInstance } from "../../../pi-coding-agent-compat.js";
import { theme } from "../../../theme.js";
import { appKey } from "../components/keybinding-hints.js";
import type { InteractiveModeStateHost } from "../interactive-mode-state.js";

export function createExtensionUIContext(host: InteractiveModeStateHost): ExtensionUIContext {
	return {
		select: (title, options, opts) => host.showExtensionSelector(title, options, opts),
		confirm: (title, message, opts) => host.showExtensionConfirm(title, message, opts),
		input: (title, placeholder, opts) => host.showExtensionInput(title, placeholder, opts),
		notify: (message, type) => host.showExtensionNotify(message, type),
		onTerminalInput: (handler) => host.addExtensionTerminalInputListener(handler),
		setStatus: (key, text) => host.setExtensionStatus(key, text),
		setWorkingMessage: (message) => {
			if (host.loadingAnimation) {
				if (message) {
					host.loadingAnimation.setMessage(message);
				} else {
					host.loadingAnimation.setMessage(`${host.defaultWorkingMessage} (${appKey(host.keybindings, "interrupt")} to interrupt)`);
				}
			} else {
				host.pendingWorkingMessage = message;
			}
		},
		setWidget: (key, content, options) => host.setExtensionWidget(key, content, options),
		setFooter: (factory) => host.setExtensionFooter(factory),
		setHeader: (factory) => host.setExtensionHeader(factory),
		setTitle: (title) => host.ui.terminal.setTitle(title),
		custom: (factory, options) => host.showExtensionCustom(factory, options),
		pasteToEditor: (text) => host.editor.handleInput(`\x1b[200~${text}\x1b[201~`),
		setEditorText: (text) => host.editor.setText(text),
		getEditorText: () => host.editor.getText(),
		editor: (title, prefill) => host.showExtensionEditor(title, prefill),
		setEditorComponent: (factory) => host.setCustomEditorComponent(factory),
		get theme() {
			return theme;
		},
		// vendor-seam: dual-module-path -- theme API returns pi-internal types that don't match ExtensionUIContext shape
		getAllThemes: () => getAvailableThemesWithPaths() as unknown as ReturnType<ExtensionUIContext["getAllThemes"]>,
		getTheme: (name) => getThemeByName(name) as unknown as ReturnType<ExtensionUIContext["getTheme"]>,
		setTheme: (themeOrName) => {
			if (themeOrName instanceof Theme) {
				// vendor-seam: dual-module-path -- setThemeInstance expects pi-internal Theme nominal type
				setThemeInstance(themeOrName as unknown as Parameters<typeof setThemeInstance>[0]);
				host.ui.requestRender();
				return { success: true };
			}
			const result = setTheme(themeOrName, true);
			if (result.success) {
				if (host.settingsManager.getTheme() !== themeOrName) {
					host.settingsManager.setTheme(themeOrName);
				}
				host.ui.requestRender();
			}
			return result;
		},
		getToolsExpanded: () => host.toolOutputExpanded,
		setToolsExpanded: (expanded) => host.setToolsExpanded(expanded),
	};
}
