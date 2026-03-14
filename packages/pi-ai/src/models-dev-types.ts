import { z } from "zod";

/**
 * Zod schemas for models.dev API response structure.
 * Based on: ~/Documents/kimi-coding-check/opencode/packages/opencode/src/provider/models.ts
 */

/** Model schema - represents a single model within a provider */
export const ModelsDevModel = z.object({
  id: z.string(),
  name: z.string(),
  family: z.string().optional(),
  release_date: z.string(),
  attachment: z.boolean(),
  reasoning: z.boolean(),
  temperature: z.boolean().optional(), // Some models omit this
  tool_call: z.boolean(),
  interleaved: z
    .union([
      z.literal(true),
      z
        .object({
          field: z.enum(["reasoning_content", "reasoning_details"]),
        })
        .strict(),
    ])
    .optional(),
  cost: z
    .object({
      input: z.number(),
      output: z.number(),
      cache_read: z.number().optional(),
      cache_write: z.number().optional(),
      context_over_200k: z
        .object({
          input: z.number(),
          output: z.number(),
          cache_read: z.number().optional(),
          cache_write: z.number().optional(),
        })
        .optional(),
    })
    .optional(),
  limit: z.object({
    context: z.number(),
    input: z.number().optional(),
    output: z.number(),
  }),
  modalities: z
    .object({
      input: z.array(z.enum(["text", "audio", "image", "video", "pdf"])),
      output: z.array(z.enum(["text", "audio", "image", "video", "pdf"])),
    })
    .optional(),
  experimental: z.boolean().optional(),
  status: z.enum(["alpha", "beta", "deprecated"]).optional(),
  options: z.record(z.string(), z.any()).optional(), // Some models omit this
  headers: z.record(z.string(), z.string()).optional(),
  provider: z.object({ npm: z.string() }).optional(),
  variants: z.record(z.string(), z.record(z.string(), z.any())).optional(),
});

export type ModelsDevModel = z.infer<typeof ModelsDevModel>;

/** Provider schema - contains provider metadata and a map of models */
export const ModelsDevProvider = z.object({
  api: z.string().optional(),
  name: z.string(),
  env: z.array(z.string()),
  id: z.string(),
  npm: z.string().optional(),
  models: z.record(z.string(), ModelsDevModel),
});

export type ModelsDevProvider = z.infer<typeof ModelsDevProvider>;

/** Data schema - the top-level API response is a record of providers */
export const ModelsDevData = z.record(z.string(), ModelsDevProvider);

export type ModelsDevData = z.infer<typeof ModelsDevData>;
