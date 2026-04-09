const XTERM_DARK_THEME = {
  background: "#0a0a0a",
  foreground: "#e4e4e7",
  cursor: "#e4e4e7",
  cursorAccent: "#0a0a0a",
  selectionBackground: "#27272a",
  selectionForeground: "#e4e4e7",
  black: "#18181b",
  red: "#ef4444",
  green: "#22c55e",
  yellow: "#eab308",
  blue: "#3b82f6",
  magenta: "#a855f7",
  cyan: "#06b6d4",
  white: "#e4e4e7",
  brightBlack: "#52525b",
  brightRed: "#f87171",
  brightGreen: "#4ade80",
  brightYellow: "#facc15",
  brightBlue: "#60a5fa",
  brightMagenta: "#c084fc",
  brightCyan: "#22d3ee",
  brightWhite: "#fafafa",
} as const;

const XTERM_LIGHT_THEME = {
  background: "#f5f5f5",
  foreground: "#18181b",
  cursor: "#18181b",
  cursorAccent: "#f5f5f5",
  selectionBackground: "#d4d4d8",
  selectionForeground: "#18181b",
  black: "#18181b",
  red: "#b91c1c",
  green: "#166534",
  yellow: "#854d0e",
  blue: "#1d4ed8",
  magenta: "#7e22ce",
  cyan: "#0f766e",
  // Keep ANSI white entries readable on a light terminal surface.
  white: "#52525b",
  brightBlack: "#71717a",
  brightRed: "#dc2626",
  brightGreen: "#15803d",
  brightYellow: "#713f12",
  brightBlue: "#2563eb",
  brightMagenta: "#9333ea",
  brightCyan: "#0f766e",
  brightWhite: "#27272a",
} as const;

export function getXtermTheme(isDark: boolean) {
  return isDark ? XTERM_DARK_THEME : XTERM_LIGHT_THEME;
}

export function getXtermOptions(isDark: boolean, fontSize?: number) {
  return {
    cursorBlink: true,
    cursorStyle: "bar" as const,
    fontSize: fontSize ?? 13,
    fontFamily:
      "'SF Mono', 'Cascadia Code', 'Fira Code', Menlo, Monaco, 'Courier New', monospace",
    lineHeight: 1.35,
    letterSpacing: 0,
    theme: getXtermTheme(isDark),
    allowProposedApi: true,
    scrollback: 10000,
    convertEol: false,
  };
}
