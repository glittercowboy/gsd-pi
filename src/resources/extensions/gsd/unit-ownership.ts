// GSD Extension — Unit Ownership
// Opt-in per-unit ownership claims for multi-agent safety.
//
// An agent can claim a unit (task, slice) before working on it.
// complete-task and complete-slice enforce ownership when claims exist.
// If no claim file is present, ownership is not enforced (backward compatible).
//
// Claim file location: .gsd/unit-claims.json
// Unit key format:
//   task:  "<milestoneId>/<sliceId>/<taskId>"
//   slice: "<milestoneId>/<sliceId>"
//
// Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>

import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteSync } from "./atomic-write.js";

// ─── Types ───────────────────────────────────────────────────────────────

export interface UnitClaim {
  agent: string;
  claimed_at: string;
}

type ClaimsMap = Record<string, UnitClaim>;

// ─── Key Builders ────────────────────────────────────────────────────────

export function taskUnitKey(milestoneId: string, sliceId: string, taskId: string): string {
  return `${milestoneId}/${sliceId}/${taskId}`;
}

export function sliceUnitKey(milestoneId: string, sliceId: string): string {
  return `${milestoneId}/${sliceId}`;
}

// ─── File Path ───────────────────────────────────────────────────────────

function claimsPath(basePath: string): string {
  return join(basePath, ".gsd", "unit-claims.json");
}

// ─── Read Claims ─────────────────────────────────────────────────────────

function readClaims(basePath: string): ClaimsMap | null {
  const path = claimsPath(basePath);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as ClaimsMap;
  } catch {
    return null;
  }
}

// ─── Public API ──────────────────────────────────────────────────────────

/**
 * Claim a unit for an agent.
 * Overwrites any existing claim for this unit (last writer wins).
 */
export function claimUnit(basePath: string, unitKey: string, agentName: string): void {
  const claims = readClaims(basePath) ?? {};
  claims[unitKey] = { agent: agentName, claimed_at: new Date().toISOString() };
  const dir = join(basePath, ".gsd");
  mkdirSync(dir, { recursive: true });
  atomicWriteSync(claimsPath(basePath), JSON.stringify(claims, null, 2) + "\n");
}

/**
 * Release a unit claim (remove it from the claims map).
 */
export function releaseUnit(basePath: string, unitKey: string): void {
  const claims = readClaims(basePath);
  if (!claims || !(unitKey in claims)) return;
  delete claims[unitKey];
  atomicWriteSync(claimsPath(basePath), JSON.stringify(claims, null, 2) + "\n");
}

/**
 * Get the current owner of a unit, or null if unclaimed / no claims file.
 */
export function getOwner(basePath: string, unitKey: string): string | null {
  const claims = readClaims(basePath);
  if (!claims) return null;
  return claims[unitKey]?.agent ?? null;
}

/**
 * Check if an actor is authorized to operate on a unit.
 * Returns null if ownership passes (or is unclaimed / no file).
 * Returns an error string if a different agent owns the unit.
 */
export function checkOwnership(
  basePath: string,
  unitKey: string,
  actorName: string | undefined,
): string | null {
  if (!actorName) return null; // no actor identity provided — opt-in, so allow
  const owner = getOwner(basePath, unitKey);
  if (owner === null) return null; // unit unclaimed or no claims file
  if (owner === actorName) return null; // actor is the owner
  return `Unit ${unitKey} is owned by ${owner}, not ${actorName}`;
}
