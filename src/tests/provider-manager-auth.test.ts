import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { ModelsJsonWriter } = await import("../../packages/pi-coding-agent/src/core/models-json-writer.ts");
const { ProviderManagerComponent } = await import(
  "../../packages/pi-coding-agent/src/modes/interactive/components/provider-manager.ts"
);
const { initTheme } = await import(
  "../../packages/pi-coding-agent/src/modes/interactive/theme/theme.ts"
);

initTheme();

function createTempModelsJsonPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "provider-manager-auth-test-"));
  return join(dir, "models.json");
}

function createComponent(options: {
  modelsJsonPath: string;
  authProviders?: string[];
  providers: Array<{ name: string; modelIds: string[] }>;
  onSetupAuth?: (provider: string) => void;
}) {
  const writer = new ModelsJsonWriter(options.modelsJsonPath);
  for (const provider of options.providers) {
    writer.setProvider(provider.name, {
      models: provider.modelIds.map((id: string) => ({ id })),
    });
  }
  // Ensure models.json exists even when no providers are written
  try {
    readFileSync(options.modelsJsonPath, "utf-8");
  } catch {
    writeFileSync(options.modelsJsonPath, JSON.stringify({ providers: {} }), "utf-8");
  }

  const authProviders = new Set(options.authProviders ?? []);

  const authStorage = {
    hasAuth(provider: string) {
      return authProviders.has(provider);
    },
    remove(provider: string) {
      authProviders.delete(provider);
    },
  } as any;

  const modelRegistry = {
    modelsJsonPath: options.modelsJsonPath,
    getAll() {
      const config = JSON.parse(readFileSync(options.modelsJsonPath, "utf-8")) as {
        providers?: Record<string, { models?: Array<{ id: string }> }>;
      };
      return Object.entries(config.providers ?? {}).flatMap(([provider, providerConfig]) =>
        (providerConfig.models ?? []).map((model) => ({
          id: model.id,
          provider,
        })),
      );
    },
    refresh() {},
  } as any;

  const tui = {
    requestRender() {},
  } as any;

  const setupAuthCalls: string[] = [];
  const onSetupAuth = options.onSetupAuth ?? ((provider: string) => { setupAuthCalls.push(provider); });

  const component = new ProviderManagerComponent(
    tui,
    authStorage,
    modelRegistry,
    () => {},
    () => {},
    onSetupAuth,
  );

  return { component, setupAuthCalls };
}

test("provider manager calls onSetupAuth with selected provider when Enter is pressed", (t) => {
  const modelsJsonPath = createTempModelsJsonPath();
  const rootDir = join(modelsJsonPath, "..");
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));

  const { component, setupAuthCalls } = createComponent({
    modelsJsonPath,
    providers: [{ name: "zzz-custom-provider", modelIds: ["model-1"] }],
  });

  // Navigate to the last provider (zzz-custom-provider, sorted last)
  const providers = (component as any).providers as Array<{ name: string }>;
  const idx = providers.findIndex((p) => p.name === "zzz-custom-provider");
  (component as any).selectedIndex = idx;

  component.handleInput("\r");

  assert.deepEqual(setupAuthCalls, ["zzz-custom-provider"]);
});

test("provider manager calls onSetupAuth for the currently selected provider", (t) => {
  const modelsJsonPath = createTempModelsJsonPath();
  const rootDir = join(modelsJsonPath, "..");
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));

  const { component, setupAuthCalls } = createComponent({
    modelsJsonPath,
    providers: [
      { name: "zzz-provider-a", modelIds: ["a-1"] },
      { name: "zzz-provider-b", modelIds: ["b-1"] },
    ],
  });

  // Select zzz-provider-b explicitly
  const providers = (component as any).providers as Array<{ name: string }>;
  const idx = providers.findIndex((p) => p.name === "zzz-provider-b");
  (component as any).selectedIndex = idx;

  component.handleInput("\r");

  assert.deepEqual(setupAuthCalls, ["zzz-provider-b"]);
});

test("provider manager does not call onSetupAuth when Enter is pressed with no providers", (t) => {
  const modelsJsonPath = createTempModelsJsonPath();
  const rootDir = join(modelsJsonPath, "..");
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));

  const setupAuthCalls: string[] = [];

  // Create component with no custom providers — only discoverable providers may exist
  // We override the provider list to be empty to test the guard condition
  const { component } = createComponent({
    modelsJsonPath,
    providers: [],
    onSetupAuth: (p) => { setupAuthCalls.push(p); },
  });

  // Force empty provider list to test guard
  (component as any).providers = [];
  (component as any).selectedIndex = 0;

  component.handleInput("\r");

  assert.deepEqual(setupAuthCalls, []);
});
