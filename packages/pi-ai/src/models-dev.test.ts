import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import {
  getCachedModelsDev,
  isCacheValid,
  writeCache,
  fetchModelsDev,
  getModelsDev,
  refreshModelsDev,
} from "./models-dev.js";
import type { CacheEntry } from "./models-dev.js";

const SAMPLE_DATA = {
  "anthropic": {
    "id": "anthropic",
    "name": "Anthropic",
    "env": [],
    "models": {
      "claude-3-7-sonnet-20250219": {
        "id": "claude-3-7-sonnet-20250219",
        "name": "Claude 3.7 Sonnet",
        "release_date": "2025-02-19",
        "attachment": true,
        "reasoning": true,
        "temperature": true,
        "tool_call": true,
        "interleaved": true,
        "cost": {
          "input": 3,
          "output": 15,
          "cache_read": 0.3,
          "cache_write": 3.75
        },
        "limit": {
          "context": 200000,
          "output": 128000
        },
        "modalities": {
          "input": ["text", "image"],
          "output": ["text"]
        },
        "options": {}
      }
    }
  }
};

const OLD_VERSION = "0.57.0";
const CURRENT_VERSION = "0.57.1";

describe("models-dev cache functions", () => {
  let tempDir: string;
  let cachePath: string;

  before(() => {
    tempDir = mkdtempSync(join(tmpdir(), "models-dev-test-"));
    cachePath = join(tempDir, "models-dev.json");
  });

  after(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe("getCachedModelsDev", () => {
    it("returns null when cache file doesn't exist", () => {
      const nonExistentPath = join(tempDir, "nonexistent.json");
      const result = getCachedModelsDev(nonExistentPath);
      assert.strictEqual(result, null);
    });

    it("returns null when cache file is invalid JSON", () => {
      writeFileSync(cachePath, "invalid json");
      const result = getCachedModelsDev(cachePath);
      assert.strictEqual(result, null);
    });

    it("returns null when cache is missing required fields", () => {
      writeFileSync(cachePath, JSON.stringify({ invalid: "structure" }));
      const result = getCachedModelsDev(cachePath);
      assert.strictEqual(result, null);
    });

    it("returns cached data when file is valid", () => {
      const cache: CacheEntry = {
        version: CURRENT_VERSION,
        fetchedAt: Date.now(),
        data: SAMPLE_DATA as any
      };
      writeFileSync(cachePath, JSON.stringify(cache));
      
      const result = getCachedModelsDev(cachePath);
      assert.ok(result !== null);
      assert.strictEqual(result.version, CURRENT_VERSION);
      assert.deepStrictEqual(result.data, SAMPLE_DATA);
    });
  });

  describe("isCacheValid", () => {
    it("returns false for null cache", () => {
      assert.strictEqual(isCacheValid(null, 43200000, CURRENT_VERSION), false);
    });

    it("returns false when version doesn't match", () => {
      const cache: CacheEntry = {
        version: OLD_VERSION,
        fetchedAt: Date.now(),
        data: SAMPLE_DATA as any
      };
      assert.strictEqual(isCacheValid(cache, 43200000, CURRENT_VERSION), false);
    });

    it("returns false when TTL expired", () => {
      const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
      const cache: CacheEntry = {
        version: CURRENT_VERSION,
        fetchedAt: oneDayAgo,
        data: SAMPLE_DATA as any
      };
      assert.strictEqual(isCacheValid(cache, 12 * 60 * 60 * 1000, CURRENT_VERSION), false);
    });

    it("returns true when cache is valid and within TTL", () => {
      const cache: CacheEntry = {
        version: CURRENT_VERSION,
        fetchedAt: Date.now(),
        data: SAMPLE_DATA as any
      };
      assert.strictEqual(isCacheValid(cache, 12 * 60 * 60 * 1000, CURRENT_VERSION), true);
    });
  });

  describe("writeCache", () => {
    it("writes cache file successfully", () => {
      const testPath = join(tempDir, "write-test.json");
      const success = writeCache(SAMPLE_DATA as any, CURRENT_VERSION, testPath);
      
      assert.strictEqual(success, true);
      assert.ok(existsSync(testPath));
      
      const content = readFileSync(testPath, "utf-8");
      const parsed = JSON.parse(content);
      assert.strictEqual(parsed.version, CURRENT_VERSION);
      assert.ok(parsed.fetchedAt > 0);
      assert.deepStrictEqual(parsed.data, SAMPLE_DATA);
    });

    it("creates cache directory if it doesn't exist", () => {
      const nestedPath = join(tempDir, "nested", "dir", "cache.json");
      const success = writeCache(SAMPLE_DATA as any, CURRENT_VERSION, nestedPath);
      
      assert.strictEqual(success, true);
      assert.ok(existsSync(nestedPath));
    });
  });
});

describe("models-dev fetch functions", () => {
  describe("fetchModelsDev", () => {
    it("returns null on network error", async () => {
      // Try to fetch from invalid URL
      const result = await fetchModelsDev("http://invalid-url-that-does-not-exist.local/api.json", 1000);
      assert.strictEqual(result, null);
    });

    it("respects timeout", async () => {
      // This will timeout because the URL is slow/unreachable
      const start = Date.now();
      const result = await fetchModelsDev("http://1.2.3.4:12345/api.json", 1000);
      const elapsed = Date.now() - start;
      
      assert.strictEqual(result, null);
      assert.ok(elapsed < 3000, `Should timeout quickly, took ${elapsed}ms`);
    });
  });

  describe("getModelsDev", () => {
    let tempDir: string;
    let cachePath: string;

    before(() => {
      tempDir = mkdtempSync(join(tmpdir(), "models-dev-get-"));
      cachePath = join(tempDir, "models-dev.json");
    });

    after(() => {
      if (existsSync(tempDir)) {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("returns null when no cache and fetch fails", async () => {
      const result = await getModelsDev({
        cachePath: join(tempDir, "nonexistent.json"),
        url: "http://invalid-url-that-does-not-exist.local/api.json",
        ttlMs: 1000,
        version: CURRENT_VERSION
      });
      assert.strictEqual(result, null);
    });

    it("uses cache when valid", async () => {
      // Write valid cache
      const cache: CacheEntry = {
        version: CURRENT_VERSION,
        fetchedAt: Date.now(),
        data: SAMPLE_DATA as any
      };
      writeFileSync(cachePath, JSON.stringify(cache));
      
      const result = await getModelsDev({
        cachePath,
        url: "http://invalid-url-that-does-not-exist.local/api.json",
        ttlMs: 12 * 60 * 60 * 1000,
        version: CURRENT_VERSION
      });
      
      assert.ok(result !== null);
      assert.deepStrictEqual(result, SAMPLE_DATA);
    });

    it("fetches when cache is expired", async () => {
      // Write expired cache
      const oldCache: CacheEntry = {
        version: CURRENT_VERSION,
        fetchedAt: Date.now() - 24 * 60 * 60 * 1000, // 1 day ago
        data: SAMPLE_DATA as any
      };
      writeFileSync(cachePath, JSON.stringify(oldCache));
      
      // Should try to fetch but fail, then fall back to stale cache
      const result = await getModelsDev({
        cachePath,
        url: "http://invalid-url-that-does-not-exist.local/api.json",
        ttlMs: 12 * 60 * 60 * 1000,
        version: CURRENT_VERSION
      });
      
      // Falls back to stale cache
      assert.ok(result !== null);
      assert.deepStrictEqual(result, SAMPLE_DATA);
    });

    it("fetches when version changes", async () => {
      // Write cache with old version
      const oldCache: CacheEntry = {
        version: OLD_VERSION,
        fetchedAt: Date.now(),
        data: SAMPLE_DATA as any
      };
      writeFileSync(cachePath, JSON.stringify(oldCache));
      
      // Should try to fetch but fail, then fall back to stale cache
      const result = await getModelsDev({
        cachePath,
        url: "http://invalid-url-that-does-not-exist.local/api.json",
        ttlMs: 12 * 60 * 60 * 1000,
        version: CURRENT_VERSION
      });
      
      // Falls back to stale cache
      assert.ok(result !== null);
      assert.deepStrictEqual(result, SAMPLE_DATA);
    });

    it("force refresh ignores valid cache", async () => {
      // Write valid cache
      const cache: CacheEntry = {
        version: CURRENT_VERSION,
        fetchedAt: Date.now(),
        data: SAMPLE_DATA as any
      };
      writeFileSync(cachePath, JSON.stringify(cache));
      
      // Force refresh should try to fetch but fail, then fall back
      const result = await refreshModelsDev({
        cachePath,
        url: "http://invalid-url-that-does-not-exist.local/api.json",
        version: CURRENT_VERSION
      });
      
      // Falls back to cache since fetch fails
      assert.ok(result !== null);
      assert.deepStrictEqual(result, SAMPLE_DATA);
    });
  });
});
