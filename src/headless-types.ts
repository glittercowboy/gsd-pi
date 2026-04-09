/**
 * Headless Types — shared types for the headless orchestrator surface.
 *
 * Contains the structured result type emitted in --output-format json mode
 * and the output format discriminator.
 */

// ---------------------------------------------------------------------------
// Output Format
// ---------------------------------------------------------------------------

export type OutputFormat = 'text' | 'json' | 'stream-json'

export const VALID_OUTPUT_FORMATS: ReadonlySet<string> = new Set(['text', 'json', 'stream-json'])

// ---------------------------------------------------------------------------
// Structured JSON Result
// ---------------------------------------------------------------------------

export interface HeadlessJsonResult {
  status: 'success' | 'error' | 'blocked' | 'cancelled' | 'timeout'
  exitCode: number
  sessionId?: string
  duration: number
  cost: {
    total: number
    input_tokens: number
    output_tokens: number
    cache_read_tokens: number
    cache_write_tokens: number
  }
  toolCalls: number
  events: number
  milestone?: string
  phase?: string
  nextAction?: string
  artifacts?: string[]
  commits?: string[]
}
