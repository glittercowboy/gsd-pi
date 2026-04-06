// GSD Community Hooks — Style Enforcer
//
// Runs linter/formatter checks on files after the agent writes them. Appends
// any warnings or errors to the tool result so the agent can self-correct.

import { existsSync, readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { join, extname } from "node:path";
import type { ExtensionAPI } from "@gsd/pi-coding-agent";
import { recordFire, recordAction } from "./stats.js";

interface LintRunner {
  name: string;
  extensions: Set<string>;
  bin: string;
  args: (filePath: string) => string[];
  /** Check file to determine if this linter is available. */
  detectFile?: string;
}

function detectLinters(cwd: string): LintRunner[] {
  const runners: LintRunner[] = [];

  // Check for ESLint
  const eslintConfigs = [
    ".eslintrc.js", ".eslintrc.cjs", ".eslintrc.json", ".eslintrc.yml",
    "eslint.config.js", "eslint.config.mjs", "eslint.config.ts",
  ];
  if (eslintConfigs.some((c) => existsSync(join(cwd, c)))) {
    runners.push({
      name: "ESLint",
      extensions: new Set([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"]),
      bin: "npx",
      args: (f) => ["eslint", "--no-error-on-unmatched-pattern", "--format", "compact", f],
    });
  }

  // Check for Biome
  if (existsSync(join(cwd, "biome.json")) || existsSync(join(cwd, "biome.jsonc"))) {
    runners.push({
      name: "Biome",
      extensions: new Set([".js", ".jsx", ".ts", ".tsx", ".json", ".css"]),
      bin: "npx",
      args: (f) => ["@biomejs/biome", "check", f],
    });
  }

  // Check for Prettier
  const prettierConfigs = [
    ".prettierrc", ".prettierrc.js", ".prettierrc.json", ".prettierrc.yml",
    "prettier.config.js", "prettier.config.mjs",
  ];
  if (prettierConfigs.some((c) => existsSync(join(cwd, c)))) {
    runners.push({
      name: "Prettier",
      extensions: new Set([".js", ".jsx", ".ts", ".tsx", ".css", ".scss", ".json", ".md", ".html", ".vue", ".svelte"]),
      bin: "npx",
      args: (f) => ["prettier", "--check", f],
    });
  }

  // Check for Ruff (Python)
  if (existsSync(join(cwd, "pyproject.toml")) || existsSync(join(cwd, "ruff.toml"))) {
    runners.push({
      name: "Ruff",
      extensions: new Set([".py"]),
      bin: "ruff",
      args: (f) => ["check", "--output-format", "concise", f],
    });
  }

  // Check for Clippy (Rust)
  if (existsSync(join(cwd, "Cargo.toml"))) {
    runners.push({
      name: "Clippy",
      extensions: new Set([".rs"]),
      bin: "cargo",
      args: () => ["clippy", "--message-format=short"],
    });
  }

  // Check for golangci-lint (Go)
  if (existsSync(join(cwd, ".golangci.yml")) || existsSync(join(cwd, ".golangci.yaml"))) {
    runners.push({
      name: "golangci-lint",
      extensions: new Set([".go"]),
      bin: "golangci-lint",
      args: (f) => ["run", "--new-from-rev=HEAD", f],
    });
  }

  return runners;
}

function runLinter(runner: LintRunner, filePath: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(runner.bin, runner.args(filePath), {
      cwd: process.cwd(),
      timeout: 30_000,
      maxBuffer: 512 * 1024,
    }, (error, stdout, stderr) => {
      if (!error) {
        resolve(null); // No issues
        return;
      }
      const output = (stdout?.toString() ?? "") + (stderr?.toString() ?? "");
      const trimmed = output.trim();
      if (trimmed) {
        // Cap output to avoid bloating the context
        const capped = trimmed.length > 2000
          ? trimmed.slice(0, 2000) + "\n...[truncated]"
          : trimmed;
        resolve(`${runner.name}:\n${capped}`);
      } else {
        resolve(null);
      }
    });
  });
}

export function registerStyleEnforcer(pi: ExtensionAPI): void {
  let linters: LintRunner[] | null = null;

  pi.on("session_start", async () => {
    linters = detectLinters(process.cwd());
  });

  pi.on("tool_result", async (event) => {
    if (event.isError) return;
    if (event.toolName !== "write" && event.toolName !== "edit") return;
    if (!linters || linters.length === 0) return;

    const filePath = (event.input as Record<string, unknown>).path as string;
    if (!filePath) return;

    const ext = extname(filePath).toLowerCase();
    const applicable = linters.filter((l) => l.extensions.has(ext));
    if (applicable.length === 0) return;

    recordFire("styleEnforcer");

    // Run all applicable linters in parallel
    const results = await Promise.all(
      applicable.map((l) => runLinter(l, filePath)),
    );

    const issues = results.filter(Boolean) as string[];
    if (issues.length === 0) return;

    recordAction("styleEnforcer", `${issues.length} issue(s) in ${filePath}`);

    // Append lint warnings to the tool result
    const warning = `\n\n--- Style Issues ---\n${issues.join("\n\n")}\n\nPlease fix these style issues.`;

    return {
      content: [
        ...event.content,
        { type: "text" as const, text: warning },
      ],
    };
  });
}
