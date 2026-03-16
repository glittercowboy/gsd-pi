import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sanitizeSchemaForGoogle } from "./google-shared.js";

// ═══════════════════════════════════════════════════════════════════════════
// sanitizeSchemaForGoogle
// ═══════════════════════════════════════════════════════════════════════════

describe("sanitizeSchemaForGoogle", () => {
	it("passes through primitives unchanged", () => {
		assert.equal(sanitizeSchemaForGoogle(null), null);
		assert.equal(sanitizeSchemaForGoogle(42), 42);
		assert.equal(sanitizeSchemaForGoogle("hello"), "hello");
		assert.equal(sanitizeSchemaForGoogle(true), true);
	});

	it("passes through a valid schema with no banned fields", () => {
		const schema = {
			type: "object",
			properties: {
				name: { type: "string" },
				age: { type: "number" },
			},
			required: ["name"],
		};
		assert.deepEqual(sanitizeSchemaForGoogle(schema), schema);
	});

	it("removes top-level patternProperties", () => {
		const schema = {
			type: "object",
			patternProperties: { "^S_": { type: "string" } },
			properties: { foo: { type: "string" } },
		};
		const result = sanitizeSchemaForGoogle(schema) as Record<string, unknown>;
		assert.ok(!("patternProperties" in result));
		assert.deepEqual(result.properties, { foo: { type: "string" } });
	});

	it("removes nested patternProperties", () => {
		const schema = {
			type: "object",
			properties: {
				nested: {
					type: "object",
					patternProperties: { ".*": { type: "string" } },
				},
			},
		};
		const result = sanitizeSchemaForGoogle(schema) as any;
		assert.ok(!("patternProperties" in result.properties.nested));
	});

	it("converts top-level const to enum", () => {
		const schema = { const: "fixed-value" };
		const result = sanitizeSchemaForGoogle(schema) as Record<string, unknown>;
		assert.deepEqual(result.enum, ["fixed-value"]);
		assert.ok(!("const" in result));
	});

	it("converts const to enum inside anyOf", () => {
		const schema = {
			anyOf: [{ const: "a" }, { const: "b" }, { type: "string" }],
		};
		const result = sanitizeSchemaForGoogle(schema) as any;
		assert.deepEqual(result.anyOf[0], { enum: ["a"] });
		assert.deepEqual(result.anyOf[1], { enum: ["b"] });
		assert.deepEqual(result.anyOf[2], { type: "string" });
	});

	it("converts const to enum inside oneOf", () => {
		const schema = {
			oneOf: [{ const: "x" }, { const: "y" }],
		};
		const result = sanitizeSchemaForGoogle(schema) as any;
		assert.deepEqual(result.oneOf[0], { enum: ["x"] });
		assert.deepEqual(result.oneOf[1], { enum: ["y"] });
	});

	it("recursively sanitizes deeply nested schemas", () => {
		const schema = {
			type: "object",
			properties: {
				level1: {
					type: "object",
					properties: {
						level2: {
							anyOf: [{ const: "deep" }, { type: "null" }],
							patternProperties: { ".*": { type: "string" } },
						},
					},
				},
			},
		};
		const result = sanitizeSchemaForGoogle(schema) as any;
		const level2 = result.properties.level1.properties.level2;
		assert.deepEqual(level2.anyOf[0], { enum: ["deep"] });
		assert.ok(!("patternProperties" in level2));
	});

	it("sanitizes items in array schemas", () => {
		const schema = {
			type: "array",
			items: {
				anyOf: [{ const: "foo" }, { type: "string" }],
			},
		};
		const result = sanitizeSchemaForGoogle(schema) as any;
		assert.deepEqual(result.items.anyOf[0], { enum: ["foo"] });
	});

	it("sanitizes arrays of schemas", () => {
		const input = [{ const: "a" }, { const: "b" }];
		const result = sanitizeSchemaForGoogle(input) as any[];
		assert.deepEqual(result[0], { enum: ["a"] });
		assert.deepEqual(result[1], { enum: ["b"] });
	});

	it("preserves non-string const values unchanged", () => {
		// Only string const values are converted; number const is passed through
		const schema = { const: 42 };
		const result = sanitizeSchemaForGoogle(schema) as Record<string, unknown>;
		assert.equal(result.const, 42);
		assert.ok(!("enum" in result));
	});

	it("sanitizes additionalProperties", () => {
		const schema = {
			type: "object",
			additionalProperties: {
				patternProperties: { "^x-": { type: "string" } },
			},
		};
		const result = sanitizeSchemaForGoogle(schema) as any;
		assert.ok(!("patternProperties" in result.additionalProperties));
	});
});
