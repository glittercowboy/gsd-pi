import { describe, it } from "node:test";
import assert from "node:assert";
import { fetchModelsDev } from "./models-dev.js";
import { mapToModelRegistry } from "./models-dev-mapper.js";

const MODELS_DEV_URL = "https://models.dev/api.json";
const TIMEOUT_MS = 30000; // 30 seconds for live API call

/**
 * Check if live test should run.
 * Skips when LIVE_MODELS_DEV_TEST is "false" or "0".
 */
function shouldRunLiveTest(): boolean {
  const envValue = process.env.LIVE_MODELS_DEV_TEST;
  if (envValue === "false" || envValue === "0") {
    return false;
  }
  return true;
}

describe("models-dev live verification", () => {
  it("fetches from production models.dev API and validates mapper output", { timeout: TIMEOUT_MS + 5000 }, async () => {
    // Skip if env var disables live test
    if (!shouldRunLiveTest()) {
      console.log("  ⊹ Skipped: LIVE_MODELS_DEV_TEST env var is set to 'false' or '0'");
      return;
    }

    // Fetch from production URL
    console.log(`  ⊹ Fetching from ${MODELS_DEV_URL} (timeout: ${TIMEOUT_MS}ms)...`);
    const data = await fetchModelsDev(MODELS_DEV_URL, TIMEOUT_MS);

    // Assert non-null with clear network failure message
    assert.ok(
      data !== null,
      `Network failure: Could not fetch from ${MODELS_DEV_URL}. Check network connectivity or API availability.`
    );

    // Log diagnostic info on success
    const providerCount = Object.keys(data).length;
    const sampleIds = Object.entries(data)
      .flatMap(([providerId, provider]) =>
        Object.keys(provider.models).map((modelId) => `${providerId}/${modelId}`)
      )
      .slice(0, 5);

    console.log(`  ⊹ Success: ${providerCount} providers, sample models: ${sampleIds.join(", ")}...`);

    // Validate response structure (already done by fetchModelsDev via ModelsDevData.parse())
    // This verifies the Zod schema validation passed
    assert.ok(Object.keys(data).length > 0, "Response should contain at least one provider");

    // Pass through mapper and verify output
    const models = mapToModelRegistry(data);

    // Assert non-empty model array
    assert.ok(
      models.length > 0,
      `Mapper produced empty array. Provider count: ${providerCount}. Schema validation passed but mapper found no models.`
    );

    // Log mapper output diagnostics
    const uniqueProviders = new Set(models.map((m) => m.provider));
    console.log(
      `  ⊹ Mapper output: ${models.length} models from ${uniqueProviders.size} providers`
    );
  });
});
