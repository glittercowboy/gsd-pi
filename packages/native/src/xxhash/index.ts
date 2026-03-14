/**
 * Native xxHash32 — Rust implementation via napi-rs, with a pure-JS fallback.
 *
 * Hashes the UTF-8 representation of the input string with the given seed.
 */

import { native } from "../native.js";

// ─── Pure-JS xxHash32 fallback ────────────────────────────────────────────────
// Used when the native addon is present but does not export xxHash32
// (e.g. an older build or an unsupported platform variant).

const PRIME32_1 = 0x9e3779b1;
const PRIME32_2 = 0x85ebca77;
const PRIME32_3 = 0xc2b2ae3d;
const PRIME32_4 = 0x27d4eb2f;
const PRIME32_5 = 0x165667b1;

function rotl32(v: number, n: number): number {
  return ((v << n) | (v >>> (32 - n))) >>> 0;
}

/** Single xxHash32 lane accumulation step (processes one 32-bit word). */
function accumulate(v: number, lane: number): number {
  return Math.imul(rotl32((v + Math.imul(lane, PRIME32_2)) >>> 0, 13), PRIME32_1) >>> 0;
}

function xxHash32JS(input: string, seed: number): number {
  const data = Buffer.from(input, "utf-8");
  const len = data.length;
  let h32: number;
  let i = 0;

  if (len >= 16) {
    let v1 = (seed + PRIME32_1 + PRIME32_2) >>> 0;
    let v2 = (seed + PRIME32_2) >>> 0;
    let v3 = seed >>> 0;
    let v4 = (seed - PRIME32_1) >>> 0;

    while (i <= len - 16) {
      v1 = accumulate(v1, data.readUInt32LE(i)); i += 4;
      v2 = accumulate(v2, data.readUInt32LE(i)); i += 4;
      v3 = accumulate(v3, data.readUInt32LE(i)); i += 4;
      v4 = accumulate(v4, data.readUInt32LE(i)); i += 4;
    }

    h32 = (rotl32(v1, 1) + rotl32(v2, 7) + rotl32(v3, 12) + rotl32(v4, 18)) >>> 0;
  } else {
    h32 = (seed + PRIME32_5) >>> 0;
  }

  h32 = (h32 + len) >>> 0;

  while (i <= len - 4) {
    h32 = Math.imul(rotl32((h32 + Math.imul(data.readUInt32LE(i), PRIME32_3)) >>> 0, 17), PRIME32_4) >>> 0;
    i += 4;
  }

  while (i < len) {
    h32 = Math.imul(rotl32((h32 + Math.imul(data[i]!, PRIME32_5)) >>> 0, 11), PRIME32_1) >>> 0;
    i++;
  }

  h32 = Math.imul(h32 ^ (h32 >>> 15), PRIME32_2) >>> 0;
  h32 = Math.imul(h32 ^ (h32 >>> 13), PRIME32_3) >>> 0;
  h32 = (h32 ^ (h32 >>> 16)) >>> 0;

  return h32;
}

// Resolve once at module load: prefer native, fall back to JS.
const _xxHash32Impl: (input: string, seed: number) => number =
  typeof native.xxHash32 === "function"
    ? (input, seed) => native.xxHash32(input, seed)
    : xxHash32JS;

/**
 * Compute xxHash32 of a UTF-8 string.
 *
 * Uses the native Rust implementation when available; falls back to a
 * pure-JS implementation if the loaded native addon does not export
 * `xxHash32` (e.g. an older build).
 *
 * @param input  The string to hash (encoded as UTF-8 internally).
 * @param seed   32-bit seed value.
 * @returns      32-bit unsigned hash.
 */
export function xxHash32(input: string, seed: number): number {
  return _xxHash32Impl(input, seed);
}
