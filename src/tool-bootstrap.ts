import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { delimiter, join } from "node:path";

type ManagedTool = "fd" | "rg";

interface ToolSpec {
  targetName: string;
  candidates: string[];
}

const TOOL_SPECS: Record<ManagedTool, ToolSpec> = {
  fd: {
    targetName: process.platform === "win32" ? "fd.exe" : "fd",
    candidates: process.platform === "win32" ? ["fd.exe", "fd", "fdfind.exe", "fdfind"] : ["fd", "fdfind"],
  },
  rg: {
    targetName: process.platform === "win32" ? "rg.exe" : "rg",
    candidates: process.platform === "win32" ? ["rg.exe", "rg"] : ["rg"],
  },
};

function splitPath(pathValue: string | undefined): string[] {
  if (!pathValue) return [];
  return pathValue.split(delimiter).map((segment) => segment.trim()).filter(Boolean);
}

function getCandidateNames(name: string): string[] {
  if (process.platform !== "win32") return [name];
  const lower = name.toLowerCase();
  if (lower.endsWith(".exe") || lower.endsWith(".cmd") || lower.endsWith(".bat")) return [name];
  return [name, `${name}.exe`, `${name}.cmd`, `${name}.bat`];
}

function isRegularFile(path: string): boolean {
  try {
    return lstatSync(path).isFile() || lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

export function resolveToolFromPath(tool: ManagedTool, pathValue: string | undefined = process.env.PATH): string | null {
  const spec = TOOL_SPECS[tool];
  for (const dir of splitPath(pathValue)) {
    for (const candidate of spec.candidates) {
      for (const name of getCandidateNames(candidate)) {
        const fullPath = join(dir, name);
        if (existsSync(fullPath) && isRegularFile(fullPath)) {
          return fullPath;
        }
      }
    }
  }
  return null;
}

function provisionTool(targetDir: string, tool: ManagedTool, sourcePath: string): string {
  const targetPath = join(targetDir, TOOL_SPECS[tool].targetName);
  if (existsSync(targetPath)) return targetPath;

  mkdirSync(targetDir, { recursive: true });

  try {
    symlinkSync(sourcePath, targetPath);
  } catch {
    rmSync(targetPath, { force: true });
    copyFileSync(sourcePath, targetPath);
    chmodSync(targetPath, 0o755);
  }

  return targetPath;
}

export function ensureManagedTools(targetDir: string, pathValue: string | undefined = process.env.PATH): string[] {
  const provisioned: string[] = [];

  for (const tool of Object.keys(TOOL_SPECS) as ManagedTool[]) {
    if (existsSync(join(targetDir, TOOL_SPECS[tool].targetName))) continue;
    const sourcePath = resolveToolFromPath(tool, pathValue);
    if (!sourcePath) continue;
    provisioned.push(provisionTool(targetDir, tool, sourcePath));
  }

  return provisioned;
}
