import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	isImageDimensionError,
	MANY_IMAGE_MAX_DIMENSION,
	downsizeConversationImages,
} from "./image-overflow-recovery.js";
import type { Message } from "@gsd/pi-ai";

// ─── isImageDimensionError ────────────────────────────────────────────────────

describe("isImageDimensionError", () => {
	it("returns true for Anthropic many-image dimension error", () => {
		const errorMessage =
			'Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"messages.125.content.38.image.source.base64.data: At least one of the image dimensions exceed max allowed size for many-image requests: 2000 pixels"}}';
		assert.equal(isImageDimensionError(errorMessage), true);
	});

	it("returns true for bare dimension exceed message", () => {
		const errorMessage =
			"image dimensions exceed max allowed size for many-image requests: 2000 pixels";
		assert.equal(isImageDimensionError(errorMessage), true);
	});

	it("returns false for unrelated 400 error", () => {
		const errorMessage =
			'Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"max_tokens: 4096 > 2048"}}';
		assert.equal(isImageDimensionError(errorMessage), false);
	});

	it("returns false for rate limit error", () => {
		assert.equal(isImageDimensionError("429 rate limit exceeded"), false);
	});

	it("returns false for empty string", () => {
		assert.equal(isImageDimensionError(""), false);
	});

	it("returns false for undefined", () => {
		assert.equal(isImageDimensionError(undefined), false);
	});
});

// ─── MANY_IMAGE_MAX_DIMENSION ─────────────────────────────────────────────────

describe("MANY_IMAGE_MAX_DIMENSION", () => {
	it("is less than 2000 (the API-enforced limit)", () => {
		assert.ok(MANY_IMAGE_MAX_DIMENSION < 2000);
	});

	it("is a positive integer", () => {
		assert.ok(MANY_IMAGE_MAX_DIMENSION > 0);
		assert.equal(MANY_IMAGE_MAX_DIMENSION, Math.floor(MANY_IMAGE_MAX_DIMENSION));
	});
});

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeUserMsg(content: Message["content"] & any): Message {
	return { role: "user", content, timestamp: Date.now() } as Message;
}

function makeAssistantMsg(text: string): Message {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-opus-4-6",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp: Date.now(),
	} as Message;
}

function makeToolResultMsg(images: number): Message {
	const content: any[] = [];
	for (let i = 0; i < images; i++) {
		content.push({ type: "image", data: `img${i}`, mimeType: "image/png" });
	}
	return {
		role: "toolResult",
		toolCallId: `tc${Math.random()}`,
		toolName: "screenshot",
		content,
		isError: false,
		timestamp: Date.now(),
	} as Message;
}

// ─── downsizeConversationImages ───────────────────────────────────────────────

describe("downsizeConversationImages", () => {
	it("counts images in user and toolResult messages", () => {
		const messages: Message[] = [
			makeUserMsg([
				{ type: "image", data: "img1", mimeType: "image/png" },
				{ type: "image", data: "img2", mimeType: "image/png" },
			]),
			makeAssistantMsg("I see them"),
			makeToolResultMsg(1),
		];

		const result = downsizeConversationImages(messages);
		assert.equal(result.imageCount, 3);
	});

	it("returns processed=false when no images present", () => {
		const messages: Message[] = [
			makeUserMsg("just text"),
			makeAssistantMsg("reply"),
		];

		const result = downsizeConversationImages(messages);
		assert.equal(result.imageCount, 0);
		assert.equal(result.processed, false);
	});

	it("returns processed=false when image count <= RECENT_IMAGES_TO_KEEP", () => {
		const messages: Message[] = [
			makeUserMsg([
				{ type: "image", data: "img1", mimeType: "image/png" },
			]),
			makeAssistantMsg("got it"),
		];

		const result = downsizeConversationImages(messages);
		assert.equal(result.imageCount, 1);
		assert.equal(result.processed, false);
	});

	it("strips older images when many images present, preserves recent ones", () => {
		const messages: Message[] = [];
		for (let i = 0; i < 25; i++) {
			messages.push(
				makeUserMsg([
					{ type: "text", text: `message ${i}` },
					{ type: "image", data: `img${i}`, mimeType: "image/png" },
				]),
			);
			messages.push(makeAssistantMsg(`reply ${i}`));
		}

		const result = downsizeConversationImages(messages);
		assert.ok(result.processed);
		assert.equal(result.imageCount, 25);
		assert.equal(result.strippedCount, 20); // 25 - 5 recent

		// Count remaining images
		let remainingImages = 0;
		for (const msg of messages) {
			if (msg.role === "assistant") continue;
			if (typeof msg.content === "string") continue;
			const arr = msg.content as any[];
			for (const block of arr) {
				if (block.type === "image") remainingImages++;
			}
		}
		assert.equal(remainingImages, 5, "Should keep exactly 5 most recent images");

		// The 5 most recent user messages (indices 40,42,44,46,48) should have images
		for (let i = 20; i < 25; i++) {
			const userMsg = messages[i * 2]; // user messages at even indices
			const arr = userMsg.content as any[];
			const hasImage = arr.some((c: any) => c.type === "image");
			assert.ok(hasImage, `Recent message ${i} should retain its image`);
		}
	});

	it("adds text placeholder when stripping an image", () => {
		const messages: Message[] = [];
		for (let i = 0; i < 10; i++) {
			messages.push(
				makeUserMsg([
					{ type: "image", data: `img${i}`, mimeType: "image/jpeg" },
				]),
			);
			messages.push(makeAssistantMsg(`reply ${i}`));
		}

		downsizeConversationImages(messages);

		// First message's image should have been replaced with text
		const firstMsg = messages[0];
		const arr = firstMsg.content as any[];
		const placeholder = arr.find(
			(c: any) => c.type === "text" && c.text.includes("[image removed"),
		);
		assert.ok(placeholder, "Stripped image should be replaced with text placeholder");
		assert.ok(
			placeholder.text.includes("image/jpeg"),
			"Placeholder should mention original mime type",
		);
	});

	it("handles toolResult messages with images", () => {
		const messages: Message[] = [];
		for (let i = 0; i < 10; i++) {
			messages.push(makeToolResultMsg(1));
			messages.push(makeAssistantMsg(`reply ${i}`));
		}

		const result = downsizeConversationImages(messages);
		assert.equal(result.imageCount, 10);
		assert.equal(result.strippedCount, 5);
		assert.ok(result.processed);
	});

	it("handles mixed user and toolResult images", () => {
		const messages: Message[] = [];
		for (let i = 0; i < 8; i++) {
			messages.push(
				makeUserMsg([
					{ type: "text", text: `check ${i}` },
					{ type: "image", data: `uimg${i}`, mimeType: "image/png" },
				]),
			);
			messages.push(makeAssistantMsg(`processing ${i}`));
			messages.push(makeToolResultMsg(1));
			messages.push(makeAssistantMsg(`done ${i}`));
		}

		const result = downsizeConversationImages(messages);
		// 8 user images + 8 tool result images = 16 total
		assert.equal(result.imageCount, 16);
		assert.equal(result.strippedCount, 11); // 16 - 5 recent
	});
});
