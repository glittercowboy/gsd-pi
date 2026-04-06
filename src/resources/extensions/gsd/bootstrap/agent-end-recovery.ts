import type { ExtensionAPI, ExtensionContext } from "@gsd/pi-coding-agent";

import { logWarning } from "../workflow-logger.js";
import { checkAutoStartAfterDiscuss } from "../guided-flow.js";
import { getAutoDashboardData, getAutoModeStartModel, isAutoActive, pauseAuto } from "../auto.js";
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

const retryState = createRetryState();
const MAX_NETWORK_RETRIES = 2;
const MAX_TRANSIENT_AUTO_RESUMES = 3;

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
  if (checkAutoStartAfterDiscuss()) {
    clearDiscussionFlowState();
    return;
  }
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
    const errorDetail = "errorMessage" in lastMsg && lastMsg.errorMessage ? `: ${lastMsg.errorMessage}` : "";
    const errorMsg = ("errorMessage" in lastMsg && lastMsg.errorMessage) ? String(lastMsg.errorMessage) : "";
    const explicitRetryAfterMs = ("retryAfterMs" in lastMsg && typeof lastMsg.retryAfterMs === "number") ? lastMsg.retryAfterMs : undefined;

    // ── 1. Classify ──────────────────────────────────────────────────────
    const cls = classifyError(errorMsg, explicitRetryAfterMs);

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
