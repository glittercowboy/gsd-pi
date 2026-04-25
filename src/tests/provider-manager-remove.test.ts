import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
  const dir = mkdtempSync(join(tmpdir(), "provider-manager-test-"));
  return join(dir, "models.json");
}

function readProviders(modelsJsonPath: string): string[] {
  const config = JSON.parse(readFileSync(modelsJsonPath, "utf-8")) as {
    providers?: Record<string, unknown>;
  };
  return Object.keys(config.providers ?? {}).sort();
}

function createComponent(options: {
  modelsJsonPath: string;
  authProviders?: string[];
  providers: Array<{ name: string; modelIds: string[] }>;
}) {
  const writer = new ModelsJsonWriter(options.modelsJsonPath);
  for (const provider of options.providers) {
    writer.setProvider(provider.name, {
      models: provider.modelIds.map((id: string) => ({ id })),
    });
  }

  const authProviders = new Set(options.authProviders ?? []);
  const removedProviders: string[] = [];
  let refreshCalls = 0;
  let renderCalls = 0;

  const authStorage = {
    hasAuth(provider: string) {
      return authProviders.has(provider);
    },
    remove(provider: string) {
      removedProviders.push(provider);
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
    refresh() {
      refreshCalls += 1;
    },
  } as any;

  const tui = {
    requestRender() {
      renderCalls += 1;
    },
  } as any;

  const component = new ProviderManagerComponent(tui, authStorage, modelRegistry, () => {}, () => {});
  return {
    component,
    removedProviders,
    getRefreshCalls: () => refreshCalls,
    getRenderCalls: () => renderCalls,
  };
}

test("provider manager skips remove when provider has no auth", (t) => {
  const modelsJsonPath = createTempModelsJsonPath();
  const rootDir = join(modelsJsonPath, "..");
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));

  const { component, removedProviders, getRefreshCalls, getRenderCalls } = createComponent({
    modelsJsonPath,
    providers: [{ name: "custom", modelIds: ["local-model"] }],
  });

  component.handleInput("r");

  // No auth means remove is a no-op
  assert.deepEqual(removedProviders, []);
  assert.deepEqual(readProviders(modelsJsonPath), ["custom"]);
  assert.equal(getRefreshCalls(), 0);
  assert.equal(getRenderCalls(), 0);
});

test("provider manager removes provider models with confirmation when auth is stored", (t) => {
  const modelsJsonPath = createTempModelsJsonPath();
  const rootDir = join(modelsJsonPath, "..");
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));

  const { component, removedProviders, getRefreshCalls, getRenderCalls } = createComponent({
    modelsJsonPath,
    authProviders: ["custom"],
    providers: [{ name: "custom", modelIds: ["local-model"] }],
  });

  // First press enters confirmation mode
  component.handleInput("r");
  assert.deepEqual(removedProviders, []);
  assert.equal((component as any).confirmingRemove, true);

  // Second press confirms removal
  component.handleInput("r");
  assert.deepEqual(removedProviders, ["custom"]);
  assert.deepEqual(readProviders(modelsJsonPath), []);
  assert.equal(getRefreshCalls(), 1);
  assert.ok(getRenderCalls() >= 2);
  assert.ok(!(component as any).providers.some((provider: { name: string; modelCount: number }) =>
    provider.name === "custom" || provider.modelCount > 0,
  ));
  assert.equal((component as any).selectedIndex, 0);
});

test("provider manager clamps selection after removing the selected provider", (t) => {
  const modelsJsonPath = createTempModelsJsonPath();
  const rootDir = join(modelsJsonPath, "..");
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));

  const { component } = createComponent({
    modelsJsonPath,
    authProviders: ["zeta"],
    providers: [
      { name: "alpha", modelIds: ["a-1"] },
      { name: "zeta", modelIds: ["z-1"] },
    ],
  });

  (component as any).selectedIndex = (component as any).providers.findIndex(
    (provider: { name: string }) => provider.name === "zeta",
  );

  // Double-press r to confirm removal
  component.handleInput("r");
  component.handleInput("r");

  assert.deepEqual(readProviders(modelsJsonPath), ["alpha"]);
  assert.ok(!(component as any).providers.some((provider: { name: string }) => provider.name === "zeta"));
  assert.ok((component as any).selectedIndex >= 0);
  assert.ok((component as any).selectedIndex < (component as any).providers.length);
});
