/**
 * Bash stream processor — single-pass UTF-8 decode + ANSI strip + binary sanitization.
 *
 * Handles chunk boundaries for incomplete UTF-8 and ANSI escape sequences.
 */

import { native } from "../native.js";

export interface StreamState {
  utf8Pending: number[];
  ansiPending: number[];
}

export interface StreamChunkResult {
  text: string;
  state: StreamState;
}

/**
 * Process a raw bash output chunk in a single pass.
 *
 * Decodes UTF-8 (handling incomplete multibyte sequences at boundaries),
 * strips ANSI escape sequences, removes control characters (except tab and
 * newline), removes carriage returns, and filters Unicode format characters.
 *
 * Pass the returned `state` to the next call to handle sequences split
 * across chunk boundaries.
 */
export function processStreamChunk(
  chunk: Buffer,
  state?: StreamState,
): StreamChunkResult {
  // Convert StreamState arrays to the format napi expects (Vec<u8>)
  const napiState = state
    ? {
        utf8Pending: Buffer.from(state.utf8Pending),
        ansiPending: Buffer.from(state.ansiPending),
      }
    : undefined;

  const result = (native as Record<string, Function>).processStreamChunk(
    chunk,
    napiState,
  ) as {
    text: string;
    state: { utf8Pending: Buffer; ansiPending: Buffer };
  };

  return {
    text: result.text,
    state: {
      utf8Pending: Array.from(result.state.utf8Pending),
      ansiPending: Array.from(result.state.ansiPending),
    },
  };
}

/**
 * Strip ANSI escape sequences from a string.
 */
export function stripAnsiNative(text: string): string {
  return (native as Record<string, Function>).stripAnsiNative(text) as string;
}

/**
 * Remove binary garbage and control characters from a string.
 *
 * Keeps tab and newline. Removes carriage return, all other control
 * characters, Unicode format characters (U+FFF9-U+FFFB), and lone surrogates.
 */
export function sanitizeBinaryOutputNative(text: string): string {
  return (native as Record<string, Function>).sanitizeBinaryOutputNative(
    text,
  ) as string;
}
