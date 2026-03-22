import type { ExtensionAPI, ExtensionContext } from "@gsd/pi-coding-agent";

import { checkAutoStartAfterDiscuss } from "../guided-flow.js";
import { getAutoDashboardData, getAutoModeStartModel, isAutoActive, pauseAuto, resumeAutoAfterDelay } from "../auto.js";
import { getNextFallbackModel, isTransientNetworkError, resolveModelWithFallbacksForUnit } from "../preferences.js";
import { classifyProviderError, pauseAutoForProviderError } from "../provider-error-pause.js";
import { isSessionSwitchInFlight, resolveAgentEnd } from "../auto-loop.js";
import { clearDiscussionFlowState } from "./write-gate.js";

const networkRetryCounters = new Map<string, number>();
const MAX_TRANSIENT_AUTO_RESUMES = 3;
let consecutiveTransientErrors = 0;

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
    await pauseAuto(ctx, pi);
    return;
  }
  if (lastMsg && "stopReason" in lastMsg && lastMsg.stopReason === "error") {
    const errorDetail = "errorMessage" in lastMsg && lastMsg.errorMessage ? `: ${lastMsg.errorMessage}` : "";
    const errorMsg = ("errorMessage" in lastMsg && lastMsg.errorMessage) ? String(lastMsg.errorMessage) : "";

    if (isTransientNetworkError(errorMsg)) {
      const currentModelId = ctx.model?.id ?? "unknown";
      const retryKey = `network-retry:${currentModelId}`;
      const currentRetries = networkRetryCounters.get(retryKey) ?? 0;
      const maxRetries = 2;
      if (currentRetries < maxRetries) {
        networkRetryCounters.set(retryKey, currentRetries + 1);
        const attempt = currentRetries + 1;
        const delayMs = attempt * 3000;
        ctx.ui.notify(`Network error on ${currentModelId}${errorDetail}. Retry ${attempt}/${maxRetries} in ${delayMs / 1000}s...`, "warning");
        setTimeout(() => {
          pi.sendMessage(
            { customType: "gsd-auto-timeout-recovery", content: "Continue execution — retrying after transient network error.", display: false },
            { triggerTurn: true },
          );
        }, delayMs);
        return;
      }
      networkRetryCounters.delete(retryKey);
      ctx.ui.notify(`Network retries exhausted for ${currentModelId}. Attempting model fallback.`, "warning");
    }

    const dash = getAutoDashboardData();
    if (dash.currentUnit) {
      const modelConfig = resolveModelWithFallbacksForUnit(dash.currentUnit.type);
      if (modelConfig && modelConfig.fallbacks.length > 0) {
        const availableModels = ctx.modelRegistry.getAvailable();
        const nextModelId = getNextFallbackModel(ctx.model?.id, modelConfig);
        if (nextModelId) {
          networkRetryCounters.clear();
          const slashIdx = nextModelId.indexOf("/");
          const modelToSet = slashIdx !== -1
            ? availableModels.find((m) => m.provider.toLowerCase() === nextModelId.substring(0, slashIdx).toLowerCase() && m.id.toLowerCase() === nextModelId.substring(slashIdx + 1).toLowerCase())
            : (availableModels.find((m) => m.id === nextModelId && m.provider === ctx.model?.provider) ?? availableModels.find((m) => m.id === nextModelId));
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

    const sessionModel = getAutoModeStartModel();
    if (sessionModel) {
      if (ctx.model?.id !== sessionModel.id || ctx.model?.provider !== sessionModel.provider) {
        const startModel = ctx.modelRegistry.getAvailable().find((m) => m.provider === sessionModel.provider && m.id === sessionModel.id);
        if (startModel) {
          const ok = await pi.setModel(startModel, { persist: false });
          if (ok) {
            networkRetryCounters.clear();
            ctx.ui.notify(`Model error${errorDetail}. Restored session model: ${sessionModel.provider}/${sessionModel.id} and resuming.`, "warning");
            pi.sendMessage({ customType: "gsd-auto-timeout-recovery", content: "Continue execution.", display: false }, { triggerTurn: true });
            return;
          }
        }
      }
    }

    const classification = classifyProviderError(errorMsg);
    const explicitRetryAfterMs = ("retryAfterMs" in lastMsg && typeof lastMsg.retryAfterMs === "number") ? lastMsg.retryAfterMs : undefined;
    if (classification.isTransient) {
      consecutiveTransientErrors += 1;
    } else {
      consecutiveTransientErrors = 0;
    }
    const baseRetryAfterMs = explicitRetryAfterMs ?? classification.suggestedDelayMs;
    const retryAfterMs = classification.isTransient
      ? baseRetryAfterMs * 2 ** Math.max(0, consecutiveTransientErrors - 1)
      : baseRetryAfterMs;
    const allowAutoResume = classification.isTransient && consecutiveTransientErrors <= MAX_TRANSIENT_AUTO_RESUMES;
    if (classification.isTransient && !allowAutoResume) {
      ctx.ui.notify(`Transient provider errors persisted after ${MAX_TRANSIENT_AUTO_RESUMES} auto-resume attempts. Pausing for manual review.`, "warning");
    }
    await pauseAutoForProviderError(ctx.ui, errorDetail, () => pauseAuto(ctx, pi), {
      isRateLimit: classification.isRateLimit,
      isTransient: allowAutoResume,
      retryAfterMs,
      resume: allowAutoResume
        ? () => {
          void resumeAutoAfterDelay(pi).catch((error) => {
            const message = error instanceof Error ? error.message : String(error);
            ctx.ui.notify(`Auto-resume failed: ${message}`, "error");
          });
        }
        : undefined,
    });
    return;
  }

  try {
    consecutiveTransientErrors = 0;
    networkRetryCounters.clear();
    resolveAgentEnd(event);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.ui.notify(`Auto-mode error in agent_end handler: ${message}. Stopping auto-mode.`, "error");
    try {
      await pauseAuto(ctx, pi);
    } catch {
      // best-effort
    }
  }
}

