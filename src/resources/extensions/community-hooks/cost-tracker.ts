// GSD Community Hooks — Cost Tracker
//
// Tracks token usage across turns and sessions. Persists cost data to a local
// JSON file and notifies when spending approaches a configurable budget limit.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import type { ExtensionAPI } from "@gsd/pi-coding-agent";
import { recordFire, recordAction } from "./stats.js";

/** Pricing per 1M tokens (USD). Updated for common models as of 2025. */
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  "claude-opus-4-6":          { input: 15, output: 75 },
  "claude-sonnet-4-6":        { input: 3, output: 15 },
  "claude-haiku-4-5":         { input: 0.8, output: 4 },
  "gpt-4o":                   { input: 2.5, output: 10 },
  "gpt-4o-mini":              { input: 0.15, output: 0.6 },
  "o3":                       { input: 10, output: 40 },
  "o4-mini":                  { input: 1.1, output: 4.4 },
  "gemini-2.5-pro":           { input: 1.25, output: 10 },
  "gemini-2.5-flash":         { input: 0.15, output: 0.6 },
  "deepseek-r1":              { input: 0.55, output: 2.19 },
  "llama-4-maverick":         { input: 0.2, output: 0.6 },
};

interface SessionCost {
  sessionId: string;
  startedAt: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  turns: number;
}

interface CostData {
  sessions: SessionCost[];
  totalCostUsd: number;
  budgetUsd?: number;
  /** ISO date of last budget alert. */
  lastAlert?: string;
}

interface CostConfig {
  /** Monthly budget in USD. Notifications fire at 50%, 80%, 100%. */
  budgetUsd?: number;
  /** Whether to show per-turn cost notifications. Default: false. */
  showPerTurn?: boolean;
}

function getCostFilePath(): string {
  const configDir = process.env.PI_CONFIG_DIR || ".gsd";
  return join(homedir(), configDir, "cost-tracker.json");
}

function loadCostData(): CostData {
  const path = getCostFilePath();
  if (!existsSync(path)) return { sessions: [], totalCostUsd: 0 };
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return { sessions: [], totalCostUsd: 0 };
  }
}

function saveCostData(data: CostData): void {
  const path = getCostFilePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2));
}

function loadCostConfig(): CostConfig {
  const configDir = process.env.PI_CONFIG_DIR || ".gsd";
  const paths = [
    join(process.cwd(), configDir, "settings.json"),
    join(homedir(), configDir, "agent", "settings.json"),
  ];
  for (const p of paths) {
    if (!existsSync(p)) continue;
    try {
      const settings = JSON.parse(readFileSync(p, "utf-8"));
      if (settings.costTracker) return settings.costTracker;
    } catch { /* skip */ }
  }
  return {};
}

function findPricing(modelId: string): { input: number; output: number } {
  // Try exact match first, then prefix match
  if (MODEL_PRICING[modelId]) return MODEL_PRICING[modelId];
  for (const [key, pricing] of Object.entries(MODEL_PRICING)) {
    if (modelId.startsWith(key) || modelId.includes(key)) return pricing;
  }
  // Default fallback — Sonnet-tier pricing
  return { input: 3, output: 15 };
}

function estimateCost(inputTokens: number, outputTokens: number, modelId: string): number {
  const pricing = findPricing(modelId);
  return (inputTokens / 1_000_000) * pricing.input + (outputTokens / 1_000_000) * pricing.output;
}

function formatUsd(amount: number): string {
  if (amount < 0.01) return `$${amount.toFixed(4)}`;
  return `$${amount.toFixed(2)}`;
}

/** Get the current month's total cost. */
function getMonthlyTotal(data: CostData): number {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  return data.sessions
    .filter((s) => s.startedAt >= monthStart)
    .reduce((sum, s) => sum + s.estimatedCostUsd, 0);
}

export function registerCostTracker(pi: ExtensionAPI): void {
  const config = loadCostConfig();
  let currentSession: SessionCost | null = null;

  pi.on("session_start", async () => {
    currentSession = {
      sessionId: `session-${Date.now()}`,
      startedAt: new Date().toISOString(),
      model: "unknown",
      inputTokens: 0,
      outputTokens: 0,
      estimatedCostUsd: 0,
      turns: 0,
    };
  });

  pi.on("model_select", async (event) => {
    if (currentSession) {
      currentSession.model = event.model?.id ?? "unknown";
    }
  });

  pi.on("turn_end", async (event, ctx) => {
    if (!currentSession) return;

    recordFire("costTracker");
    currentSession.turns++;

    // Extract token usage from the assistant message if available
    const msg = event.message as Record<string, unknown>;
    const usage = msg?.usage as { input_tokens?: number; output_tokens?: number } | undefined;

    if (usage) {
      currentSession.inputTokens += usage.input_tokens ?? 0;
      currentSession.outputTokens += usage.output_tokens ?? 0;
      currentSession.estimatedCostUsd = estimateCost(
        currentSession.inputTokens,
        currentSession.outputTokens,
        currentSession.model,
      );

      if (config.showPerTurn) {
        const turnCost = estimateCost(
          usage.input_tokens ?? 0,
          usage.output_tokens ?? 0,
          currentSession.model,
        );
        ctx.ui.setStatus("cost-tracker", `Session: ${formatUsd(currentSession.estimatedCostUsd)} (turn: ${formatUsd(turnCost)})`);
      }
    }

    // Check budget thresholds
    if (config.budgetUsd) {
      const data = loadCostData();
      const monthly = getMonthlyTotal(data) + currentSession.estimatedCostUsd;
      const pct = (monthly / config.budgetUsd) * 100;

      const today = new Date().toISOString().slice(0, 10);
      if (data.lastAlert !== today) {
        if (pct >= 100) {
          ctx.ui.notify(`Budget exceeded: ${formatUsd(monthly)} / ${formatUsd(config.budgetUsd)} (${pct.toFixed(0)}%)`, "error");
          data.lastAlert = today;
          saveCostData(data);
        } else if (pct >= 80) {
          ctx.ui.notify(`Budget warning: ${formatUsd(monthly)} / ${formatUsd(config.budgetUsd)} (${pct.toFixed(0)}%)`, "warning");
          data.lastAlert = today;
          saveCostData(data);
        } else if (pct >= 50) {
          ctx.ui.notify(`Budget update: ${formatUsd(monthly)} / ${formatUsd(config.budgetUsd)} (${pct.toFixed(0)}%)`, "info");
          data.lastAlert = today;
          saveCostData(data);
        }
      }
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (!currentSession || currentSession.turns === 0) return;

    const data = loadCostData();
    data.sessions.push(currentSession);
    data.totalCostUsd += currentSession.estimatedCostUsd;
    if (config.budgetUsd) data.budgetUsd = config.budgetUsd;
    saveCostData(data);

    ctx.ui.notify(
      `Session cost: ${formatUsd(currentSession.estimatedCostUsd)} (${currentSession.turns} turns, ${currentSession.inputTokens + currentSession.outputTokens} tokens)`,
      "info",
    );
  });
}
