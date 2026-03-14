/**
 * trust-dialog.test.tsx — static source-text strategy tests for:
 * - SettingsView: no skip_permissions toggle, has "Manage build permissions" link
 * - App.tsx: TrustDialog import present
 * - AdvancedPermissionsPanel: key exports and labels present
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function readSource(relativePath: string): string {
  const url = new URL(relativePath, import.meta.url);
  return readFileSync(fileURLToPath(url), "utf-8");
}

describe("SettingsView source checks", () => {
  const settingsSource = readSource("../src/components/views/SettingsView.tsx");

  test("does not contain skip_permissions as a toggle label", () => {
    // Should not have skip_permissions toggle text
    expect(settingsSource).not.toContain("Skip permissions");
  });

  test("contains 'Manage build permissions' link text", () => {
    expect(settingsSource).toContain("Manage build permissions");
  });

  test("imports AdvancedPermissionsPanel", () => {
    expect(settingsSource).toContain("AdvancedPermissionsPanel");
  });

  test("has Build Permissions section", () => {
    expect(settingsSource).toContain("Build Permissions");
  });
});

describe("App.tsx source checks", () => {
  const appSource = readSource("../src/App.tsx");

  test("imports TrustDialog", () => {
    expect(appSource).toContain("TrustDialog");
  });
});

describe("AdvancedPermissionsPanel source checks", () => {
  const panelSource = readSource("../src/components/permissions/AdvancedPermissionsPanel.tsx");

  test("exports DEFAULT_PERMISSION_SETTINGS with packageInstall", () => {
    expect(panelSource).toContain("DEFAULT_PERMISSION_SETTINGS");
    expect(panelSource).toContain("packageInstall");
  });

  test("exports DEFAULT_PERMISSION_SETTINGS with askBeforeEach", () => {
    expect(panelSource).toContain("askBeforeEach");
  });

  test("contains 'Ask before each operation' label text", () => {
    expect(panelSource).toContain("Ask before each operation");
  });

  test("exports PermissionSettings interface", () => {
    expect(panelSource).toContain("PermissionSettings");
  });

  test("contains gitPush toggle (OFF by default note)", () => {
    expect(panelSource).toContain("gitPush");
    expect(panelSource).toContain("OFF by default");
  });
});
