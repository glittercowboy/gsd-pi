import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type FakeRtkResponse = string | { status?: number; stdout?: string };

export function createFakeRtk(mapping: Record<string, FakeRtkResponse>): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "gsd-fake-rtk-"));
  const payload = JSON.stringify(mapping);

  const jsSource = `#!/usr/bin/env node
const mapping = ${payload};
const args = process.argv.slice(2);
const fullInput = args.join(' ');
const rewriteInput = args[0] === 'rewrite' ? args.slice(1).join(' ') : null;
const match = mapping[fullInput] ?? (rewriteInput !== null ? mapping[rewriteInput] : undefined);
if (match === undefined) process.exit(1);
if (typeof match === 'string') {
  process.stdout.write(match);
  process.exit(0);
}
if (match.stdout) process.stdout.write(match.stdout);
process.exit(match.status ?? 0);
`;

  if (process.platform === "win32") {
    const jsPath = join(dir, "fake-rtk.js");
    const cmdPath = join(dir, "rtk.cmd");
    writeFileSync(jsPath, jsSource, "utf-8");
    // Use the absolute jsPath so the .cmd works even when copied to another directory.
    writeFileSync(cmdPath, `@echo off\r\n"${process.execPath}" "${jsPath}" %*\r\n`, "utf-8");
    return {
      path: cmdPath,
      cleanup: () => rmSync(dir, { recursive: true, force: true }),
    };
  }

  const binaryPath = join(dir, "rtk");
  writeFileSync(binaryPath, jsSource, "utf-8");
  chmodSync(binaryPath, 0o755);
  return {
    path: binaryPath,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}
