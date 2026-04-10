import { describe, it } from "node:test";
import assert from "node:assert/strict";

// TDD: 先写测试，再实现功能
// 导入待实现的模块
import { FileIgnore } from "./file-ignore.js";

describe("FileIgnore", () => {
  describe("FOLDERS", () => {
    it("should contain essential ignore directories", () => {
      const essentialDirs = [
        "node_modules", "dist", "build", "out", ".next",
        "target", "__pycache__", ".cache", "coverage", "vendor",
        ".git", ".vscode", ".idea", ".turbo",
        "bower_components", ".pnpm-store",
      ];
      for (const dir of essentialDirs) {
        assert.ok(FileIgnore.FOLDERS.has(dir), `Missing essential directory: ${dir}`);
      }
    });

    it("should be a Set of strings", () => {
      assert.ok(FileIgnore.FOLDERS instanceof Set);
      for (const dir of FileIgnore.FOLDERS) {
        assert.strictEqual(typeof dir, "string");
      }
    });
  });

  describe("FILES", () => {
    it("should contain essential file patterns", () => {
      const essentialPatterns = [
        "**/*.swp", "**/*.pyc",
        "**/.DS_Store", "**/Thumbs.db",
        "**/*.log",
      ];
      for (const pattern of essentialPatterns) {
        assert.ok(FileIgnore.FILES.includes(pattern), `Missing essential pattern: ${pattern}`);
      }
    });

    it("should be an array of glob patterns", () => {
      assert.ok(Array.isArray(FileIgnore.FILES));
    });
  });

  describe("match()", () => {
    it("should ignore paths with FOLDERS in any segment", () => {
      assert.ok(FileIgnore.match("src/node_modules/react/index.js"));
      assert.ok(FileIgnore.match("project/dist/bundle.js"));
      assert.ok(FileIgnore.match("app/__pycache__/main.pyc"));
      assert.ok(FileIgnore.match("coverage/lcov-report/index.html"));
      assert.ok(FileIgnore.match(".git/HEAD"));
      assert.ok(FileIgnore.match("packages/native/src/.cache/data.json"));
    });

    it("should ignore paths matching FILES patterns", () => {
      assert.ok(FileIgnore.match("src/file.swp"));
      assert.ok(FileIgnore.match("src/__pycache__/main.pyc"));
      assert.ok(FileIgnore.match(".DS_Store"));
      assert.ok(FileIgnore.match("logs/app.log"));
    });

    it("should NOT ignore normal source files", () => {
      assert.ok(!FileIgnore.match("src/index.ts"));
      assert.ok(!FileIgnore.match("packages/core/lib.rs"));
      assert.ok(!FileIgnore.match("README.md"));
      assert.ok(!FileIgnore.match("app/components/Button.tsx"));
      assert.ok(!FileIgnore.match("tests/unit.test.ts"));
    });

    it("should respect whitelist patterns", () => {
      // node_modules is normally ignored
      assert.ok(FileIgnore.match("node_modules/react/index.js"));
      // but whitelist overrides
      assert.ok(!FileIgnore.match("node_modules/react/index.js", {
        whitelist: ["node_modules/react/**"],
      }));
    });

    it("should support extra ignore patterns", () => {
      // Not ignored by default
      assert.ok(!FileIgnore.match("secrets/api-key.pem"));
      // But extra patterns can add it
      assert.ok(FileIgnore.match("secrets/api-key.pem", {
        extra: ["**/*.pem"],
      }));
    });

    it("should handle Windows-style backslash paths", () => {
      assert.ok(FileIgnore.match("src\\node_modules\\react\\index.js"));
      assert.ok(FileIgnore.match("project\\dist\\bundle.js"));
    });

    it("should handle paths with multiple directory segments", () => {
      assert.ok(FileIgnore.match("apps/web/node_modules/lodash/index.js"));
      assert.ok(FileIgnore.match("packages/api/dist/controllers/user.js"));
    });

    it("should NOT ignore files that happen to contain a folder name as substring", () => {
      // "node_modules_test" should NOT be ignored — it's not the "node_modules" directory
      // But "my_node_modules" IS ignored because the path segment is exactly "my_node_modules",
      // not "node_modules". Let's test with exact segment matching.
      assert.ok(!FileIgnore.match("src/node_modules_utils/helper.ts"));
    });
  });

  describe("ripgrepNegateGlobs()", () => {
    it("should return an array of strings", () => {
      const globs = FileIgnore.ripgrepNegateGlobs();
      assert.ok(Array.isArray(globs));
      assert.ok(globs.length > 0);
    });

    it("should prefix all patterns with !", () => {
      const globs = FileIgnore.ripgrepNegateGlobs();
      for (const g of globs) {
        assert.ok(g.startsWith("!"), `Pattern should start with !: ${g}`);
      }
    });

    it("should include negate patterns for key directories", () => {
      const globs = FileIgnore.ripgrepNegateGlobs();
      assert.ok(globs.includes("!node_modules/"), "Should include !node_modules/");
      assert.ok(globs.includes("!dist/"), "Should include !dist/");
      assert.ok(globs.includes("!build/"), "Should include !build/");
      assert.ok(globs.includes("!__pycache__/"), "Should include !__pycache__/");
    });

    it("should include negate patterns for file patterns", () => {
      const globs = FileIgnore.ripgrepNegateGlobs();
      assert.ok(globs.some(g => g.includes(".swp")), "Should include .swp pattern");
      assert.ok(globs.some(g => g.includes(".pyc")), "Should include .pyc pattern");
    });
  });

  describe("nativeGlobPatterns()", () => {
    it("should return an array of strings", () => {
      const patterns = FileIgnore.nativeGlobPatterns();
      assert.ok(Array.isArray(patterns));
      assert.ok(patterns.length > 0);
    });

    it("should wrap folder names with **/ prefix and /** suffix", () => {
      const patterns = FileIgnore.nativeGlobPatterns();
      assert.ok(patterns.includes("**/node_modules/**"), "Should include **/node_modules/**");
      assert.ok(patterns.includes("**/dist/**"), "Should include **/dist/**");
      assert.ok(patterns.includes("**/__pycache__/**"), "Should include **/__pycache__/**");
    });

    it("should have one pattern per FOLDERS entry", () => {
      const patterns = FileIgnore.nativeGlobPatterns();
      assert.strictEqual(patterns.length, FileIgnore.FOLDERS.size);
    });
  });
});
