#!/usr/bin/env node

/**
 * Generate snapshot from models.dev API
 * 
 * Fetches live data from https://models.dev/api.json with a 30s timeout,
 * validates against Zod schema, and writes to packages/pi-ai/src/models-dev-snapshot.ts
 * 
 * Exit codes:
 * - 0: Success
 * - 1: Fetch timeout or network error
 * - 2: Validation error (Zod parse failed)
 * - 3: File write error
 */

import { writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

// __dirname for ES modules
const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, "..");
const snapshotPath = join(rootDir, "packages", "pi-ai", "src", "models-dev-snapshot.ts");

const MODELS_DEV_URL = "https://models.dev/api.json";
const FETCH_TIMEOUT_MS = 30000; // 30 seconds - longer than runtime fetch

// Inline Zod schemas (same as models-dev-types.ts but with optional fields for API tolerance)
const ModelsDevModel = z.object({
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

const ModelsDevProvider = z.object({
  api: z.string().optional(),
  name: z.string(),
  env: z.array(z.string()),
  id: z.string(),
  npm: z.string().optional(),
  models: z.record(z.string(), ModelsDevModel),
});

const ModelsDevData = z.record(z.string(), ModelsDevProvider);

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  
  try {
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    
    return await response.json();
  } catch (error) {
    clearTimeout(timeout);
    if (error.name === "AbortError") {
      throw new Error(`Fetch timeout after ${timeoutMs}ms`);
    }
    throw error;
  }
}

async function main() {
  console.log(`Fetching models.dev data from ${MODELS_DEV_URL}...`);
  
  let rawData;
  try {
    rawData = await fetchWithTimeout(MODELS_DEV_URL, FETCH_TIMEOUT_MS);
  } catch (error) {
    console.error(`❌ Fetch error: ${error.message}`);
    process.exit(1);
  }
  
  console.log(`Validating data against Zod schema...`);
  
  let snapshotData;
  try {
    snapshotData = ModelsDevData.parse(rawData);
  } catch (error) {
    console.error(`❌ Validation error: ${error.message}`);
    if (error.errors) {
      console.error(`  Path: ${error.errors.map(e => e.path.join(".")).join(", ")}`);
      console.error(`  Message: ${error.errors.map(e => e.message).join("; ")}`);
    }
    process.exit(2);
  }
  
  const timestamp = new Date().toISOString();
  const content = `/**
 * Auto-generated snapshot from models.dev API
 * Generated at: ${timestamp}
 * Source: ${MODELS_DEV_URL}
 * 
 * This file provides offline-first fallback for model metadata.
 * Run \`npm run generate-snapshot\` to regenerate with fresh data.
 */

import { type ModelsDevData } from "./models-dev-types.js";

export const SNAPSHOT: ModelsDevData = ${JSON.stringify(snapshotData, null, 2)};
`;
  
  console.log(`Writing snapshot to ${snapshotPath}...`);
  
  try {
    await mkdir(dirname(snapshotPath), { recursive: true });
    await writeFile(snapshotPath, content, "utf-8");
  } catch (error) {
    console.error(`❌ Write error: ${error.message}`);
    process.exit(3);
  }
  
  const sizeKB = Math.round(Buffer.byteLength(content) / 1024);
  console.log(`✅ Success! Snapshot written (${sizeKB}KB)`);
}

main();
