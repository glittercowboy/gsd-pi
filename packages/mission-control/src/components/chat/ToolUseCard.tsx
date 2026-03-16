/**
 * ToolUseCard — structured card rendered for tool_use messages.
 *
 * Shows tool name with a gear icon, streaming indicator while active,
 * and a checkmark when done. Renders as a compact bordered card in monospace font.
 */

interface ToolUseCardProps {
  toolName: string;
  toolInput?: unknown;
  done: boolean;
}

export function ToolUseCard({ toolName, done }: ToolUseCardProps) {
  return (
    <div
      className="mx-4 my-1 rounded border px-3 py-2 font-mono text-xs"
      style={{ borderColor: "#1E2D3D", backgroundColor: "#1A2332" }}
      data-testid="tool-use-card"
    >
      <div className="flex items-center gap-2">
        <span style={{ color: "#5BC8F0" }}>&#9881;</span>
        <span className="text-slate-300">{toolName}</span>
        {!done && (
          <span className="animate-pulse text-slate-500">…</span>
        )}
        {done && (
          <span style={{ color: "#22C55E" }}>&#10003;</span>
        )}
      </div>
    </div>
  );
}
