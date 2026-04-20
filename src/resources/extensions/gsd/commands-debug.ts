import type { ExtensionAPI, ExtensionCommandContext } from "@gsd/pi-coding-agent";

import {
  assertValidDebugSessionSlug,
  createDebugSession,
  listDebugSessions,
  loadDebugSession,
  updateDebugSession,
  type DebugTddGate,
  type DebugSpecialistReview,
} from "./debug-session-store.js";
import { loadPrompt } from "./prompt-loader.js";

export type DebugCommandIntent
  = { type: "usage" }
  | { type: "issue-start"; issue: string }
  | { type: "list" }
  | { type: "status"; slug: string }
  | { type: "continue"; slug: string }
  | { type: "diagnose"; slug?: string }
  | { type: "diagnose-issue"; issue: string }
  | { type: "error"; message: string };

const SUBCOMMANDS = new Set(["list", "status", "continue", "--diagnose"]);

function isValidSlugCandidate(input: string): boolean {
  try {
    assertValidDebugSessionSlug(input);
    return true;
  } catch {
    return false;
  }
}

function formatSessionLine(prefix: string, session: {
  slug: string;
  mode: string;
  status: string;
  phase: string;
  issue: string;
  updatedAt: number;
}): string {
  return `${prefix} ${session.slug} [mode=${session.mode} status=${session.status} phase=${session.phase}] — ${session.issue} (updated ${new Date(session.updatedAt).toISOString()})`;
}

function usageText(): string {
  return [
    "Usage: /gsd debug <issue-text>",
    "       /gsd debug list",
    "       /gsd debug status <slug>",
    "       /gsd debug continue <slug>",
    "       /gsd debug --diagnose [<slug> | <issue text>]",
  ].join("\n");
}

export function parseDebugCommand(args: string): DebugCommandIntent {
  const raw = args.trim();
  if (!raw) return { type: "usage" };

  const parts = raw.split(/\s+/).filter(Boolean);
  const head = parts[0] ?? "";

  if (head === "list") {
    // Strict match only; otherwise treat as issue text for deterministic fallback behavior.
    if (parts.length === 1) return { type: "list" };
    return { type: "issue-start", issue: raw };
  }

  if (head === "status") {
    if (parts.length === 1) return { type: "error", message: "Missing slug. Usage: /gsd debug status <slug>" };
    if (parts.length === 2 && isValidSlugCandidate(parts[1])) return { type: "status", slug: parts[1] };
    return { type: "issue-start", issue: raw };
  }

  if (head === "continue") {
    if (parts.length === 1) return { type: "error", message: "Missing slug. Usage: /gsd debug continue <slug>" };
    if (parts.length === 2 && isValidSlugCandidate(parts[1])) return { type: "continue", slug: parts[1] };
    return { type: "issue-start", issue: raw };
  }

  if (head === "--diagnose") {
    if (parts.length === 1) return { type: "diagnose" };
    if (parts.length === 2 && isValidSlugCandidate(parts[1])) return { type: "diagnose", slug: parts[1] };
    if (parts.length >= 3) return { type: "diagnose-issue", issue: parts.slice(1).join(" ") };
    return { type: "error", message: "Invalid diagnose target. Usage: /gsd debug --diagnose [<slug> | <issue text>]" };
  }

  if (head.startsWith("-") && !SUBCOMMANDS.has(head)) {
    return { type: "error", message: `Unknown debug flag: ${head}.\n${usageText()}` };
  }

  return { type: "issue-start", issue: raw };
}

export async function handleDebug(args: string, ctx: ExtensionCommandContext, pi?: ExtensionAPI): Promise<void> {
  const parsed = parseDebugCommand(args);
  const basePath = process.cwd();

  if (parsed.type === "usage") {
    ctx.ui.notify(usageText(), "info");
    return;
  }

  if (parsed.type === "error") {
    ctx.ui.notify(parsed.message, "warning");
    return;
  }

  if (parsed.type === "issue-start") {
    const issue = parsed.issue.trim();
    if (!issue) {
      ctx.ui.notify(`Issue text is required.\n${usageText()}`, "warning");
      return;
    }

    try {
      const created = createDebugSession(basePath, { issue });
      const s = created.session;
      ctx.ui.notify(
        [
          `Debug session started: ${s.slug}`,
          formatSessionLine("Session:", s),
          `Artifact: ${created.artifactPath}`,
          `Log: ${s.logPath}`,
          `Next: /gsd debug status ${s.slug} or /gsd debug continue ${s.slug}`,
        ].join("\n"),
        "info",
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(
        `Unable to create debug session: ${message}\nTry /gsd debug --diagnose for artifact health details.`,
        "error",
      );
    }
    return;
  }

  if (parsed.type === "list") {
    try {
      const listed = listDebugSessions(basePath);
      if (listed.sessions.length === 0 && listed.malformed.length === 0) {
        ctx.ui.notify("No debug sessions found. Start one with: /gsd debug <issue-text>", "info");
        return;
      }

      const lines: string[] = [];
      if (listed.sessions.length > 0) {
        lines.push("Debug sessions:");
        for (const record of listed.sessions) {
          lines.push(formatSessionLine("  -", record.session));
        }
      }

      if (listed.malformed.length > 0) {
        lines.push("");
        lines.push(`Malformed artifacts: ${listed.malformed.length}`);
        for (const bad of listed.malformed.slice(0, 5)) {
          lines.push(`  - ${bad.artifactPath} :: ${bad.message}`);
        }
        if (listed.malformed.length > 5) {
          lines.push(`  ... and ${listed.malformed.length - 5} more`);
        }
        lines.push("Run /gsd debug --diagnose for remediation guidance.");
      }

      ctx.ui.notify(lines.join("\n"), "info");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(
        `Unable to list debug sessions: ${message}\nRun /gsd debug --diagnose for details.`,
        "warning",
      );
    }
    return;
  }

  if (parsed.type === "status") {
    try {
      const loaded = loadDebugSession(basePath, parsed.slug);
      if (!loaded) {
        ctx.ui.notify(
          `Unknown debug session slug '${parsed.slug}'. Run /gsd debug list to see available sessions.`,
          "warning",
        );
        return;
      }

      const s = loaded.session;
      ctx.ui.notify(
        [
          `Debug session status: ${s.slug}`,
          `mode=${s.mode}`,
          `status=${s.status}`,
          `phase=${s.phase}`,
          `issue=${s.issue}`,
          `artifact=${loaded.artifactPath}`,
          `log=${s.logPath}`,
          `updated=${new Date(s.updatedAt).toISOString()}`,
          `lastError=${s.lastError ?? "none"}`,
        ].join("\n"),
        "info",
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(
        `Unable to load debug session '${parsed.slug}': ${message}\nTry /gsd debug --diagnose ${parsed.slug}`,
        "warning",
      );
    }
    return;
  }

  if (parsed.type === "continue") {
    try {
      const loaded = loadDebugSession(basePath, parsed.slug);
      if (!loaded) {
        ctx.ui.notify(
          `Unknown debug session slug '${parsed.slug}'. Run /gsd debug list to see available sessions.`,
          "warning",
        );
        return;
      }

      if (loaded.session.status === "resolved") {
        ctx.ui.notify(
          `Session '${parsed.slug}' is resolved. Open a new session with /gsd debug <issue-text> for follow-up work.`,
          "warning",
        );
        return;
      }

      // Determine checkpoint/TDD/specialist dispatch context before updating session state.
      const checkpoint = loaded.session.checkpoint;
      const tddGate = loaded.session.tddGate;
      const specialistReview: DebugSpecialistReview | null | undefined = loaded.session.specialistReview;
      const hasCheckpoint = checkpoint != null && checkpoint.awaitingResponse;
      const hasTddGate = tddGate != null && tddGate.enabled;

      let dispatchTemplate = "debug-diagnose";
      let goal = "find_and_fix";
      let dispatchModeLabel = "find_and_fix";
      let checkpointContext = "";
      let tddContext = "";
      let specialistContext = "";
      let tddGateUpdate: DebugTddGate | undefined;

      if (hasCheckpoint || hasTddGate) {
        dispatchTemplate = "debug-session-manager";

        if (hasCheckpoint) {
          const cpLines = [
            `## Active Checkpoint`,
            `- type: ${checkpoint.type}`,
            `- summary: ${checkpoint.summary}`,
          ];
          if (checkpoint.userResponse) {
            cpLines.push(`- userResponse:\n\nDATA_START\n${checkpoint.userResponse}\nDATA_END`);
          } else {
            cpLines.push(`- awaitingResponse: true`);
          }
          checkpointContext = cpLines.join("\n");
          dispatchModeLabel = `checkpointType=${checkpoint.type}`;
        }

        if (hasTddGate) {
          if (tddGate.phase === "red") {
            goal = "find_and_fix";
            const tddLines = [
              `## TDD Gate`,
              `- phase: red → green`,
            ];
            if (tddGate.testFile) tddLines.push(`- testFile: ${tddGate.testFile}`);
            if (tddGate.testName) tddLines.push(`- testName: ${tddGate.testName}`);
            if (tddGate.failureOutput) tddLines.push(`- failureOutput:\n${tddGate.failureOutput}`);
            tddLines.push(`The failing test has been confirmed. Proceed to implement the fix that makes this test pass.`);
            tddContext = tddLines.join("\n");
            tddGateUpdate = { ...tddGate, phase: "green" };
            dispatchModeLabel = "tddPhase=red→green";
          } else if (tddGate.phase === "green") {
            goal = "find_and_fix";
            const tddLines = [
              `## TDD Gate`,
              `- phase: green`,
            ];
            if (tddGate.testFile) tddLines.push(`- testFile: ${tddGate.testFile}`);
            if (tddGate.testName) tddLines.push(`- testName: ${tddGate.testName}`);
            tddLines.push(`The test is now passing. Continue verifying the fix.`);
            tddContext = tddLines.join("\n");
            dispatchModeLabel = "tddPhase=green";
          } else {
            // phase === "pending": investigate only, do not fix yet
            goal = "find_root_cause_only";
            const tddLines = [
              `## TDD Gate`,
              `- phase: pending`,
              `TDD mode is active. Write a failing test that captures this bug first. Do NOT fix the issue yet.`,
            ];
            if (tddGate.testFile) tddLines.push(`- testFile: ${tddGate.testFile}`);
            tddContext = tddLines.join("\n");
            dispatchModeLabel = "tddPhase=pending";
          }
        } else {
          // Checkpoint only, no TDD gate — apply fix after human response
          goal = "find_and_fix";
        }
      }

      // Build specialistContext from session's specialistReview field (null/undefined → empty string).
      if (specialistReview != null) {
        specialistContext = [
          `## Prior Specialist Review`,
          `- hint: ${specialistReview.hint}`,
          `- skill: ${specialistReview.skill ?? ""}`,
          `- verdict: ${specialistReview.verdict}`,
          `- detail: ${specialistReview.detail}`,
        ].join("\n");
        dispatchModeLabel += ` specialistHint=${specialistReview.hint}`;
      }

      // Update session state BEFORE dispatch — handler returns after sendMessage.
      const resumed = updateDebugSession(basePath, parsed.slug, {
        status: "active",
        phase: "continued",
        lastError: null,
        ...(tddGateUpdate !== undefined ? { tddGate: tddGateUpdate } : {}),
      });

      const canDispatch = pi != null && typeof (pi as ExtensionAPI).sendMessage === "function";
      const dispatchNote = canDispatch ? `\ndispatchMode=${dispatchModeLabel}` : "";
      ctx.ui.notify(
        [
          `Resumed debug session: ${resumed.session.slug}`,
          formatSessionLine("Session:", resumed.session),
          `Log: ${resumed.session.logPath}`,
          `Next: /gsd debug status ${resumed.session.slug}`,
        ].join("\n") + dispatchNote,
        "info",
      );

      if (canDispatch) {
        try {
          const promptVars: Record<string, string> = {
            goal,
            issue: resumed.session.issue,
            slug: resumed.session.slug,
            mode: resumed.session.mode,
            workingDirectory: basePath,
          };
          if (dispatchTemplate === "debug-session-manager") {
            promptVars.checkpointContext = checkpointContext;
            promptVars.tddContext = tddContext;
            promptVars.specialistContext = specialistContext;
          }
          const prompt = loadPrompt(dispatchTemplate, promptVars);
          pi.sendMessage(
            { customType: "gsd-debug-continue", content: prompt, display: false },
            { triggerTurn: true },
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          ctx.ui.notify(
            `Continue dispatch failed: ${msg}\nSession '${resumed.session.slug}' is persisted; retry with /gsd debug continue ${resumed.session.slug}`,
            "warning",
          );
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(
        `Unable to continue debug session '${parsed.slug}': ${message}\nTry /gsd debug --diagnose ${parsed.slug}`,
        "warning",
      );
    }
    return;
  }

  if (parsed.type === "diagnose-issue") {
    const issue = parsed.issue.trim();
    if (!issue) {
      ctx.ui.notify(`Issue text is required.\n${usageText()}`, "warning");
      return;
    }

    try {
      const created = createDebugSession(basePath, { issue, mode: "diagnose" });
      const s = created.session;
      ctx.ui.notify(
        [
          `Diagnose session started: ${s.slug}`,
          formatSessionLine("Session:", s),
          `Artifact: ${created.artifactPath}`,
          `Log: ${s.logPath}`,
          `dispatchMode=find_root_cause_only`,
          `Next: /gsd debug status ${s.slug} or /gsd debug --diagnose ${s.slug}`,
        ].join("\n"),
        "info",
      );

      if (pi && typeof pi.sendMessage === "function") {
        try {
          const prompt = loadPrompt("debug-diagnose", {
            goal: "find_root_cause_only",
            issue: s.issue,
            slug: s.slug,
            mode: s.mode,
            workingDirectory: basePath,
          });
          pi.sendMessage(
            { customType: "gsd-debug-diagnose", content: prompt, display: false },
            { triggerTurn: true },
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          ctx.ui.notify(
            `Diagnose dispatch failed: ${msg}\nSession '${s.slug}' is persisted; continue manually with /gsd debug continue ${s.slug}`,
            "warning",
          );
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(
        `Unable to create diagnose session: ${message}\nTry /gsd debug --diagnose for artifact health details.`,
        "error",
      );
    }
    return;
  }

  if (parsed.type === "diagnose") {
    try {
      const listed = listDebugSessions(basePath);

      if (parsed.slug) {
        const loaded = loadDebugSession(basePath, parsed.slug);
        if (!loaded) {
          ctx.ui.notify(
            `Diagnose: session '${parsed.slug}' not found.\nRun /gsd debug list to discover valid slugs.`,
            "warning",
          );
          return;
        }

        const s = loaded.session;
        ctx.ui.notify(
          [
            `Diagnose session: ${s.slug}`,
            `mode=${s.mode}`,
            `status=${s.status}`,
            `phase=${s.phase}`,
            `artifact=${loaded.artifactPath}`,
            `log=${s.logPath}`,
            `lastError=${s.lastError ?? "none"}`,
            `malformedArtifactsInStore=${listed.malformed.length}`,
          ].join("\n"),
          "info",
        );
        return;
      }

      const lines = [
        "Debug session diagnostics:",
        `healthySessions=${listed.sessions.length}`,
        `malformedArtifacts=${listed.malformed.length}`,
      ];

      if (listed.malformed.length > 0) {
        lines.push("");
        lines.push("Malformed artifacts (first 10):");
        for (const malformed of listed.malformed.slice(0, 10)) {
          lines.push(`  - ${malformed.artifactPath}`);
          lines.push(`    ${malformed.message}`);
        }
        lines.push("Remediation: repair/remove malformed JSON artifacts under .gsd/debug/sessions/.");
      }

      ctx.ui.notify(lines.join("\n"), listed.malformed.length > 0 ? "warning" : "info");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Diagnose failed: ${message}`, "error");
    }
  }
}
