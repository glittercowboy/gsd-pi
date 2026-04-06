// GSD Community Hooks — Auto Test Runner
//
// Detects code changes after the agent finishes and automatically runs the
// project's test suite. Identifies the test runner from package.json, Cargo.toml,
// pyproject.toml, or other project config files.

import { existsSync, readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { join } from "node:path";
import type { ExtensionAPI } from "@gsd/pi-coding-agent";
import { recordFire, recordAction } from "./stats.js";

/** Test runner configuration detected from project files. */
interface TestRunner {
  name: string;
  bin: string;
  args: string[];
}

/** Detects the project's test runner from configuration files. */
function detectTestRunner(cwd: string): TestRunner | null {
  // Node.js — check package.json scripts
  const pkgPath = join(cwd, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      const testScript = pkg.scripts?.test;
      if (testScript && testScript !== "echo \"Error: no test specified\" && exit 1") {
        return { name: "npm test", bin: "npm", args: ["test", "--", "--bail"] };
      }
      // Check for common test runners in devDependencies
      const deps = { ...pkg.devDependencies, ...pkg.dependencies };
      if (deps.vitest) return { name: "vitest", bin: "npx", args: ["vitest", "run"] };
      if (deps.jest) return { name: "jest", bin: "npx", args: ["jest", "--bail"] };
      if (deps.mocha) return { name: "mocha", bin: "npx", args: ["mocha"] };
    } catch { /* skip malformed */ }
  }

  // Python — check pyproject.toml or setup.cfg
  if (existsSync(join(cwd, "pyproject.toml")) || existsSync(join(cwd, "setup.cfg"))) {
    return { name: "pytest", bin: "pytest", args: ["-x", "--tb=short", "-q"] };
  }

  // Rust
  if (existsSync(join(cwd, "Cargo.toml"))) {
    return { name: "cargo test", bin: "cargo", args: ["test"] };
  }

  // Go
  if (existsSync(join(cwd, "go.mod"))) {
    return { name: "go test", bin: "go", args: ["test", "./..."] };
  }

  // Ruby
  if (existsSync(join(cwd, "Gemfile"))) {
    return { name: "rspec", bin: "bundle", args: ["exec", "rspec"] };
  }

  return null;
}

/** Check if the agent made code changes (not just reads/searches). */
function hasCodeChanges(messages: Array<{ role: string; toolCalls?: Array<{ name: string }> }>): boolean {
  for (const msg of messages) {
    if (msg.role !== "assistant" || !msg.toolCalls) continue;
    for (const tc of msg.toolCalls) {
      if (tc.name === "write" || tc.name === "edit") return true;
    }
  }
  return false;
}

export function registerAutoTestRunner(pi: ExtensionAPI): void {
  pi.on("agent_end", async (event, ctx) => {
    const cwd = process.cwd();
    const runner = detectTestRunner(cwd);
    if (!runner) return;

    // Only run tests if the agent actually wrote/edited files
    const messages = event.messages as Array<{ role: string; toolCalls?: Array<{ name: string }> }>;
    if (!hasCodeChanges(messages)) return;

    recordFire("autoTestRunner");
    ctx.ui.notify(`Running ${runner.name}...`, "info");

    try {
      const result = await new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve) => {
        execFile(runner.bin, runner.args, {
          cwd,
          timeout: 120_000,
          maxBuffer: 5 * 1024 * 1024,
          env: { ...process.env, CI: "true", FORCE_COLOR: "0" },
        }, (error, stdout, stderr) => {
          resolve({
            stdout: stdout?.toString() ?? "",
            stderr: stderr?.toString() ?? "",
            exitCode: error ? (error as any).code ?? 1 : 0,
          });
        });
      });

      if (result.exitCode === 0) {
        recordAction("autoTestRunner", "All tests passed");
        ctx.ui.notify(`${runner.name}: All tests passed`, "info");
      } else {
        recordAction("autoTestRunner", "Tests failed");
        // Extract failure summary (last few lines usually have the summary)
        const output = (result.stdout + "\n" + result.stderr).trim();
        const lastLines = output.split("\n").slice(-5).join("\n");
        ctx.ui.notify(`${runner.name}: Tests failed\n${lastLines}`, "error");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.ui.notify(`${runner.name}: Failed to run — ${msg}`, "warning");
    }
  });
}
