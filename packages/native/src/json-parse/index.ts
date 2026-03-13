/**
 * Streaming JSON parser via native Rust bindings.
 *
 * Provides fast JSON parsing with recovery for incomplete/partial JSON,
 * used during LLM streaming tool call argument parsing.
 */

import { native } from "../native.js";

/**
 * Parse a complete JSON string. Throws on invalid JSON.
 */
export function parseJson<T = unknown>(text: string): T {
  return native.parseJson(text) as T;
}

/**
 * Parse potentially incomplete JSON by closing unclosed structures.
 * Handles unclosed strings, objects, arrays, trailing commas, and truncated literals.
 */
export function parsePartialJson<T = unknown>(text: string): T {
  return native.parsePartialJson(text) as T;
}

/**
 * Try full JSON parse first; fall back to partial parse.
 * Returns `{}` on total failure. Drop-in replacement for the JS streaming parser.
 */
export function parseStreamingJson<T = unknown>(text: string | undefined): T {
  if (!text || text.trim() === "") {
    return {} as T;
  }
  return native.parseStreamingJson(text) as T;
}
