/**
 * Observation masking for GSD auto-mode sessions.
 *
 * Replaces tool result content older than N turns with a placeholder.
 * Reduces context bloat between compactions with zero LLM overhead.
 * Preserves message ordering, roles, and all assistant/user messages.
 *
 * Operates on the pi-ai Message[] format (post-convertToLlm, pre-provider):
 *   - toolResult messages: { role: "toolResult", content: TextContent[] }
 *   - bash results are already converted to: { role: "user", content: [{type:"text",text:"..."}] }
 *     and start with "Ran `" from bashExecutionToText.
 */

interface MaskableMessage {
  role: string;
  content: unknown;
  type?: string;
  [key: string]: unknown;
}

const MASK_PLACEHOLDER = "[result masked — within summarized history]";
const MASK_CONTENT_BLOCK = [{ type: "text" as const, text: MASK_PLACEHOLDER }];

function findTurnBoundary(messages: MaskableMessage[], keepRecentTurns: number): number {
  let turnsSeen = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    // In the LLM payload, genuine user turns have role "user".
    // Tool results have role "toolResult" and are excluded by this check.
    if (m.role === "user") {
      // Skip bash-result user messages (converted from bashExecution) — these aren't real user turns
      if (isBashResultUserMessage(m)) continue;
      turnsSeen++;
      if (turnsSeen >= keepRecentTurns) return i;
    }
  }
  return 0;
}

/**
 * Detect user messages that originated from bashExecution.
 * After convertToLlm, these are {role: "user", content: [{type:"text", text:"Ran `cmd`\n..."}]}.
 * The bashExecutionToText format always starts with "Ran `".
 */
function isBashResultUserMessage(m: MaskableMessage): boolean {
  if (m.role !== "user" || !Array.isArray(m.content)) return false;
  const first = m.content[0];
  return first && typeof first === "object" && "text" in first &&
    typeof first.text === "string" && first.text.startsWith("Ran `");
}

function isMaskableMessage(m: MaskableMessage): boolean {
  // Tool result messages (role: "toolResult" in pi-ai format)
  if (m.role === "toolResult") return true;
  // Bash-result user messages (converted from bashExecution by convertToLlm)
  if (isBashResultUserMessage(m)) return true;
  return false;
}

export function createObservationMask(keepRecentTurns: number = 8) {
  return (messages: MaskableMessage[]): MaskableMessage[] => {
    const boundary = findTurnBoundary(messages, keepRecentTurns);
    if (boundary === 0) return messages;

    return messages.map((m, i) => {
      if (i >= boundary) return m;
      if (isMaskableMessage(m)) {
        // Content may be string or array of content blocks — always replace with array
        return { ...m, content: MASK_CONTENT_BLOCK };
      }
      return m;
    });
  };
}
