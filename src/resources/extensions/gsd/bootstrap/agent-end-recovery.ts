import type { ExtensionAPI, ExtensionContext } from "@gsd/pi-coding-agent";

import { logWarning } from "../workflow-logger.js";
import {
  checkAutoStartAfterDiscuss,
  maybeHandleReadyPhraseWithoutFiles,
  maybeHandleEmptyIntentTurn,
  resetEmptyTurnCounter,
} from "../guided-flow.js";
import { clearPathCache } from "../paths.js";
import { getAutoDashboardData, getAutoModeStartModel, isAutoActive, pauseAuto, setCurrentDispatchedModelId } from "../auto.js";
import { getNextFallbackModel, resolveModelWithFallbacksForUnit } from "../preferences.js";
import { pauseAutoForProviderError } from "../provider-error-pause.js";
import { isSessionSwitchInFlight, resolveAgentEnd } from "../auto-loop.js";
import { resolveModelId } from "../auto-model-selection.js";
import { clearDiscussionFlowState } from "./write-gate.js";
import { resumeAutoAfterProviderDelay } from "./provider-error-resume.js";
import {
  classifyError,
  createRetryState,
  resetRetryState,
  isTransient,
  type ErrorClass,
} from "../error-classifier.js";
import { blockModel, isModelBlocked } from "../blocked-models.js";

const retryState = createRetryState();
const MAX_NETWORK_RETRIES = 2;
/**
 * Cap on auto-resume attempts for sustained transient-provider errors.
 *
 * Exported so tests assert against the shared constant instead of
 * regex-scraping the source literal (see #4837). Raising this value to
 * handle longer provider overloads should update the single constant; the
 * test in provider-errors.test.ts consumes it directly.
 */
export const MAX_TRANSIENT_AUTO_RESUMES = 8;

/**
 * Reset the module-level retry state so a resumed auto-session starts fresh.
 * Called by provider-error-resume.ts before startAuto() — without this, the
 * consecutiveTransientCount accumulates across pause/resume cycles and locks
 * out auto-resume after MAX_TRANSIENT_AUTO_RESUMES total (not consecutive) errors.
 */
export function resetTransientRetryState(): void {
  resetRetryState(retryState);
}

async function pauseTransientWithBackoff(
  cls: ErrorClass,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  errorDetail: string,
  isRateLimit: boolean,
): Promise<void> {
  retryState.consecutiveTransientCount += 1;
  const baseRetryAfterMs = "retryAfterMs" in cls ? cls.retryAfterMs : 15_000;
  const retryAfterMs = baseRetryAfterMs * 2 ** Math.max(0, retryState.consecutiveTransientCount - 1);
  const allowAutoResume = retryState.consecutiveTransientCount <= MAX_TRANSIENT_AUTO_RESUMES;
  if (!allowAutoResume) {
    ctx.ui.notify(`Transient provider errors persisted after ${MAX_TRANSIENT_AUTO_RESUMES} auto-resume attempts. Pausing for manual review.`, "warning");
  }
  await pauseAutoForProviderError(ctx.ui, errorDetail, () => pauseAuto(ctx, pi, {
    message: `Provider error: ${errorDetail}`,
    category: "provider",
    isTransient: allowAutoResume,
    retryAfterMs,
  }), {
    isRateLimit,
    isTransient: allowAutoResume,
    retryAfterMs,
    resume: allowAutoResume
      ? () => {
        void resumeAutoAfterProviderDelay(pi, ctx).catch((err) => {
          const message = err instanceof Error ? err.message : String(err);
          ctx.ui.notify(`Provider error recovery delay elapsed, but auto-mode failed to resume: ${message}`, "error");
        });
      }
      : undefined,
  });
}

export async function handleAgentEnd(
  pi: ExtensionAPI,
  event: { messages: any[] },
  ctx: ExtensionContext,
): Promise<void> {
  // #4648 — Invalidate the directory-listing cache before any artifact-existence
  // checks. The LLM may have written milestone files (CONTEXT.md, ROADMAP.md,
  // PROJECT.md, REQUIREMENTS.md) via tool calls during the turn that just
  // ended. `paths.ts` caches readdir() results without a TTL, so without this
  // flush, `resolveMilestoneFile` returns the pre-write listing and the guards
  // below (`checkAutoStartAfterDiscuss` and `maybeHandleReadyPhraseWithoutFiles`)
  // falsely report files as missing — producing a spurious "ready signal
  // rejected" loop even though the files are on disk.
  clearPathCache();

  if (checkAutoStartAfterDiscuss()) {
    clearDiscussionFlowState();
    return;
  }

  // #4573 — When the LLM emits "Milestone X ready." but the required files
  // are missing, `checkAutoStartAfterDiscuss` returns false silently. Surface
  // that and nudge the LLM to complete the writes before the user hits the
  // downstream "All milestones complete" warning loop.
  if (maybeHandleReadyPhraseWithoutFiles(event)) return;

  // #4573 — Empty-turn recovery: if the LLM announced intent in prose but
  // emitted no tool calls, nudge it to execute. Fires only when auto-mode is
  // active or a discussion autostart is pending (non-auto interactive discuss
  // is user-driven). Runs before `isAutoActive` early return so pending
  // discussions (where isAutoActive may be false) still get recovered.
  if (maybeHandleEmptyIntentTurn(event, isAutoActive())) return;

  if (!isAutoActive()) return;
  if (isSessionSwitchInFlight()) return;

  const lastMsg = event.messages[event.messages.length - 1];
  if (lastMsg && "stopReason" in lastMsg && lastMsg.stopReason === "aborted") {
    // Empty content with aborted stopReason is a non-fatal agent stop (the LLM
    // chose to end without producing output). Only pause on genuine fatal aborts
    // that carry error context — e.g. errorMessage field or non-empty content
    // indicating a mid-stream failure. (#2695)
    const content = "content" in lastMsg ? lastMsg.content : undefined;
    const hasEmptyContent = Array.isArray(content) && content.length === 0;
    const hasErrorMessage = "errorMessage" in lastMsg && !!lastMsg.errorMessage;

    if (hasEmptyContent && !hasErrorMessage) {
      // Non-fatal: treat as a normal agent end so the loop can continue
      // instead of entering a stuck re-dispatch cycle.
      try {
        resetRetryState(retryState);
        resolveAgentEnd(event);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`Auto-mode error after empty-content abort: ${message}. Stopping auto-mode.`, "error");
        try { await pauseAuto(ctx, pi); } catch (e) { logWarning("bootstrap", `pauseAuto failed after empty-content abort: ${(e as Error).message}`); }
      }
      return;
    }

    await pauseAuto(ctx, pi);
    return;
  }
  if (lastMsg && "stopReason" in lastMsg && lastMsg.stopReason === "error") {
    // #3588: errorMessage can be useless (e.g. "success") while the real error
    // is in the assistant message text content. Fall back to content when
    // errorMessage looks uninformative.
    const rawErrorMsg = ("errorMessage" in lastMsg && lastMsg.errorMessage) ? String(lastMsg.errorMessage) : "";
    const isUseless = !rawErrorMsg || /^(success|ok|true|error|unknown)$/i.test(rawErrorMsg.trim());
    // #3588: When errorMessage is uninformative, extract the real error from
    // the assistant message text content for display purposes only.
    // Classification still uses rawErrorMsg to avoid false positives from prose.
    let displayMsg = rawErrorMsg;
    if (isUseless && "content" in lastMsg && Array.isArray(lastMsg.content)) {
      const textBlock = lastMsg.content.find((b: any) => b.type === "text" && b.text);
      if (textBlock) displayMsg = (textBlock as any).text.slice(0, 300);
    }
    const errorDetail = displayMsg ? `: ${displayMsg}` : "";
    const explicitRetryAfterMs = ("retryAfterMs" in lastMsg && typeof lastMsg.retryAfterMs === "number") ? lastMsg.retryAfterMs : undefined;

    // ── 1. Classify using rawErrorMsg to avoid prose false-positives ────
    const cls = classifyError(rawErrorMsg, explicitRetryAfterMs);

    // ── 1a. Unsupported-model: provider rejected this model for the current
    //        account/plan at request time (#4513).  Persist a block so the
    //        same dead model isn't reselected on the next /gsd auto restart,
    //        then try a fallback before pausing.
    if (cls.kind === "unsupported-model") {
      const dash = getAutoDashboardData();
      const rejectedProvider = ctx.model?.provider;
      const rejectedId = ctx.model?.id;
      if (dash.basePath && rejectedProvider && rejectedId) {
        try {
          blockModel(dash.basePath, rejectedProvider, rejectedId, rawErrorMsg || "unsupported for account");
          ctx.ui.notify(
            `Blocked ${rejectedProvider}/${rejectedId} for this project — provider rejected it for the current account.`,
            "warning",
          );
        } catch (err) {
          const m = err instanceof Error ? err.message : String(err);
          logWarning("bootstrap", `Failed to persist blocked model: ${m}`);
        }
      }

      // Try configured fallback chain, skipping anything already blocked.
      if (dash.currentUnit && dash.basePath) {
        const modelConfig = resolveModelWithFallbacksForUnit(dash.currentUnit.type);
        if (modelConfig && modelConfig.fallbacks.length > 0) {
          const availableModels = ctx.modelRegistry.getAvailable();
          let cursorModelId: string | undefined = ctx.model?.id;
          while (true) {
            const nextModelId = getNextFallbackModel(cursorModelId, modelConfig);
            if (!nextModelId) break;
            const candidate = resolveModelId(nextModelId, availableModels, ctx.model?.provider);
            if (candidate && !isModelBlocked(dash.basePath, candidate.provider, candidate.id)) {
              const ok = await pi.setModel(candidate, { persist: false });
              if (ok) {
                setCurrentDispatchedModelId({ provider: candidate.provider, id: candidate.id });
                ctx.ui.notify(
                  `Switched to fallback ${candidate.provider}/${candidate.id} after account entitlement rejection.`,
                  "warning",
                );
                pi.sendMessage(
                  { customType: "gsd-auto-timeout-recovery", content: "Continue execution.", display: false },
                  { triggerTurn: true },
                );
                return;
              }
            }
            cursorModelId = nextModelId;
          }
        }

        // Fallback chain exhausted — try the auto-mode start model if it isn't
        // the same one we just blocked and isn't itself blocked.
        const sessionModel = getAutoModeStartModel();
        if (
          sessionModel &&
          !(sessionModel.provider === rejectedProvider && sessionModel.id === rejectedId) &&
          !isModelBlocked(dash.basePath, sessionModel.provider, sessionModel.id)
        ) {
          const startModel = ctx.modelRegistry
            .getAvailable()
            .find((m) => m.provider === sessionModel.provider && m.id === sessionModel.id);
          if (startModel) {
            const ok = await pi.setModel(startModel, { persist: false });
            if (ok) {
              setCurrentDispatchedModelId({ provider: startModel.provider, id: startModel.id });
              ctx.ui.notify(
                `Restored auto-mode start model ${startModel.provider}/${startModel.id} after entitlement rejection.`,
                "warning",
              );
              pi.sendMessage(
                { customType: "gsd-auto-timeout-recovery", content: "Continue execution.", display: false },
                { triggerTurn: true },
              );
              return;
            }
          }
        }
      }

      // No usable fallback — pause with a clearly named message.
      const blockedLabel = rejectedProvider && rejectedId ? `${rejectedProvider}/${rejectedId}` : "current model";
      const pauseDetail = `Model ${blockedLabel} blocked for this account${errorDetail}. Configure a different model and restart /gsd auto.`;
      await pauseAutoForProviderError(ctx.ui, pauseDetail, () =>
        pauseAuto(ctx, pi, {
          message: pauseDetail,
          category: "provider",
          isTransient: false,
        }),
      {
        isRateLimit: false,
        isTransient: false,
        retryAfterMs: 0,
      });
      return;
    }

    // ── 1b. Defer to Core RetryHandler for most transient errors ────────
    // Core retries transient failures in-session after this handler.
    // Keep that behavior for non-rate-limit classes to avoid pause/retry races,
    // but let rate-limit continue into model fallback logic below (#4373).
    if (isTransient(cls) && cls.kind !== "rate-limit") {
      return;
    }

    // Cap rate-limit backoff for CLI-style providers (openai-codex, google-gemini-cli)
    // which use per-user quotas with shorter windows (#2922).
    if (cls.kind === "rate-limit") {
      const currentProvider = ctx.model?.provider;
      if (currentProvider === "openai-codex" || currentProvider === "google-gemini-cli") {
        cls.retryAfterMs = Math.min(cls.retryAfterMs, 30_000);
      }
    }

    // ── 2. Decide & Act ──────────────────────────────────────────────────

    // --- Network errors: same-model retry with backoff ---
    if (cls.kind === "network") {
      const currentModelId = ctx.model?.id ?? "unknown";
      if (retryState.currentRetryModelId !== currentModelId) {
        retryState.networkRetryCount = 0;
        retryState.currentRetryModelId = currentModelId;
      }
      if (retryState.networkRetryCount < MAX_NETWORK_RETRIES) {
        retryState.networkRetryCount += 1;
        retryState.consecutiveTransientCount += 1;
        const attempt = retryState.networkRetryCount;
        const delayMs = attempt * cls.retryAfterMs;
        ctx.ui.notify(`Network error on ${currentModelId}${errorDetail}. Retry ${attempt}/${MAX_NETWORK_RETRIES} in ${delayMs / 1000}s...`, "warning");
        setTimeout(() => {
          pi.sendMessage(
            { customType: "gsd-auto-timeout-recovery", content: "Continue execution — retrying after transient network error.", display: false },
            { triggerTurn: true },
          );
        }, delayMs);
        return;
      }
      // Network retries exhausted — fall through to model fallback
      retryState.networkRetryCount = 0;
      retryState.currentRetryModelId = undefined;
      ctx.ui.notify(`Network retries exhausted for ${currentModelId}. Attempting model fallback.`, "warning");
    }

    // --- Transient errors: try model fallback first, then pause ---
    // Rate limits are often per-model, so switching models can bypass them.
    if (cls.kind === "rate-limit" || cls.kind === "network" || cls.kind === "server" || cls.kind === "connection" || cls.kind === "stream") {
      // Try model fallback
      const dash = getAutoDashboardData();
      if (dash.currentUnit) {
        const modelConfig = resolveModelWithFallbacksForUnit(dash.currentUnit.type);
        if (modelConfig && modelConfig.fallbacks.length > 0) {
          const availableModels = ctx.modelRegistry.getAvailable();
          const nextModelId = getNextFallbackModel(ctx.model?.id, modelConfig);
          if (nextModelId) {
            retryState.networkRetryCount = 0;
            retryState.currentRetryModelId = undefined;
            const modelToSet = resolveModelId(nextModelId, availableModels, ctx.model?.provider);
            if (modelToSet) {
              const ok = await pi.setModel(modelToSet, { persist: false });
              if (ok) {
                setCurrentDispatchedModelId({ provider: modelToSet.provider, id: modelToSet.id });
                ctx.ui.notify(`Model error${errorDetail}. Switched to fallback: ${nextModelId} and resuming.`, "warning");
                pi.sendMessage({ customType: "gsd-auto-timeout-recovery", content: "Continue execution.", display: false }, { triggerTurn: true });
                return;
              }
            }
          }
        }
      }

      // Try restoring session model
      const sessionModel = getAutoModeStartModel();
      if (sessionModel) {
        if (ctx.model?.id !== sessionModel.id || ctx.model?.provider !== sessionModel.provider) {
          const startModel = ctx.modelRegistry.getAvailable().find((m) => m.provider === sessionModel.provider && m.id === sessionModel.id);
          if (startModel) {
            const ok = await pi.setModel(startModel, { persist: false });
            if (ok) {
              setCurrentDispatchedModelId({ provider: startModel.provider, id: startModel.id });
              retryState.networkRetryCount = 0;
              retryState.currentRetryModelId = undefined;
              ctx.ui.notify(`Model error${errorDetail}. Restored session model: ${sessionModel.provider}/${sessionModel.id} and resuming.`, "warning");
              pi.sendMessage({ customType: "gsd-auto-timeout-recovery", content: "Continue execution.", display: false }, { triggerTurn: true });
              return;
            }
          }
        }
      }
    }

    // --- Transient fallback: pause with auto-resume ---
    if (isTransient(cls)) {
      await pauseTransientWithBackoff(cls, pi, ctx, errorDetail, cls.kind === "rate-limit");
      return;
    }

    // --- Permanent / unknown: pause indefinitely ---
    await pauseAutoForProviderError(ctx.ui, errorDetail, () => pauseAuto(ctx, pi, {
      message: `Provider error: ${errorDetail}`,
      category: "provider",
      isTransient: false,
    }), {
      isRateLimit: false,
      isTransient: false,
      retryAfterMs: 0,
    });
    return;
  }

  // ── Success path ─────────────────────────────────────────────────────────
  try {
    resetRetryState(retryState);
    // #4573 — Reset the empty-turn counter on any successful agent turn so
    // transient stalls don't accumulate across independent units.
    resetEmptyTurnCounter();
    resolveAgentEnd(event);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.ui.notify(`Auto-mode error in agent_end handler: ${message}. Stopping auto-mode.`, "error");
    try {
      await pauseAuto(ctx, pi);
    } catch (e) {
      logWarning("bootstrap", `pauseAuto failed in agent_end handler: ${(e as Error).message}`);
    }
  }
}
