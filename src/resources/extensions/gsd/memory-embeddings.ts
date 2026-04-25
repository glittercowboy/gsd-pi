// GSD Memory Embeddings — provider-agnostic embedding layer
//
// Same model-discovery pattern as buildMemoryLLMCall: prefers a dedicated
// embedding-capable model when available, and returns null when none is
// found (which is the common case — not every provider exposes embeddings).
//
// When embeddings are unavailable, all calls become no-ops and
// queryMemoriesRanked falls back to keyword-only scoring.

import type { ExtensionContext } from "@gsd/pi-coding-agent";

import { _getAdapter, isDbAvailable, upsertMemoryEmbedding, deleteMemoryEmbedding } from "./gsd-db.js";
import { logWarning } from "./workflow-logger.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export type EmbedFn = (texts: string[]) => Promise<Float32Array[]>;

export interface EmbeddingModelInfo {
  id: string;
}

export interface MemoryEmbeddingRow {
  memoryId: string;
  model: string;
  dim: number;
  vector: Float32Array;
}

// ─── Model selection ────────────────────────────────────────────────────────

const EMBEDDING_ID_HINTS = [
  "embed",
  "embedding",
  "voyage",
  "text-embedding",
  "nomic",
  "jina-embed",
  "bge",
  "mxbai-embed",
];

/**
 * Try to build an embedding function from the model registry. Returns null
 * when no embedding-capable model is obvious from the registry metadata.
 *
 * NOTE: the Pi SDK doesn't yet expose a dedicated embeddings API for every
 * provider. This implementation currently targets Anthropic / OpenAI-shaped
 * SDKs: when the caller has direct API access via `ctx.modelRegistry`, they
 * can wire this up by providing an `embedFn` override. We ship the hint-based
 * detection here so future providers can plug in without touching callers.
 */
export function buildEmbeddingFn(ctx: ExtensionContext): EmbedFn | null {
  try {
    const available = ctx.modelRegistry?.getAvailable?.();
    if (!available || available.length === 0) return null;
    const candidate = available.find((model) => {
      const id = typeof model?.id === "string" ? model.id.toLowerCase() : "";
      return EMBEDDING_ID_HINTS.some((hint) => id.includes(hint));
    });
    if (!candidate) return null;
    // We don't currently have a provider-neutral embedding call in Pi; the
    // detection surface is in place so wiring can happen once Pi offers it.
    return null;
  } catch (err) {
    logWarning("memory-embeddings", `model discovery failed: ${(err as Error).message}`);
    return null;
  }
}

// ─── Vector (de)serialization ───────────────────────────────────────────────

export function packFloat32(vec: Float32Array): Uint8Array {
  return new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength);
}

export function unpackFloat32(blob: unknown): Float32Array | null {
  if (!blob) return null;
  try {
    if (blob instanceof Float32Array) return blob;
    let view: Uint8Array;
    if (blob instanceof Uint8Array) {
      view = blob;
    } else if (blob instanceof ArrayBuffer) {
      view = new Uint8Array(blob);
    } else if ((blob as Buffer).buffer && (blob as Buffer).byteLength != null) {
      const buf = blob as Buffer;
      view = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    } else if (Array.isArray(blob)) {
      return new Float32Array(blob as number[]);
    } else {
      return null;
    }
    if (view.byteLength % 4 !== 0) return null;
    // Copy into an aligned buffer — BLOBs may arrive at odd byte offsets.
    const aligned = new ArrayBuffer(view.byteLength);
    new Uint8Array(aligned).set(view);
    return new Float32Array(aligned);
  } catch {
    return null;
  }
}

// ─── Math ───────────────────────────────────────────────────────────────────

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// ─── Read helpers ───────────────────────────────────────────────────────────

export function getEmbeddingForMemory(memoryId: string): MemoryEmbeddingRow | null {
  if (!isDbAvailable()) return null;
  const adapter = _getAdapter();
  if (!adapter) return null;
  try {
    const row = adapter
      .prepare(
        "SELECT memory_id, model, dim, vector FROM memory_embeddings WHERE memory_id = :id",
      )
      .get({ ":id": memoryId });
    if (!row) return null;
    const vector = unpackFloat32(row["vector"]);
    if (!vector) return null;
    return {
      memoryId: row["memory_id"] as string,
      model: row["model"] as string,
      dim: row["dim"] as number,
      vector,
    };
  } catch {
    return null;
  }
}

export function loadAllEmbeddings(): MemoryEmbeddingRow[] {
  if (!isDbAvailable()) return [];
  const adapter = _getAdapter();
  if (!adapter) return [];
  try {
    const rows = adapter
      .prepare(
        `SELECT e.memory_id, e.model, e.dim, e.vector
         FROM memory_embeddings e
         JOIN memories m ON m.id = e.memory_id
         WHERE m.superseded_by IS NULL`,
      )
      .all();
    const out: MemoryEmbeddingRow[] = [];
    for (const row of rows) {
      const vector = unpackFloat32(row["vector"]);
      if (!vector) continue;
      out.push({
        memoryId: row["memory_id"] as string,
        model: row["model"] as string,
        dim: row["dim"] as number,
        vector,
      });
    }
    return out;
  } catch {
    return [];
  }
}

// ─── Write helpers ──────────────────────────────────────────────────────────

export function saveEmbedding(
  memoryId: string,
  vector: Float32Array,
  model: string,
): boolean {
  if (!isDbAvailable()) return false;
  try {
    upsertMemoryEmbedding({
      memoryId,
      model,
      dim: vector.length,
      vector: packFloat32(vector),
      updatedAt: new Date().toISOString(),
    });
    return true;
  } catch {
    return false;
  }
}

export function removeEmbedding(memoryId: string): boolean {
  if (!isDbAvailable()) return false;
  try {
    return deleteMemoryEmbedding(memoryId);
  } catch {
    return false;
  }
}

// ─── Orchestration ──────────────────────────────────────────────────────────

/**
 * Embed each memory's content via `embedFn` (if provided) and persist the
 * resulting vectors. Returns the number of successfully embedded memories.
 * Safe to call with embedFn=null — it becomes a no-op.
 */
export async function embedMemories(
  memories: Array<{ id: string; content: string }>,
  embedFn: EmbedFn | null,
  model: string,
): Promise<number> {
  if (!embedFn || memories.length === 0) return 0;
  try {
    const vectors = await embedFn(memories.map((m) => m.content));
    let count = 0;
    for (let i = 0; i < memories.length && i < vectors.length; i++) {
      const vector = vectors[i];
      if (!vector || vector.length === 0) continue;
      if (saveEmbedding(memories[i].id, vector, model)) count++;
    }
    return count;
  } catch (err) {
    logWarning("memory-embeddings", `embed failed: ${(err as Error).message}`);
    return 0;
  }
}
