/**
 * /gsd migrate — one-shot migration from .planning to .gsd
 *
 * Thin UX orchestrator: resolves paths, runs the validate → parse → transform →
 * preview → write pipeline, and shows confirmation UI via showNextAction.
 * All business logic lives in the pipeline modules (S01–S03).
 *
 * After a successful write, offers an agent-driven review that audits the
 * output for GSD-2 standards compliance.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@gsd/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { showNextAction } from "../../shared/next-action-ui.js";
import {
  validatePlanningDirectory,
  parsePlanningDirectory,
  transformToGSD,
  generatePreview,
  writeGSDDirectory,
} from "./index.js";

import type { MigrationPreview } from "./writer.js";

/** Format preview stats for embedding in the review prompt. */
function formatPreviewStats(preview: MigrationPreview): string {
  const lines = [
    `- Milestones: ${preview.milestoneCount}`,
    `- Slices: ${preview.totalSlices} (${preview.doneSlices} done — ${preview.sliceCompletionPct}%)`,
    `- Tasks: ${preview.totalTasks} (${preview.doneTasks} done — ${preview.taskCompletionPct}%)`,
  ];
  if (preview.requirements.total > 0) {
    lines.push(
      `- Requirements: ${preview.requirements.total} (${preview.requirements.validated} validated, ${preview.requirements.active} active, ${preview.requirements.deferred} deferred)`,
    );
  }
  return lines.join("\n");
}

/** Load and interpolate the review-migration prompt template. */
function buildReviewPrompt(
  sourcePath: string,
  gsdPath: string,
  preview: MigrationPreview,
): string {
  const promptsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "prompts");
  const templatePath = join(promptsDir, "review-migration.md");
  let content = readFileSync(templatePath, "utf-8");

  content = content.replaceAll("{{sourcePath}}", sourcePath);
  content = content.replaceAll("{{gsdPath}}", gsdPath);
  content = content.replaceAll("{{previewStats}}", formatPreviewStats(preview));

  return content.trim();
}

/** Dispatch the review prompt to the agent. */
function dispatchReview(
  pi: ExtensionAPI,
  sourcePath: string,
  gsdPath: string,
  preview: MigrationPreview,
): void {
  const prompt = buildReviewPrompt(sourcePath, gsdPath, preview);

  pi.sendMessage(
    {
      customType: "gsd-migrate-review",
      content: prompt,
      display: false,
    },
    { triggerTurn: true },
  );
}

export async function handleMigrate(
  args: string,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
): Promise<void> {
  // ── Resolve source path ────────────────────────────────────────────────────
  // Default to cwd when no args given; expand ~ to HOME
  let rawPath = args.trim() || ".";
  if (rawPath.startsWith("~/")) {
    rawPath = join(process.env.HOME ?? "~", rawPath.slice(2));
  } else if (rawPath === "~") {
    rawPath = process.env.HOME ?? "~";
  }

  let sourcePath = resolve(process.cwd(), rawPath);
  if (!sourcePath.endsWith(".planning")) {
    sourcePath = join(sourcePath, ".planning");
  }

  if (!existsSync(sourcePath)) {
    ctx.ui.notify(
      `Directory not found: ${sourcePath}\n\n` +
      'Migration converts a .planning/ directory (from older GSD versions) into .gsd/ format.\n' +
      'If you are starting a new project, use /gsd:new-project instead.\n' +
      'If migrating, ensure the path contains a .planning/ directory.',
      "error",
    );
    return;
  }

  // ── Validate ───────────────────────────────────────────────────────────────
  const validation = await validatePlanningDirectory(sourcePath);

  const warnings = validation.issues.filter((i) => i.severity === "warning");
  const fatals = validation.issues.filter((i) => i.severity === "fatal");

  for (const w of warnings) {
    ctx.ui.notify(`⚠ ${w.message} (${w.file})`, "warning");
  }
  for (const f of fatals) {
    ctx.ui.notify(`✖ ${f.message} (${f.file})`, "error");
  }

  if (!validation.valid) {
    ctx.ui.notify(
      "Migration blocked — fix the fatal issues above before retrying.",
      "error",
    );
    return;
  }

  // ── Parse → Transform → Preview ───────────────────────────────────────────
  const parsed = await parsePlanningDirectory(sourcePath);
  const project = transformToGSD(parsed);
  const preview = generatePreview(project);

  // ── Build preview text ─────────────────────────────────────────────────────
  const lines: string[] = [
    `Milestones: ${preview.milestoneCount}`,
    `Slices: ${preview.totalSlices} (${preview.doneSlices} done — ${preview.sliceCompletionPct}%)`,
    `Tasks: ${preview.totalTasks} (${preview.doneTasks} done — ${preview.taskCompletionPct}%)`,
  ];

  if (preview.requirements.total > 0) {
    lines.push(
      `Requirements: ${preview.requirements.total} (${preview.requirements.validated} validated, ${preview.requirements.active} active, ${preview.requirements.deferred} deferred)`,
    );
  }

  const targetGsdExists = existsSync(join(process.cwd(), ".gsd"));
  if (targetGsdExists) {
    lines.push("");
    lines.push("⚠ A .gsd directory already exists in the current working directory — it will be overwritten.");
  }

  // ── Confirmation via showNextAction ────────────────────────────────────────
  const choice = await showNextAction(ctx, {
    title: "Migration preview",
    summary: lines,
    actions: [
      {
        id: "confirm",
        label: "Write .gsd directory",
        description: `Migrate ${preview.milestoneCount} milestone(s) to ${process.cwd()}/.gsd`,
        recommended: true,
      },
      {
        id: "cancel",
        label: "Cancel",
        description: "Exit without writing anything",
      },
    ],
    notYetMessage: "Run /gsd migrate again when ready.",
  });

  if (choice !== "confirm") {
    ctx.ui.notify("Migration cancelled — no files were written.", "info");
    return;
  }

  // ── Write ──────────────────────────────────────────────────────────────────
  ctx.ui.notify("Writing .gsd directory…", "info");

  const result = await writeGSDDirectory(project, process.cwd());
  const gsdPath = join(process.cwd(), ".gsd");

  ctx.ui.notify(
    `✓ Migration complete — ${result.paths.length} file(s) written to .gsd/`,
    "info",
  );

  // ── Post-write review offer ────────────────────────────────────────────────
  const reviewChoice = await showNextAction(ctx, {
    title: "Migration written",
    summary: [
      `${result.paths.length} files written to .gsd/`,
      "",
      "The agent can now review the migrated output against GSD-2 standards —",
      "checking structure, content quality, deriveState() round-trip, and",
      "requirement statuses. It will fix minor issues in-place.",
    ],
    actions: [
      {
        id: "review",
        label: "Review migration",
        description: "Agent audits the .gsd output and reports PASS/FAIL per category",
        recommended: true,
      },
      {
        id: "skip",
        label: "Skip review",
        description: "Trust the migration output as-is",
      },
    ],
    notYetMessage: "Run /gsd migrate again to re-migrate, or review .gsd manually.",
  });

  if (reviewChoice === "review") {
    dispatchReview(pi, sourcePath, gsdPath, preview);
  }
}
