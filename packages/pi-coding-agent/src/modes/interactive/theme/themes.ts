/**
 * Built-in theme definitions.
 *
 * Each theme is a self-contained record of color values. Variable references
 * (e.g. "accent") are resolved against the `vars` map at load time by the
 * theme engine in theme.ts.
 *
 * To add a new built-in theme, add an entry to `builtinThemes` below.
 */

// Re-use the ThemeJson type from the schema defined in theme.ts.
// We import only the type to avoid circular runtime dependencies.
import type { ThemeJson } from "./theme.js";

// ---------------------------------------------------------------------------
// Dark theme
// ---------------------------------------------------------------------------

const dark: ThemeJson = {
	name: "dark",
	vars: {
		cyan: "#00d7ff",
		blue: "#5f87ff",
		green: "#b5bd68",
		red: "#cc6666",
		yellow: "#ffff00",
		gray: "#808080",
		dimGray: "#666666",
		darkGray: "#505050",
		accent: "#8abeb7",
		selectedBg: "#3a3a4a",
		userMsgBg: "#343541",
		toolPendingBg: "#282832",
		toolSuccessBg: "#283228",
		toolErrorBg: "#3c2828",
		customMsgBg: "#2d2838",
	},
	colors: {
		accent: "accent",
		border: "blue",
		borderAccent: "cyan",
		borderMuted: "darkGray",
		success: "green",
		error: "red",
		warning: "yellow",
		muted: "gray",
		dim: "dimGray",
		text: "",
		thinkingText: "gray",

		selectedBg: "selectedBg",
		userMessageBg: "userMsgBg",
		userMessageText: "",
		customMessageBg: "customMsgBg",
		customMessageText: "",
		customMessageLabel: "#9575cd",
		toolPendingBg: "toolPendingBg",
		toolSuccessBg: "toolSuccessBg",
		toolErrorBg: "toolErrorBg",
		toolTitle: "",
		toolOutput: "gray",

		mdHeading: "#f0c674",
		mdLink: "#81a2be",
		mdLinkUrl: "dimGray",
		mdCode: "accent",
		mdCodeBlock: "green",
		mdCodeBlockBorder: "gray",
		mdQuote: "gray",
		mdQuoteBorder: "gray",
		mdHr: "gray",
		mdListBullet: "accent",

		toolDiffAdded: "green",
		toolDiffRemoved: "red",
		toolDiffContext: "gray",

		syntaxComment: "#6A9955",
		syntaxKeyword: "#569CD6",
		syntaxFunction: "#DCDCAA",
		syntaxVariable: "#9CDCFE",
		syntaxString: "#CE9178",
		syntaxNumber: "#B5CEA8",
		syntaxType: "#4EC9B0",
		syntaxOperator: "#D4D4D4",
		syntaxPunctuation: "#D4D4D4",

		thinkingOff: "darkGray",
		thinkingMinimal: "#6e6e6e",
		thinkingLow: "#5f87af",
		thinkingMedium: "#81a2be",
		thinkingHigh: "#b294bb",
		thinkingXhigh: "#d183e8",

		bashMode: "green",
	},
	export: {
		pageBg: "#18181e",
		cardBg: "#1e1e24",
		infoBg: "#3c3728",
	},
};

// ---------------------------------------------------------------------------
// Light theme
// ---------------------------------------------------------------------------

const light: ThemeJson = {
	name: "light",
	vars: {
		teal: "#5a8080",
		blue: "#547da7",
		green: "#588458",
		red: "#aa5555",
		yellow: "#9a7326",
		warning: "#7a5a00",
		mediumGray: "#6c6c6c",
		dimGray: "#767676",
		lightGray: "#b0b0b0",
		selectedBg: "#d0d0e0",
		userMsgBg: "#e8e8e8",
		toolPendingBg: "#e8e8f0",
		toolSuccessBg: "#e8f0e8",
		toolErrorBg: "#f0e8e8",
		customMsgBg: "#ede7f6",
	},
	colors: {
		accent: "teal",
		border: "blue",
		borderAccent: "teal",
		borderMuted: "lightGray",
		success: "green",
		error: "red",
		warning: "warning",
		muted: "mediumGray",
		dim: "dimGray",
		text: "",
		thinkingText: "mediumGray",

		selectedBg: "selectedBg",
		userMessageBg: "userMsgBg",
		userMessageText: "",
		customMessageBg: "customMsgBg",
		customMessageText: "",
		customMessageLabel: "#7e57c2",
		toolPendingBg: "toolPendingBg",
		toolSuccessBg: "toolSuccessBg",
		toolErrorBg: "toolErrorBg",
		toolTitle: "",
		toolOutput: "mediumGray",

		mdHeading: "yellow",
		mdLink: "blue",
		mdLinkUrl: "dimGray",
		mdCode: "teal",
		mdCodeBlock: "green",
		mdCodeBlockBorder: "mediumGray",
		mdQuote: "mediumGray",
		mdQuoteBorder: "mediumGray",
		mdHr: "mediumGray",
		mdListBullet: "green",

		toolDiffAdded: "green",
		toolDiffRemoved: "red",
		toolDiffContext: "mediumGray",

		syntaxComment: "#008000",
		syntaxKeyword: "#0000FF",
		syntaxFunction: "#795E26",
		syntaxVariable: "#001080",
		syntaxString: "#A31515",
		syntaxNumber: "#098658",
		syntaxType: "#267F99",
		syntaxOperator: "#000000",
		syntaxPunctuation: "#000000",

		thinkingOff: "lightGray",
		thinkingMinimal: "#767676",
		thinkingLow: "blue",
		thinkingMedium: "teal",
		thinkingHigh: "#875f87",
		thinkingXhigh: "#8b008b",

		bashMode: "green",
	},
	export: {
		pageBg: "#f8f8f8",
		cardBg: "#ffffff",
		infoBg: "#fffae6",
	},
};

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const builtinThemes: Record<string, ThemeJson> = { dark, light };
