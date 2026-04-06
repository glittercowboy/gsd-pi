import type { ExtensionAPI, ExtensionCommandContext } from "@gsd/pi-coding-agent";

import { enableDebug } from "../../debug-logger.js";
import { dispatchDirectPhase } from "../../auto-direct-dispatch.js";
import { handleConfig } from "../../commands-config.js";
import { handleDoctor, handleCapture, handleKnowledge, handleRunHook, handleSkillHealth, handleSteer, handleTriage, handleUpdate } from "../../commands-handlers.js";
import { handleInspect } from "../../commands-inspect.js";
import { handleLogs } from "../../commands-logs.js";
import { handleCleanupBranches, handleCleanupSnapshots, handleSkip, handleCleanupProjects, handleCleanupWorktrees, handleRecover } from "../../commands-maintenance.js";
import { handleExport } from "../../export.js";
import { handleHistory } from "../../history.js";
import { handleUndo } from "../../undo.js";
import { handleRemote } from "../../../remote-questions/mod.js";
import { projectRoot } from "../context.js";

export async function handleOpsCommand(trimmed: string, ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<boolean> {
  if (trimmed === "init") {
    const { detectProjectState } = await import("../../detection.js");
    const { handleReinit, showProjectInit } = await import("../../init-wizard.js");
    const basePath = projectRoot();
    const detection = detectProjectState(basePath);
    if (detection.state === "v2-gsd" || detection.state === "v2-gsd-empty") {
      await handleReinit(ctx, detection);
    } else {
      await showProjectInit(ctx, pi, basePath, detection);
    }
    return true;
  }
  if (trimmed === "keys" || trimmed.startsWith("keys ")) {
    const { handleKeys } = await import("../../key-manager.js");
    await handleKeys(trimmed.replace(/^keys\s*/, "").trim(), ctx);
    return true;
  }
  if (trimmed === "doctor" || trimmed.startsWith("doctor ")) {
    await handleDoctor(trimmed.replace(/^doctor\s*/, "").trim(), ctx, pi);
    return true;
  }
  if (trimmed === "logs" || trimmed.startsWith("logs ")) {
    await handleLogs(trimmed.replace(/^logs\s*/, "").trim(), ctx);
    return true;
  }
  if (trimmed === "forensics" || trimmed.startsWith("forensics ")) {
    const { handleForensics } = await import("../../forensics.js");
    await handleForensics(trimmed.replace(/^forensics\s*/, "").trim(), ctx, pi);
    return true;
  }
  if (trimmed === "changelog" || trimmed.startsWith("changelog ")) {
    const { handleChangelog } = await import("../../changelog.js");
    await handleChangelog(trimmed.replace(/^changelog\s*/, "").trim(), ctx, pi);
    return true;
  }
  if (trimmed === "history" || trimmed.startsWith("history ")) {
    await handleHistory(trimmed.replace(/^history\s*/, "").trim(), ctx, projectRoot());
    return true;
  }
  if (trimmed === "undo-task" || trimmed.startsWith("undo-task ")) {
    const { handleUndoTask } = await import("../../undo.js");
    await handleUndoTask(trimmed.replace(/^undo-task\s*/, "").trim(), ctx, pi, projectRoot());
    return true;
  }
  if (trimmed === "reset-slice" || trimmed.startsWith("reset-slice ")) {
    const { handleResetSlice } = await import("../../undo.js");
    await handleResetSlice(trimmed.replace(/^reset-slice\s*/, "").trim(), ctx, pi, projectRoot());
    return true;
  }
  if (trimmed === "undo" || trimmed.startsWith("undo ")) {
    await handleUndo(trimmed.replace(/^undo\s*/, "").trim(), ctx, pi, projectRoot());
    return true;
  }
  if (trimmed === "skip") {
    ctx.ui.notify("Usage: /gsd skip <unit-id>  Example: /gsd skip M001/S01/T03", "warning");
    return true;
  }
  if (trimmed.startsWith("skip ")) {
    await handleSkip(trimmed.replace(/^skip\s*/, "").trim(), ctx, projectRoot());
    return true;
  }
  if (trimmed === "recover") {
    await handleRecover(ctx, projectRoot());
    return true;
  }
  if (trimmed === "export" || trimmed.startsWith("export ")) {
    await handleExport(trimmed.replace(/^export\s*/, "").trim(), ctx, projectRoot());
    return true;
  }
  if (trimmed === "cleanup projects" || trimmed.startsWith("cleanup projects ")) {
    await handleCleanupProjects(trimmed.replace(/^cleanup projects\s*/, "").trim(), ctx);
    return true;
  }
  if (trimmed === "cleanup worktrees") {
    await handleCleanupWorktrees(ctx, projectRoot());
    return true;
  }
  if (trimmed === "cleanup") {
    await handleCleanupBranches(ctx, projectRoot());
    await handleCleanupSnapshots(ctx, projectRoot());
    return true;
  }
  if (trimmed === "cleanup branches") {
    await handleCleanupBranches(ctx, projectRoot());
    return true;
  }
  if (trimmed === "cleanup snapshots") {
    await handleCleanupSnapshots(ctx, projectRoot());
    return true;
  }
  if (trimmed.startsWith("capture ") || trimmed === "capture") {
    await handleCapture(trimmed.replace(/^capture\s*/, "").trim(), ctx);
    return true;
  }
  if (trimmed === "triage") {
    await handleTriage(ctx, pi, process.cwd());
    return true;
  }
  if (trimmed === "config") {
    await handleConfig(ctx);
    return true;
  }
  if (trimmed === "hooks") {
    const { formatHookStatus } = await import("../../post-unit-hooks.js");
    ctx.ui.notify(formatHookStatus(), "info");
    return true;
  }
  if (trimmed === "skill-health" || trimmed.startsWith("skill-health ")) {
    await handleSkillHealth(trimmed.replace(/^skill-health\s*/, "").trim(), ctx);
    return true;
  }
  if (trimmed.startsWith("run-hook ")) {
    await handleRunHook(trimmed.replace(/^run-hook\s*/, "").trim(), ctx, pi);
    return true;
  }
  if (trimmed === "run-hook") {
    ctx.ui.notify(`Usage: /gsd run-hook <hook-name> <unit-type> <unit-id>

Unit types:
  execute-task   - Task execution (unit-id: M001/S01/T01)
  plan-slice     - Slice planning (unit-id: M001/S01)
  research-milestone - Milestone research (unit-id: M001)
  complete-slice - Slice completion (unit-id: M001/S01)
  complete-milestone - Milestone completion (unit-id: M001)

Examples:
  /gsd run-hook code-review execute-task M001/S01/T01
  /gsd run-hook lint-check plan-slice M001/S01`, "warning");
    return true;
  }
  if (trimmed.startsWith("steer ")) {
    await handleSteer(trimmed.replace(/^steer\s+/, "").trim(), ctx, pi);
    return true;
  }
  if (trimmed === "steer") {
    ctx.ui.notify("Usage: /gsd steer <description of change>. Example: /gsd steer Use Postgres instead of SQLite", "warning");
    return true;
  }
  if (trimmed.startsWith("knowledge ")) {
    await handleKnowledge(trimmed.replace(/^knowledge\s+/, "").trim(), ctx);
    return true;
  }
  if (trimmed === "knowledge") {
    ctx.ui.notify("Usage: /gsd knowledge <rule|pattern|lesson> <description>. Example: /gsd knowledge rule Use real DB for integration tests", "warning");
    return true;
  }
  if (trimmed === "migrate" || trimmed.startsWith("migrate ")) {
    const { handleMigrate } = await import("../../migrate/command.js");
    await handleMigrate(trimmed.replace(/^migrate\s*/, "").trim(), ctx, pi);
    return true;
  }
  if (trimmed === "remote" || trimmed.startsWith("remote ")) {
    await handleRemote(trimmed.replace(/^remote\s*/, "").trim(), ctx, pi);
    return true;
  }
  if (trimmed === "dispatch" || trimmed.startsWith("dispatch ")) {
    const phase = trimmed.replace(/^dispatch\s*/, "").trim();
    if (!phase) {
      ctx.ui.notify("Usage: /gsd dispatch <phase>  (research|plan|execute|complete|reassess|uat|replan)", "warning");
      return true;
    }
    await dispatchDirectPhase(ctx, pi, phase, projectRoot());
    return true;
  }
  if (trimmed === "notifications" || trimmed.startsWith("notifications ")) {
    const { handleNotificationsCommand } = await import("./notifications-handler.js");
    await handleNotificationsCommand(trimmed.replace(/^notifications\s*/, "").trim(), ctx, pi);
    return true;
  }
  if (trimmed === "inspect") {
    await handleInspect(ctx);
    return true;
  }
  if (trimmed === "update") {
    await handleUpdate(ctx);
    return true;
  }
  if (trimmed === "fast" || trimmed.startsWith("fast ")) {
    const { handleFast } = await import("../../service-tier.js");
    await handleFast(trimmed.replace(/^fast\s*/, "").trim(), ctx);
    return true;
  }
  if (trimmed === "mcp" || trimmed.startsWith("mcp ")) {
    const { handleMcpStatus } = await import("../../commands-mcp-status.js");
    await handleMcpStatus(trimmed.replace(/^mcp\s*/, "").trim(), ctx);
    return true;
  }
  if (trimmed === "extensions" || trimmed.startsWith("extensions ")) {
    const { handleExtensions } = await import("../../commands-extensions.js");
    await handleExtensions(trimmed.replace(/^extensions\s*/, "").trim(), ctx);
    return true;
  }
  if (trimmed === "rethink") {
    const { handleRethink } = await import("../../rethink.js");
    await handleRethink(trimmed, ctx, pi);
    return true;
  }
  if (trimmed === "codebase" || trimmed.startsWith("codebase ")) {
    const { handleCodebase } = await import("../../commands-codebase.js");
    await handleCodebase(trimmed.replace(/^codebase\s*/, "").trim(), ctx, pi);
    return true;
  }
  return false;
}
