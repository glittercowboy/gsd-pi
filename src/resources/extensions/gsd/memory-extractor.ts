// GSD Memory Extractor — Background LLM extraction from activity logs
//
// After each unit completes, extracts durable knowledge from the session
// transcript and stores it as memory entries. One extraction at a time
// (mutex guard). Fire-and-forget — never blocks auto-mode.

import { readFileSync, statSync } from 'node:fs';
import type { ExtensionContext } from '@gsd/pi-coding-agent';
import type { Api, AssistantMessage, Model } from '@gsd/pi-ai';
import {
  getActiveMemories,
  isUnitProcessed,
  markUnitProcessed,
  applyMemoryActions,
  decayStaleMemories,
} from './memory-store.js';
import type { MemoryAction } from './memory-store.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export type LLMCallFn = (system: string, user: string) => Promise<string>;

// ─── Concurrency Guard ──────────────────────────────────────────────────────

let _extracting = false;
let _lastExtractionTime = 0;

const MIN_EXTRACTION_INTERVAL_MS = 30_000;

// ─── Skip Conditions ────────────────────────────────────────────────────────

const SKIP_TYPES = new Set([
  'complete-slice',
  'rewrite-docs',
  'triage-captures',
]);

const MIN_ACTIVITY_SIZE = 1024; // 1KB

// ─── Secret Redaction ───────────────────────────────────────────────────────

const SECRET_PATTERNS = [
  /(?:sk|pk|api[_-]?key|token|secret|password|credential|auth)[_-]?\w*[\s:=]+['"]?[\w\-./+=]{20,}['"]?/gi,
  /AKIA[0-9A-Z]{16}/g,
  /gh[pousr]_[A-Za-z0-9_]{36,}/g,
  /[rsp]k_(?:live|test)_[A-Za-z0-9]{20,}/g,
  /eyJ[A-Za-z0-9_-]{20,}\.eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+/g,
  /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g,
  /(?:Bearer\s+)[A-Za-z0-9\-._~+/]+=*/gi,
  /npm_[A-Za-z0-9]{36,}/g,
  /sk-ant-[A-Za-z0-9\-_]{20,}/g,
  /sk-[A-Za-z0-9]{40,}/g,
];

function redactSecrets(text: string): string {
  let result = text;
  for (const pattern of SECRET_PATTERNS) {
    // Reset lastIndex for global regexes
    pattern.lastIndex = 0;
    result = result.replace(pattern, '[REDACTED]');
  }
  return result;
}

// ─── Model Selection ────────────────────────────────────────────────────────

/**
 * Build an LLM call function using the cheapest available model (preferring Haiku).
 * Returns null if no models available.
 */
export function buildMemoryLLMCall(ctx: ExtensionContext): LLMCallFn | null {
  try {
    const available = ctx.modelRegistry.getAvailable();
    if (!available || available.length === 0) return null;

    // Prefer Haiku by ID substring match
    let model = available.find(m =>
      m.id.toLowerCase().includes('haiku'),
    );

    // Fallback: cheapest by input cost
    if (!model) {
      model = [...available].sort((a, b) => a.cost.input - b.cost.input)[0];
    }

    if (!model) return null;

    const selectedModel = model as Model<Api>;

    // Resolve API key via modelRegistry so OAuth tokens (auth.json) are used.
    // Without this, streamSimpleAnthropic only checks env vars via getEnvApiKey,
    // which returns undefined for OAuth users (Claude Max / Claude Pro).
    // See: https://github.com/gsd-build/gsd-2/issues/2959
    const resolvedKeyPromise = ctx.modelRegistry.getApiKey(selectedModel).catch(() => undefined);

    return async (system: string, user: string): Promise<string> => {
      const { completeSimple } = await import('@gsd/pi-ai');
      const resolvedApiKey = await resolvedKeyPromise;
      const result: AssistantMessage = await completeSimple(selectedModel, {
        systemPrompt: system,
        messages: [{ role: 'user', content: [{ type: 'text', text: user }], timestamp: Date.now() }],
      }, {
        maxTokens: 2048,
        temperature: 0,
        ...(resolvedApiKey ? { apiKey: resolvedApiKey } : {}),
      });

      // Extract text from response
      const textParts = result.content
        .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
        .map(c => c.text);
      return textParts.join('');
    };
  } catch {
    return null;
  }
}

// ─── Extraction Prompts ─────────────────────────────────────────────────────

const EXTRACTION_SYSTEM = `You are a memory extraction agent for a software project. Analyze the session
transcript and identify durable knowledge worth remembering for future sessions.

Categories: architecture, convention, gotcha, preference, environment, pattern

Actions (return JSON array):
- CREATE: {"action": "CREATE", "category": "<cat>", "content": "<text>", "confidence": <0.6-0.95>}
- UPDATE: {"action": "UPDATE", "id": "<MEM###>", "content": "<revised text>"}
- REINFORCE: {"action": "REINFORCE", "id": "<MEM###>"}
- SUPERSEDE: {"action": "SUPERSEDE", "id": "<MEM###>", "superseded_by": "<MEM###>"}
- LINK: {"action": "LINK", "from": "<MEM###>", "to": "<MEM###>", "rel": "<rel>", "confidence": <0.6-0.95>}

Link relation types:
- related_to   — two memories cover the same area
- depends_on   — "to" is a prerequisite for "from"
- contradicts  — "from" conflicts with "to"
- elaborates   — "from" expands on "to"
- supersedes   — "from" replaces "to" (rarely needed; prefer SUPERSEDE)

Rules:
- Don't create memories for one-off bug fixes or temporary state
- Don't duplicate existing memories — use REINFORCE or UPDATE
- Keep content to 1-3 sentences
- Confidence: 0.6 tentative, 0.8 solid, 0.95 well-confirmed
- Prefer fewer high-quality memories over many low-quality ones
- Only LINK memories that genuinely relate — don't fabricate edges
- Return empty array [] if nothing worth remembering
- NEVER include secrets, API keys, or passwords

Return ONLY a valid JSON array.`;

function buildExtractionUserPrompt(
  unitType: string,
  unitId: string,
  existingMemories: { id: string; category: string; content: string }[],
  transcript: string,
): string {
  let memoriesSection: string;
  if (existingMemories.length === 0) {
    memoriesSection = '(none yet)';
  } else {
    memoriesSection = existingMemories
      .map((m, i) => `${i + 1}. [${m.id}] (${m.category}) ${m.content}`)
      .join('\n');
  }

  return `## Current Active Memories\n${memoriesSection}\n\n## Session Transcript (${unitType}: ${unitId})\n${transcript}`;
}

// ─── Activity JSONL Parsing ─────────────────────────────────────────────────

/**
 * Extract assistant message text from activity JSONL.
 * Returns concatenated text content from assistant role entries.
 */
function extractTranscriptFromActivity(raw: string, maxChars = 30_000): string {
  const lines = raw.split('\n');
  const parts: string[] = [];
  let totalChars = 0;

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.role !== 'assistant') continue;

      // Handle content array or direct text
      if (Array.isArray(entry.content)) {
        for (const block of entry.content) {
          if (block.type === 'text' && block.text) {
            const text = block.text;
            if (totalChars + text.length > maxChars) {
              parts.push(text.substring(0, maxChars - totalChars));
              return parts.join('\n\n');
            }
            parts.push(text);
            totalChars += text.length;
          }
        }
      } else if (typeof entry.content === 'string') {
        const text = entry.content;
        if (totalChars + text.length > maxChars) {
          parts.push(text.substring(0, maxChars - totalChars));
          return parts.join('\n\n');
        }
        parts.push(text);
        totalChars += text.length;
      }
    } catch {
      // Skip malformed lines
    }
  }

  return parts.join('\n\n');
}

// ─── Response Parsing ───────────────────────────────────────────────────────

/**
 * Parse the LLM response into memory actions.
 * Strips markdown fences, validates required fields.
 * Returns [] on any parse failure.
 */
export function parseMemoryResponse(raw: string): MemoryAction[] {
  try {
    // Strip markdown code fences
    let cleaned = raw.trim();
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
    }

    const parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed)) return [];

    const actions: MemoryAction[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== 'object' || !item.action) continue;

      switch (item.action) {
        case 'CREATE':
          if (typeof item.category === 'string' && typeof item.content === 'string') {
            actions.push({
              action: 'CREATE',
              category: item.category,
              content: item.content,
              confidence: typeof item.confidence === 'number' ? item.confidence : undefined,
            });
          }
          break;
        case 'UPDATE':
          if (typeof item.id === 'string' && typeof item.content === 'string') {
            actions.push({
              action: 'UPDATE',
              id: item.id,
              content: item.content,
              confidence: typeof item.confidence === 'number' ? item.confidence : undefined,
            });
          }
          break;
        case 'REINFORCE':
          if (typeof item.id === 'string') {
            actions.push({ action: 'REINFORCE', id: item.id });
          }
          break;
        case 'SUPERSEDE':
          if (typeof item.id === 'string' && typeof item.superseded_by === 'string') {
            actions.push({
              action: 'SUPERSEDE',
              id: item.id,
              superseded_by: item.superseded_by,
            });
          }
          break;
        case 'LINK':
          if (
            typeof item.from === 'string' &&
            typeof item.to === 'string' &&
            typeof item.rel === 'string'
          ) {
            actions.push({
              action: 'LINK',
              from: item.from,
              to: item.to,
              rel: item.rel,
              confidence: typeof item.confidence === 'number' ? item.confidence : undefined,
            });
          }
          break;
      }
    }

    return actions;
  } catch {
    return [];
  }
}

// ─── Main Extraction Function ───────────────────────────────────────────────

export interface ExtractFromTranscriptOptions {
  /** Logical source type (e.g. "execute-task", "note", "file", "url", "artifact"). */
  sourceType: string;
  /** Stable identifier for the source (unit id, source id, URL, etc.). */
  sourceId: string;
  /** Optional scope for any CREATE actions ("project" / "global" / custom). */
  scope?: string;
  /** Optional tags applied to any CREATE actions. */
  tags?: string[];
  /** Bypass the mutex + rate-limit when caller has already vetted them. */
  force?: boolean;
}

/**
 * Core extractor — shared by unit post-processing and explicit ingest.
 * Returns the applied actions for observability. Never throws.
 */
export async function extractMemoriesFromTranscript(
  transcript: string,
  llmCallFn: LLMCallFn,
  opts: ExtractFromTranscriptOptions,
): Promise<import('./memory-store.js').MemoryAction[]> {
  if (!opts.force) {
    if (_extracting) return [];
    const now = Date.now();
    if (now - _lastExtractionTime < MIN_EXTRACTION_INTERVAL_MS) return [];
    _lastExtractionTime = now;
  }

  const acquireMutex = !_extracting;
  if (acquireMutex) _extracting = true;
  try {
    const trimmed = transcript.trim();
    if (!trimmed) return [];

    const safeTranscript = redactSecrets(trimmed);
    const activeMemories = getActiveMemories().map((m) => ({
      id: m.id,
      category: m.category,
      content: m.content,
    }));

    const userPrompt = buildExtractionUserPrompt(
      opts.sourceType,
      opts.sourceId,
      activeMemories,
      safeTranscript,
    );

    const response = await llmCallFn(EXTRACTION_SYSTEM, userPrompt);
    const actions = parseMemoryResponse(response);

    if (actions.length === 0) return [];

    const decorated = actions.map((action): import('./memory-store.js').MemoryAction => {
      if (action.action !== 'CREATE') return action;
      return {
        ...action,
        scope: action.scope ?? opts.scope,
        tags: action.tags ?? opts.tags,
      };
    });
    applyMemoryActions(decorated, opts.sourceType, opts.sourceId);
    return decorated;
  } catch {
    return [];
  } finally {
    if (acquireMutex) _extracting = false;
  }
}

/**
 * Extract memories from a completed unit's activity log.
 * Fire-and-forget — never throws, mutex-guarded, respects rate limiting.
 */
export async function extractMemoriesFromUnit(
  activityFile: string,
  unitType: string,
  unitId: string,
  llmCallFn: LLMCallFn,
): Promise<void> {
  if (_extracting) return;

  const now = Date.now();
  if (now - _lastExtractionTime < MIN_EXTRACTION_INTERVAL_MS) return;

  if (SKIP_TYPES.has(unitType)) return;

  const unitKey = `${unitType}/${unitId}`;
  if (isUnitProcessed(unitKey)) return;

  try {
    const stat = statSync(activityFile);
    if (stat.size < MIN_ACTIVITY_SIZE) return;
  } catch {
    return;
  }

  _extracting = true;
  _lastExtractionTime = now;
  try {
    const raw = readFileSync(activityFile, 'utf-8');
    const transcript = extractTranscriptFromActivity(raw);
    if (!transcript.trim()) return;

    await extractMemoriesFromTranscript(transcript, llmCallFn, {
      sourceType: unitType,
      sourceId: unitId,
      force: true,
    });

    decayStaleMemories(20);
    markUnitProcessed(unitKey, activityFile);
  } catch {
    // Non-fatal — memory extraction failure should never affect auto-mode
  } finally {
    _extracting = false;
  }
}

// ─── Testing Helpers ────────────────────────────────────────────────────────

/** Reset extraction state (testing only). */
export function _resetExtractionState(): void {
  _extracting = false;
  _lastExtractionTime = 0;
}
