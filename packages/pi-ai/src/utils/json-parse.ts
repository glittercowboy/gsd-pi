import { parseStreamingJson as nativeParseStreamingJson } from "@gsd/native";
import { hasYamlBulletLists, repairToolJson } from "./repair-tool-json.js";

/**
 * Attempts to parse potentially incomplete JSON during streaming.
 * Always returns a valid object, even if the JSON is incomplete.
 *
 * Uses the native Rust streaming JSON parser for performance.
 * Falls back to YAML bullet-list repair when the native parser
 * returns an empty object from input that contains YAML-style
 * bullet lists copied from template formatting (#2660).
 *
 * @param partialJson The partial JSON string from streaming
 * @returns Parsed object or empty object if parsing fails
 */
export function parseStreamingJson<T = any>(partialJson: string | undefined): T {
	if (!partialJson || partialJson.trim() === "") {
		return {} as T;
	}

	// Fast path: try native streaming parser first
	const result = nativeParseStreamingJson<T>(partialJson);

	// If the native parser returned a non-empty result, use it.
	// Only attempt repair when the result is empty AND the input
	// contains YAML bullet patterns (avoids unnecessary work).
	if (
		result &&
		typeof result === "object" &&
		Object.keys(result as object).length === 0 &&
		hasYamlBulletLists(partialJson)
	) {
		try {
			return JSON.parse(repairToolJson(partialJson)) as T;
		} catch {
			// Repair failed — return the empty object from native parser
		}
	}

	return result;
}
