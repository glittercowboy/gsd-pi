import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { gsdRoot } from "../paths.js";

export interface UokParityEvent {
  ts?: string;
  path?: string;
  phase?: string;
  status?: string;
  error?: string;
  flags?: Record<string, unknown>;
}

export interface UokParityReport {
  generatedAt: string;
  sourcePath: string;
  totalEvents: number;
  paths: Record<string, number>;
  statuses: Record<string, number>;
  criticalMismatches: string[];
  fallbackInvocations: number;
}

function parityLogPath(basePath: string): string {
  return join(gsdRoot(basePath), "runtime", "uok-parity.jsonl");
}

function reportPath(basePath: string): string {
  return join(gsdRoot(basePath), "runtime", "uok-parity-report.json");
}

function increment(bucket: Record<string, number>, key: string | undefined): void {
  const normalized = key && key.trim().length > 0 ? key : "unknown";
  bucket[normalized] = (bucket[normalized] ?? 0) + 1;
}

export function parseParityEvents(raw: string): UokParityEvent[] {
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as UokParityEvent;
      } catch {
        return { status: "error", error: "invalid parity json line" };
      }
    });
}

export function buildParityReport(events: readonly UokParityEvent[], sourcePath: string): UokParityReport {
  const paths: Record<string, number> = {};
  const statuses: Record<string, number> = {};
  const criticalMismatches: string[] = [];
  let fallbackInvocations = 0;

  for (const event of events) {
    increment(paths, event.path);
    increment(statuses, event.status);
    if (event.path === "legacy-fallback") fallbackInvocations += 1;
    if (event.status === "error") {
      criticalMismatches.push(event.error ?? "parity event reported error");
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    sourcePath,
    totalEvents: events.length,
    paths,
    statuses,
    criticalMismatches,
    fallbackInvocations,
  };
}

export function writeParityReport(basePath: string): UokParityReport {
  const sourcePath = parityLogPath(basePath);
  const raw = existsSync(sourcePath) ? readFileSync(sourcePath, "utf-8") : "";
  const report = buildParityReport(parseParityEvents(raw), sourcePath);
  mkdirSync(join(gsdRoot(basePath), "runtime"), { recursive: true });
  writeFileSync(reportPath(basePath), JSON.stringify(report, null, 2) + "\n", "utf-8");
  return report;
}
