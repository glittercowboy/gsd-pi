/**
 * Server-side PTY manager — spawns and manages pseudo-terminal instances.
 *
 * Each terminal session gets a unique ID. PTY output is buffered and streamed
 * to clients via SSE; input arrives via POST.
 */

import { chmodSync, existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, join, dirname } from "node:path";
import type { IPty } from "node-pty";

export interface PtySession {
  id: string;
  pty: IPty;
  listeners: Set<(data: string) => void>;
  alive: boolean;
}

interface LoadedNodePty {
  nodePtyModule: typeof import("node-pty");
  packageRoot: string;
}

// Use globalThis to persist across Turbopack/HMR module re-evaluations in dev
const GLOBAL_KEY = "__gsd_pty_sessions__" as const;
const CLEANUP_GUARD_KEY = "__gsd_pty_cleanup_installed__" as const;

function getSessions(): Map<string, PtySession> {
  const g = globalThis as Record<string, unknown>;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = new Map<string, PtySession>();
  }
  return g[GLOBAL_KEY] as Map<string, PtySession>;
}

function destroyAllSessions(): void {
  const map = getSessions();
  for (const [sessionId, session] of map.entries()) {
    session.alive = false;
    try {
      session.pty.kill();
    } catch {
      // Already dead.
    }
    session.listeners.clear();
    map.delete(sessionId);
  }
}

function ensureProcessCleanupHandlers(): void {
  const g = globalThis as Record<string, unknown>;
  if (g[CLEANUP_GUARD_KEY]) return;
  g[CLEANUP_GUARD_KEY] = true;

  const cleanup = () => {
    destroyAllSessions();
  };

  process.once("exit", cleanup);
  process.once("SIGINT", () => {
    cleanup();
    process.exit(130);
  });
  process.once("SIGTERM", () => {
    cleanup();
    process.exit(143);
  });
  process.once("SIGHUP", () => {
    cleanup();
    process.exit(129);
  });
}

function getDefaultShell(): string {
  if (process.platform === "win32") return "powershell.exe";
  return process.env.SHELL || "/bin/zsh";
}

function getProjectCwd(): string {
  return process.env.GSD_WEB_PROJECT_CWD || process.cwd();
}

function getShellArgs(_shell: string): string[] {
  // Launch an interactive login shell with the user's normal config.
  // Previously we passed -f / --norc to skip rc files, but that removed the
  // user's prompt, PATH, aliases, etc. — making the terminal feel broken.
  // History pollution is already prevented via HISTFILE=/dev/null in the env.
  return [];
}

function getNodePtyCandidateRoots(): string[] {
  const roots = new Set<string>();
  roots.add(process.cwd());

  const packageRoot = process.env.GSD_WEB_PACKAGE_ROOT;
  if (packageRoot) {
    roots.add(packageRoot);
    roots.add(join(packageRoot, "dist", "web", "standalone"));
    roots.add(join(packageRoot, "web"));
  }

  return Array.from(roots);
}

function hasNativeAssets(packageRoot: string): boolean {
  const prebuildDir = join(packageRoot, "prebuilds", `${process.platform}-${process.arch}`);
  return (
    existsSync(join(prebuildDir, "pty.node")) ||
    existsSync(join(packageRoot, "build", "Release", "pty.node")) ||
    existsSync(join(packageRoot, "build", "Debug", "pty.node"))
  );
}

function loadNodePty(): LoadedNodePty {
  const failures: string[] = [];

  for (const root of getNodePtyCandidateRoots()) {
    const packageJsonPath = join(root, "package.json");
    if (!existsSync(packageJsonPath)) {
      failures.push(`${root}: missing package.json`);
      continue;
    }

    try {
      const requireFromRoot = createRequire(packageJsonPath);
      const resolvedPackageJson = requireFromRoot.resolve("node-pty/package.json");
      const packageRoot = dirname(resolvedPackageJson);

      if (!hasNativeAssets(packageRoot)) {
        failures.push(`${packageRoot}: missing native assets`);
        continue;
      }

      const nodePtyModule = requireFromRoot("node-pty") as typeof import("node-pty");
      return { nodePtyModule, packageRoot };
    } catch (error) {
      failures.push(
        `${root}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  throw new Error(
    `Failed to load node-pty with native assets. Tried: ${failures.join(" | ") || "no candidate roots"}`,
  );
}

export function getOrCreateSession(sessionId: string): PtySession {
  ensureProcessCleanupHandlers();
  const map = getSessions();
  const existing = map.get(sessionId);
  if (existing?.alive) return existing;

  // Clean up dead session if it exists
  if (existing) {
    map.delete(sessionId);
  }

  const { nodePtyModule: pty, packageRoot: nodePtyRoot } = loadNodePty();

  // Ensure the spawn-helper binary is executable (npm doesn't always preserve permissions)
  try {
    const helperPath = join(
      nodePtyRoot,
      "prebuilds",
      `${process.platform}-${process.arch}`,
      "spawn-helper",
    );
    if (existsSync(helperPath)) {
      const st = statSync(helperPath);
      if ((st.mode & 0o111) === 0) {
        chmodSync(helperPath, st.mode | 0o755);
        console.log("[pty] Fixed spawn-helper permissions:", helperPath);
      }
    }
  } catch (e) {
    console.warn("[pty] Could not check spawn-helper:", e);
  }

  const shell = getDefaultShell();
  const cwd = getProjectCwd();
  console.log("[pty] Spawning shell:", shell, "cwd:", cwd, "node-pty:", nodePtyRoot);

  // Build a clean env — remove GSD-specific vars that would confuse a shell
  const cleanEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith("GSD_WEB_")) {
      cleanEnv[key] = value;
    }
  }
  cleanEnv.TERM = "xterm-256color";
  cleanEnv.COLORTERM = "truecolor";
  cleanEnv.HISTFILE = "/dev/null";
  cleanEnv.HISTSIZE = "0";
  cleanEnv.SAVEHIST = "0";
  cleanEnv.LESSHISTFILE = "/dev/null";
  cleanEnv.NODE_REPL_HISTORY = "/dev/null";

  const shellArgs = getShellArgs(shell);

  let ptyProcess: IPty;
  try {
    ptyProcess = pty.spawn(shell, shellArgs, {
      name: "xterm-256color",
      cols: 120,
      rows: 30,
      cwd,
      env: cleanEnv,
    });
    console.log("[pty] Spawned pid:", ptyProcess.pid);
  } catch (spawnError) {
    console.error("[pty] Spawn failed:", spawnError);
    console.error("[pty] Shell:", shell, "CWD:", cwd);
    console.error("[pty] CWD exists:", existsSync(cwd));
    throw spawnError;
  }

  const session: PtySession = {
    id: sessionId,
    pty: ptyProcess,
    listeners: new Set(),
    alive: true,
  };

  ptyProcess.onData((data: string) => {
    for (const listener of session.listeners) {
      try {
        listener(data);
      } catch {
        // Listener may have been removed during iteration
      }
    }
  });

  ptyProcess.onExit(({ exitCode, signal }) => {
    session.alive = false;
    // Notify listeners about exit
    const exitMessage = `\r\n\x1b[90m[Process exited with code ${exitCode}${signal ? `, signal ${signal}` : ""}]\x1b[0m\r\n`;
    for (const listener of session.listeners) {
      try {
        listener(exitMessage);
      } catch {
        // ignore
      }
    }
  });

  map.set(sessionId, session);
  return session;
}

export function writeToSession(sessionId: string, data: string): boolean {
  const session = getSessions().get(sessionId);
  if (!session?.alive) return false;
  session.pty.write(data);
  return true;
}

export function resizeSession(
  sessionId: string,
  cols: number,
  rows: number,
): boolean {
  const session = getSessions().get(sessionId);
  if (!session?.alive) return false;
  try {
    session.pty.resize(cols, rows);
    return true;
  } catch {
    return false;
  }
}

export function destroySession(sessionId: string): boolean {
  const map = getSessions();
  const session = map.get(sessionId);
  if (!session) return false;
  session.alive = false;
  try {
    session.pty.kill();
  } catch {
    // Already dead
  }
  session.listeners.clear();
  map.delete(sessionId);
  return true;
}

export function addListener(
  sessionId: string,
  listener: (data: string) => void,
): (() => void) | null {
  const session = getSessions().get(sessionId);
  if (!session) return null;
  session.listeners.add(listener);
  return () => {
    session.listeners.delete(listener);
  };
}

export function isSessionAlive(sessionId: string): boolean {
  const session = getSessions().get(sessionId);
  return session?.alive ?? false;
}

export interface PtySessionInfo {
  id: string;
  alive: boolean;
  pid: number | undefined;
}

export function listSessions(): PtySessionInfo[] {
  const map = getSessions();
  return Array.from(map.values()).map((s) => ({
    id: s.id,
    alive: s.alive,
    pid: s.pty.pid,
  }));
}
