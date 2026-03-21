import {
  getOnboardingService,
  type OnboardingState,
} from "../../../../src/web/onboarding-service.ts";
import { requireProjectCwd } from "../../../../src/web/bridge-service.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type OnboardingAction =
  | { action: "discover_providers" }
  | { action: "recheck" }
  | { action: "save_api_key"; providerId: string; apiKey: string }
  | { action: "start_provider_flow"; providerId: string }
  | { action: "continue_provider_flow"; flowId: string; input: string }
  | { action: "cancel_provider_flow"; flowId: string }
  | { action: "logout_provider"; providerId: string };

function noStoreHeaders(): HeadersInit {
  return {
    "Cache-Control": "no-store",
  };
}

function errorResponse(status: number, error: unknown, onboarding?: OnboardingState): Response {
  return Response.json(
    {
      error: error instanceof Error ? error.message : String(error),
      ...(onboarding ? { onboarding } : {}),
    },
    {
      status,
      headers: noStoreHeaders(),
    },
  );
}

function isActionPayload(value: unknown): value is OnboardingAction {
  return typeof value === "object" && value !== null && typeof (value as { action?: unknown }).action === "string";
}

export async function GET(request: Request): Promise<Response> {
  requireProjectCwd(request);
  return Response.json(
    {
      onboarding: await getOnboardingService().getState(),
    },
    {
      headers: noStoreHeaders(),
    },
  );
}

export async function POST(request: Request): Promise<Response> {
  requireProjectCwd(request);
  let payload: unknown;
  try {
    payload = await request.json();
  } catch (error) {
    return errorResponse(400, error);
  }

  if (!isActionPayload(payload)) {
    return errorResponse(400, "Request body must be a JSON object with an action field");
  }

  const onboardingService = getOnboardingService();

  try {
    switch (payload.action) {
      case "discover_providers":
      case "recheck": {
        return Response.json(
          { onboarding: await onboardingService.getState() },
          {
            headers: noStoreHeaders(),
          },
        );
      }
      case "save_api_key": {
        const onboarding = await onboardingService.validateAndSaveApiKey(payload.providerId, payload.apiKey);
        return Response.json(
          { onboarding },
          {
            status:
              onboarding.lastValidation?.status === "failed"
                ? 422
                : onboarding.lockReason === "bridge_refresh_failed"
                  ? 503
                  : onboarding.lockReason === "bridge_refresh_pending"
                    ? 202
                    : 200,
            headers: noStoreHeaders(),
          },
        );
      }
      case "start_provider_flow": {
        const onboarding = await onboardingService.startProviderFlow(payload.providerId);
        return Response.json(
          { onboarding },
          {
            status: 202,
            headers: noStoreHeaders(),
          },
        );
      }
      case "continue_provider_flow": {
        const onboarding = await onboardingService.submitProviderFlowInput(payload.flowId, payload.input);
        return Response.json(
          { onboarding },
          {
            status: 202,
            headers: noStoreHeaders(),
          },
        );
      }
      case "cancel_provider_flow": {
        const onboarding = await onboardingService.cancelProviderFlow(payload.flowId);
        return Response.json(
          { onboarding },
          {
            headers: noStoreHeaders(),
          },
        );
      }
      case "logout_provider": {
        const onboarding = await onboardingService.logoutProvider(payload.providerId);
        return Response.json(
          { onboarding },
          {
            status:
              onboarding.lockReason === "bridge_refresh_failed"
                ? 503
                : onboarding.lockReason === "bridge_refresh_pending"
                  ? 202
                  : 200,
            headers: noStoreHeaders(),
          },
        );
      }
      default:
        return errorResponse(400, `Unsupported onboarding action: ${(payload as { action: string }).action}`);
    }
  } catch (error) {
    return errorResponse(400, error, await onboardingService.getState());
  }
}
