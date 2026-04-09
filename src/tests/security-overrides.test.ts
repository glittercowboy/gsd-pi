import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { SettingsManager, getAllowedCommandPrefixes, SAFE_COMMAND_PREFIXES, setAllowedCommandPrefixes } from "@gsd/pi-coding-agent";
import { getFetchAllowedUrls, setFetchAllowedUrls } from "../resources/extensions/search-the-web/url-utils.ts";
import { applySecurityOverrides } from "../security-overrides.ts";

describe("applySecurityOverrides — env var and settings precedence", () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    // Snapshot env vars we might touch
    savedEnv.GSD_ALLOWED_COMMAND_PREFIXES = process.env.GSD_ALLOWED_COMMAND_PREFIXES;
    savedEnv.GSD_FETCH_ALLOWED_URLS = process.env.GSD_FETCH_ALLOWED_URLS;
    delete process.env.GSD_ALLOWED_COMMAND_PREFIXES;
    delete process.env.GSD_FETCH_ALLOWED_URLS;

    // Reset runtime state to defaults
    setAllowedCommandPrefixes(SAFE_COMMAND_PREFIXES);
    setFetchAllowedUrls([]);
  });

  afterEach(() => {
    // Restore env vars
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = val;
      }
    }
    // Restore runtime defaults
    setAllowedCommandPrefixes(SAFE_COMMAND_PREFIXES);
    setFetchAllowedUrls([]);
  });

  // --- Command prefixes ---

  it("applies command prefixes from settings when no env var is set", () => {
    const sm = SettingsManager.inMemory({ allowedCommandPrefixes: ["sops", "doppler"] });
    applySecurityOverrides(sm);
    assert.deepEqual([...getAllowedCommandPrefixes()], ["sops", "doppler"]);
  });

  it("env var overrides settings for command prefixes", () => {
    process.env.GSD_ALLOWED_COMMAND_PREFIXES = "age,infisical";
    const sm = SettingsManager.inMemory({ allowedCommandPrefixes: ["sops", "doppler"] });
    applySecurityOverrides(sm);
    assert.deepEqual([...getAllowedCommandPrefixes()], ["age", "infisical"]);
  });

  it("empty env var does not override settings (falls through to settings)", () => {
    process.env.GSD_ALLOWED_COMMAND_PREFIXES = "";
    const sm = SettingsManager.inMemory({ allowedCommandPrefixes: ["sops"] });
    applySecurityOverrides(sm);
    assert.deepEqual([...getAllowedCommandPrefixes()], ["sops"]);
  });

  it("env var with whitespace and trailing commas is trimmed correctly", () => {
    process.env.GSD_ALLOWED_COMMAND_PREFIXES = " sops , doppler , , ";
    const sm = SettingsManager.inMemory();
    applySecurityOverrides(sm);
    assert.deepEqual([...getAllowedCommandPrefixes()], ["sops", "doppler"]);
  });

  it("keeps built-in defaults when neither env var nor settings are set", () => {
    const sm = SettingsManager.inMemory();
    applySecurityOverrides(sm);
    assert.deepEqual([...getAllowedCommandPrefixes()], [...SAFE_COMMAND_PREFIXES]);
  });

  // --- Fetch URL allowlist ---

  it("applies fetch allowed URLs from settings when no env var is set", () => {
    const sm = SettingsManager.inMemory({ fetchAllowedUrls: ["internal.co", "192.168.1.50"] });
    applySecurityOverrides(sm);
    assert.deepEqual([...getFetchAllowedUrls()].sort(), ["192.168.1.50", "internal.co"]);
  });

  it("env var overrides settings for fetch allowed URLs", () => {
    process.env.GSD_FETCH_ALLOWED_URLS = "my-docs.internal";
    const sm = SettingsManager.inMemory({ fetchAllowedUrls: ["other.internal"] });
    applySecurityOverrides(sm);
    assert.deepEqual([...getFetchAllowedUrls()], ["my-docs.internal"]);
  });

  it("empty env var does not override settings for fetch URLs", () => {
    process.env.GSD_FETCH_ALLOWED_URLS = "";
    const sm = SettingsManager.inMemory({ fetchAllowedUrls: ["docs.internal"] });
    applySecurityOverrides(sm);
    assert.deepEqual([...getFetchAllowedUrls()], ["docs.internal"]);
  });

  it("env var with whitespace and trailing commas is trimmed correctly for URLs", () => {
    process.env.GSD_FETCH_ALLOWED_URLS = " a.internal , b.internal , , ";
    const sm = SettingsManager.inMemory();
    applySecurityOverrides(sm);
    assert.deepEqual([...getFetchAllowedUrls()].sort(), ["a.internal", "b.internal"]);
  });

  it("keeps empty allowlist when neither env var nor settings are set", () => {
    const sm = SettingsManager.inMemory();
    applySecurityOverrides(sm);
    assert.deepEqual([...getFetchAllowedUrls()], []);
  });
});
