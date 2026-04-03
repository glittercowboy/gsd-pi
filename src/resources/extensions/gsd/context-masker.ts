/**
 * Observation masking for GSD auto-mode sessions.
 *
 * Replaces tool result content older than N turns with a placeholder.
 * Reduces context bloat between compactions with zero LLM overhead.
 * Preserves message ordering, roles, and all assistant/user messages.
 */

interface MaskableMessage {
  role: string;
  content: string | unknown[];
  type?: string;
}

const MASK_PLACEHOLDER = "[result masked — within summarized history]";

function isUserTurn(m: MaskableMessage): boolean {
  // Internal format uses type === "user"; API format uses role === "user" without tool_result content
  if (m.type === "user") return true;
  if (m.role === "user" && !Array.isArray(m.content)) return true;
  return false;
}

function findTurnBoundary(messages: MaskableMessage[], keepRecentTurns: number): number {
  let turnsSeen = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isUserTurn(messages[i])) {
      turnsSeen++;
      if (turnsSeen >= keepRecentTurns) return i;
    }
  }
  return 0;
}

const MASKABLE_TYPES = new Set(["toolResult", "bashExecution", "tool_result"]);

function isMaskable(m: MaskableMessage): boolean {
  // Internal format: message-level type field
  if (MASKABLE_TYPES.has(m.type ?? "")) return true;
  // API format: role === "tool" (OpenAI-style)
  if (m.role === "tool") return true;
  // API format: role === "user" with tool_result content blocks (Anthropic-style)
  if (m.role === "user" && Array.isArray(m.content)) {
    return (m.content as { type?: string }[]).every(
      block => block.type === "tool_result",
    );
  }
  return false;
}

function maskContent(m: MaskableMessage): MaskableMessage {
  if (typeof m.content === "string") {
    return { ...m, content: MASK_PLACEHOLDER };
  }
  // For content arrays, replace each block's text/content with the placeholder
  if (Array.isArray(m.content)) {
    const masked = (m.content as Record<string, unknown>[]).map(block => ({
      ...block,
      ...(typeof block.content === "string" ? { content: MASK_PLACEHOLDER } : {}),
      ...(typeof block.text === "string" ? { text: MASK_PLACEHOLDER } : {}),
    }));
    return { ...m, content: masked };
  }
  return { ...m, content: MASK_PLACEHOLDER };
}

export function createObservationMask(keepRecentTurns: number = 8) {
  return (messages: MaskableMessage[]): MaskableMessage[] => {
    const boundary = findTurnBoundary(messages, keepRecentTurns);
    if (boundary === 0) return messages;

    return messages.map((m, i) => {
      if (i >= boundary) return m;
      if (isMaskable(m)) return maskContent(m);
      return m;
    });
  };
}
