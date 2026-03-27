import test from "node:test"
import assert from "node:assert/strict"

const { getOnboardingPresentation } = await import("../../web/lib/gsd-workspace-store.tsx")

function makeOnboardingState(overrides: Record<string, unknown> = {}) {
  return {
    status: "blocked",
    locked: true,
    lockReason: "required_setup",
    required: {
      blocking: true,
      skippable: false,
      satisfied: false,
      satisfiedBy: null,
      providers: [
        {
          id: "openai",
          label: "OpenAI",
          required: true,
          recommended: false,
          configured: false,
          configuredVia: null,
          supports: {
            apiKey: true,
            oauth: false,
            oauthAvailable: false,
            usesCallbackServer: false,
          },
        },
      ],
    },
    optional: {
      blocking: false,
      skippable: true,
      sections: [],
    },
    lastValidation: null,
    activeFlow: null,
    bridgeAuthRefresh: {
      phase: "idle",
      strategy: null,
      startedAt: null,
      completedAt: null,
      error: null,
    },
    ...overrides,
  }
}

function makeState(overrides: Record<string, unknown> = {}) {
  return {
    bootStatus: "ready",
    onboardingRequestState: "idle",
    boot: {
      onboarding: makeOnboardingState(),
    },
    ...overrides,
  } as Parameters<typeof getOnboardingPresentation>[0]
}

test("getOnboardingPresentation prefers bridge refresh pending over saving_api_key", () => {
  const presentation = getOnboardingPresentation(
    makeState({
      onboardingRequestState: "saving_api_key",
      boot: {
        onboarding: makeOnboardingState({
          status: "blocked",
          locked: true,
          lockReason: "bridge_refresh_pending",
          required: {
            blocking: true,
            skippable: false,
            satisfied: true,
            satisfiedBy: { providerId: "openai", source: "auth_file" },
            providers: [
              {
                id: "openai",
                label: "OpenAI",
                required: true,
                recommended: false,
                configured: true,
                configuredVia: "auth_file",
                supports: {
                  apiKey: true,
                  oauth: false,
                  oauthAvailable: false,
                  usesCallbackServer: false,
                },
              },
            ],
          },
          lastValidation: {
            status: "succeeded",
            providerId: "openai",
            method: "api_key",
            checkedAt: new Date().toISOString(),
            message: "OpenAI credentials validated",
            persisted: true,
          },
          bridgeAuthRefresh: {
            phase: "pending",
            strategy: "restart",
            startedAt: new Date().toISOString(),
            completedAt: null,
            error: null,
          },
        }),
      },
    }),
  )

  assert.equal(presentation.phase, "refreshing")
  assert.equal(presentation.label, "Refreshing bridge auth")
})

test("getOnboardingPresentation still shows validating when save is in flight and onboarding has not advanced", () => {
  const presentation = getOnboardingPresentation(
    makeState({
      onboardingRequestState: "saving_api_key",
      boot: {
        onboarding: makeOnboardingState(),
      },
    }),
  )

  assert.equal(presentation.phase, "validating")
  assert.equal(presentation.label, "Validating credentials")
})
