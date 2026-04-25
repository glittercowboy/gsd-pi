import type { TaskMetadata } from "../complexity-classifier.js";
import { computeTaskRequirements, filterToolsForProvider } from "../model-router.js";
import { buildAuditEnvelope, emitUokAuditEvent } from "./audit.js";

export interface ModelCandidate {
  id: string;
  provider: string;
  api: string;
}

export interface ModelPolicyDecision {
  modelId: string;
  provider: string;
  allowed: boolean;
  reason: string;
}

export interface ModelPolicyOptions {
  basePath: string;
  traceId: string;
  turnId?: string;
  unitType?: string;
  taskMetadata?: TaskMetadata;
  currentProvider?: string;
  allowCrossProvider?: boolean;
  requiredTools?: string[];
  deniedProviders?: string[];
  allowedApis?: string[];
}

export function buildRequirementVector(unitType?: string, taskMetadata?: TaskMetadata): Partial<Record<string, number>> {
  if (!unitType) return {};
  return computeTaskRequirements(unitType, taskMetadata) as unknown as Partial<Record<string, number>>;
}

export function applyModelPolicyFilter<T extends ModelCandidate>(
  candidates: T[],
  options: ModelPolicyOptions,
): {
  eligible: T[];
  decisions: ModelPolicyDecision[];
  requirements: Partial<Record<string, number>>;
} {
  const requiredTools = options.requiredTools ?? [];
  const deniedProviders = new Set((options.deniedProviders ?? []).map((p) => p.toLowerCase()));
  const allowedApis = options.allowedApis ? new Set(options.allowedApis) : null;
  const requirements = buildRequirementVector(options.unitType, options.taskMetadata);
  const decisions: ModelPolicyDecision[] = [];
  const eligible: T[] = [];

  for (const model of candidates) {
    let allowed = true;
    let reason = "allowed";

    if (options.allowCrossProvider === false && options.currentProvider && model.provider !== options.currentProvider) {
      allowed = false;
      reason = `cross-provider routing disabled (${model.provider} != ${options.currentProvider})`;
    }

    if (allowed && deniedProviders.has(model.provider.toLowerCase())) {
      allowed = false;
      reason = `provider denied by policy: ${model.provider}`;
    }

    if (allowed && allowedApis && !allowedApis.has(model.api)) {
      allowed = false;
      reason = `transport/api denied by policy: ${model.api}`;
    }

    if (allowed && requiredTools.length > 0) {
      const compatibility = filterToolsForProvider(requiredTools, model.api);
      if (compatibility.filtered.length > 0) {
        allowed = false;
        reason = `tool policy denied (${compatibility.filtered.join(", ")}) for ${model.api}`;
      }
    }

    const decision: ModelPolicyDecision = {
      modelId: model.id,
      provider: model.provider,
      allowed,
      reason,
    };
    decisions.push(decision);

    emitUokAuditEvent(
      options.basePath,
      buildAuditEnvelope({
        traceId: options.traceId,
        turnId: options.turnId,
        category: "model-policy",
        type: allowed ? "model-policy-allow" : "model-policy-deny",
        payload: {
          modelId: model.id,
          provider: model.provider,
          api: model.api,
          reason,
          unitType: options.unitType,
          requirements,
        },
      }),
    );

    if (allowed) eligible.push(model);
  }

  return {
    eligible,
    decisions,
    requirements,
  };
}
