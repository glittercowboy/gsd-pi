/**
 * Image overflow recovery for many-image sessions.
 *
 * When a conversation accumulates many images (screenshots, file reads, etc.),
 * the Anthropic API enforces a stricter per-image dimension limit (2000px) for
 * "many-image requests." This module detects the resulting 400 error and
 * recovers by stripping older images from the conversation history, preserving
 * the most recent ones to maintain session continuity.
 *
 * @see https://github.com/gsd-build/gsd-2/issues/2874
 */

import type { Message, ImageContent, TextContent } from "@gsd/pi-ai";

/**
 * Maximum image dimension (px) that the Anthropic API allows in many-image
 * requests. Images at or above this size in a large conversation will be
 * rejected with a 400 error. We use 1568 as the safe ceiling (Anthropic's
 * recommended max for multi-image requests).
 */
export const MANY_IMAGE_MAX_DIMENSION = 1568;

/**
 * Number of recent images to preserve when stripping old images.
 * Keeps the most recent screenshots/images so the model retains visual context
 * for the current task.
 */
const RECENT_IMAGES_TO_KEEP = 5;

/**
 * Regex matching the Anthropic API error for oversized images in many-image requests.
 */
const IMAGE_DIMENSION_ERROR_RE =
	/image.dimensions?.exceed.*max.*allowed.*size.*many.image/i;

/**
 * Detect whether an error message is the Anthropic "image dimensions exceed max
 * allowed size for many-image requests" 400 error.
 */
export function isImageDimensionError(errorMessage: string | undefined | null): boolean {
	if (!errorMessage) return false;
	return IMAGE_DIMENSION_ERROR_RE.test(errorMessage);
}

export interface DownsizeResult {
	/** Total number of images found in the conversation */
	imageCount: number;
	/** Whether any images were stripped */
	processed: boolean;
	/** Number of images that were stripped */
	strippedCount: number;
}

/**
 * Strip older images from conversation messages to recover from many-image
 * dimension errors. Preserves the N most recent images and replaces older ones
 * with a text placeholder.
 *
 * Mutates messages in place (same pattern as replaceMessages/compaction).
 *
 * Accepts Message[] (the LLM message union) so it works with both
 * agent.state.messages and session entries.
 */
export function downsizeConversationImages(messages: Message[]): DownsizeResult {
	// First pass: collect all image locations (message index + content index)
	const imageLocations: Array<{ msgIdx: number; contentIdx: number }> = [];

	for (let msgIdx = 0; msgIdx < messages.length; msgIdx++) {
		const msg = messages[msgIdx];
		if (msg.role === "assistant") continue;

		// UserMessage can have string content; ToolResultMessage always has array
		if (msg.role === "user" && typeof msg.content === "string") continue;

		const contentArr = msg.content as (TextContent | ImageContent)[];
		if (!Array.isArray(contentArr)) continue;

		for (let contentIdx = 0; contentIdx < contentArr.length; contentIdx++) {
			if (contentArr[contentIdx].type === "image") {
				imageLocations.push({ msgIdx, contentIdx });
			}
		}
	}

	const imageCount = imageLocations.length;
	if (imageCount === 0) {
		return { imageCount: 0, processed: false, strippedCount: 0 };
	}

	// Determine which images to strip (all except the N most recent)
	const stripCount = Math.max(0, imageCount - RECENT_IMAGES_TO_KEEP);
	if (stripCount === 0) {
		return { imageCount, processed: false, strippedCount: 0 };
	}

	const toStrip = imageLocations.slice(0, stripCount);

	// Second pass: replace stripped images with text placeholder.
	// Process in reverse order to maintain content indices.
	for (let i = toStrip.length - 1; i >= 0; i--) {
		const { msgIdx, contentIdx } = toStrip[i];
		const msg = messages[msgIdx];
		if (msg.role === "assistant") continue;
		if (msg.role === "user" && typeof msg.content === "string") continue;

		const contentArr = msg.content as (TextContent | ImageContent)[];
		const imageBlock = contentArr[contentIdx] as ImageContent;
		const mimeType = imageBlock.mimeType || "image/unknown";

		// Replace the image block with a text placeholder
		(contentArr as any[])[contentIdx] = {
			type: "text",
			text: `[image removed to reduce context size — was ${mimeType}]`,
		} as TextContent;
	}

	return { imageCount, processed: true, strippedCount: stripCount };
}
