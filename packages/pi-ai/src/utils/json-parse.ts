import { parseStreamingJson as nativeParseStreamingJson } from "@gsd/native";

/**
 * Attempts to parse potentially incomplete JSON during streaming.
 * Always returns a valid object, even if the JSON is incomplete.
 *
 * Uses the native Rust streaming JSON parser for performance.
 *
 * @param partialJson The partial JSON string from streaming
 * @returns Parsed object or empty object if parsing fails
 */
export function parseStreamingJson<T = any>(partialJson: string | undefined): T {
	return nativeParseStreamingJson<T>(partialJson);
}
