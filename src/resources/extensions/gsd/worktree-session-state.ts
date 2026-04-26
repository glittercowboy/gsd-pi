// GSD worktree session state
let originalCwd: string | null = null;

export function getWorktreeOriginalCwd(): string | null {
  return originalCwd;
}

export function setWorktreeOriginalCwd(cwd: string): void {
  originalCwd = cwd;
}

export function clearWorktreeOriginalCwd(): void {
  originalCwd = null;
}

export function ensureWorktreeOriginalCwdFromPath(cwd: string = process.cwd()): string | null {
  if (originalCwd) return originalCwd;
  const marker = `${/\\/.test(cwd) ? "\\" : "/"}.gsd${/\\/.test(cwd) ? "\\" : "/"}worktrees${/\\/.test(cwd) ? "\\" : "/"}`;
  const markerIdx = cwd.indexOf(marker);
  if (markerIdx !== -1) {
    originalCwd = cwd.slice(0, markerIdx);
  }
  return originalCwd;
}

export function getActiveWorktreeName(): string | null {
  if (!originalCwd) return null;
  const cwd = process.cwd();
  const wtDir = `${originalCwd.replace(/[\\/]+$/, "")}/.gsd/worktrees`.replaceAll("\\", "/");
  const normalizedCwd = cwd.replaceAll("\\", "/");
  if (!normalizedCwd.startsWith(`${wtDir}/`)) return null;
  const rel = normalizedCwd.slice(wtDir.length + 1);
  const name = rel.split("/")[0];
  return name || null;
}
