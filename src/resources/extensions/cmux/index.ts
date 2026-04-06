import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GSDPreferences } from "../gsd/preferences.js";
import type { GSDState, Phase } from "../gsd/types.js";
const DEFAULT_SOCKET_PATH = "/tmp/cmux.sock";
const STATUS_KEY = "gsd";
const lastSidebarSnapshots = new Map<string, string>();
let cmuxPromptedThisSession = false;
let cachedCliAvailability: boolean | null = null;

export interface CmuxEnvironment {
  available: boolean;
  cliAvailable: boolean;
  socketPath: string;
  workspaceId?: string;
  surfaceId?: string;
}

export interface ResolvedCmuxConfig extends CmuxEnvironment {
  enabled: boolean;
  notifications: boolean;
  sidebar: boolean;
  splits: boolean;
  browser: boolean;
}

export interface CmuxSidebarProgress {
  value: number;
  label: string;
}

export type CmuxLogLevel = "info" | "progress" | "success" | "warning" | "error";

export function detectCmuxEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  socketExists: (path: string) => boolean = existsSync,
  cliAvailable: () => boolean = isCmuxCliAvailable,
): CmuxEnvironment {
  const socketPath = env.CMUX_SOCKET_PATH ?? DEFAULT_SOCKET_PATH;
  const workspaceId = env.CMUX_WORKSPACE_ID?.trim() || undefined;
  const surfaceId = env.CMUX_SURFACE_ID?.trim() || undefined;
  const available = Boolean(workspaceId && surfaceId && socketExists(socketPath));
  return {
    available,
    cliAvailable: cliAvailable(),
    socketPath,
    workspaceId,
    surfaceId,
  };
}

export function resolveCmuxConfig(
  preferences: GSDPreferences | undefined,
  env: NodeJS.ProcessEnv = process.env,
  socketExists: (path: string) => boolean = existsSync,
  cliAvailable: () => boolean = isCmuxCliAvailable,
): ResolvedCmuxConfig {
  const detected = detectCmuxEnvironment(env, socketExists, cliAvailable);
  const cmux = preferences?.cmux ?? {};
  const enabled = detected.available && cmux.enabled === true;
  return {
    ...detected,
    enabled,
    notifications: enabled && cmux.notifications !== false,
    sidebar: enabled && cmux.sidebar !== false,
    splits: enabled && cmux.splits === true,
    browser: enabled && cmux.browser === true,
  };
}

export function shouldPromptToEnableCmux(
  preferences: GSDPreferences | undefined,
  env: NodeJS.ProcessEnv = process.env,
  socketExists: (path: string) => boolean = existsSync,
  cliAvailable: () => boolean = isCmuxCliAvailable,
): boolean {
  if (cmuxPromptedThisSession) return false;
  const detected = detectCmuxEnvironment(env, socketExists, cliAvailable);
  if (!detected.available) return false;
  return preferences?.cmux?.enabled === undefined;
}

export function markCmuxPromptShown(): void {
  cmuxPromptedThisSession = true;
}

export function resetCmuxPromptState(): void {
  cmuxPromptedThisSession = false;
}

export function isCmuxCliAvailable(): boolean {
  if (cachedCliAvailability !== null) return cachedCliAvailability;
  try {
    execFileSync("cmux", ["--help"], { stdio: "ignore", timeout: 1000 });
    cachedCliAvailability = true;
  } catch {
    cachedCliAvailability = false;
  }
  return cachedCliAvailability;
}

export function supportsOsc777Notifications(env: NodeJS.ProcessEnv = process.env): boolean {
  const termProgram = env.TERM_PROGRAM?.toLowerCase() ?? "";
  return termProgram === "ghostty" || termProgram === "wezterm" || termProgram === "iterm.app";
}

export function emitOsc777Notification(title: string, body: string): void {
  if (!supportsOsc777Notifications()) return;
  const safeTitle = normalizeNotificationText(title).replace(/;/g, ",");
  const safeBody = normalizeNotificationText(body).replace(/;/g, ",");
  process.stdout.write(`\x1b]777;notify;${safeTitle};${safeBody}\x07`);
}

export function buildCmuxStatusLabel(state: GSDState): string {
  const parts: string[] = [];
  if (state.activeMilestone) parts.push(state.activeMilestone.id);
  if (state.activeSlice) parts.push(state.activeSlice.id);
  if (state.activeTask) {
    const prev = parts.pop();
    parts.push(prev ? `${prev}/${state.activeTask.id}` : state.activeTask.id);
  }
  if (parts.length === 0) return state.phase;
  return `${parts.join(" ")} · ${state.phase}`;
}

export function buildCmuxProgress(state: GSDState): CmuxSidebarProgress | null {
  const progress = state.progress;
  if (!progress) return null;

  const choose = (done: number, total: number, label: string): CmuxSidebarProgress | null => {
    if (total <= 0) return null;
    return { value: Math.max(0, Math.min(1, done / total)), label: `${done}/${total} ${label}` };
  };

  return choose(progress.tasks?.done ?? 0, progress.tasks?.total ?? 0, "tasks")
    ?? choose(progress.slices?.done ?? 0, progress.slices?.total ?? 0, "slices")
    ?? choose(progress.milestones.done, progress.milestones.total, "milestones");
}

function phaseVisuals(phase: Phase): { icon: string; color: string } {
  switch (phase) {
    case "blocked":
      return { icon: "triangle-alert", color: "#ef4444" };
    case "paused":
      return { icon: "pause", color: "#f59e0b" };
    case "complete":
    case "completing-milestone":
      return { icon: "check", color: "#22c55e" };
    case "planning":
    case "researching":
    case "replanning-slice":
      return { icon: "compass", color: "#3b82f6" };
    case "validating-milestone":
    case "verifying":
      return { icon: "shield-check", color: "#06b6d4" };
    default:
      return { icon: "rocket", color: "#4ade80" };
  }
}

function sidebarSnapshotKey(config: ResolvedCmuxConfig): string {
  return config.workspaceId ?? "default";
}

export class CmuxClient {
  private readonly config: ResolvedCmuxConfig;

  constructor(config: ResolvedCmuxConfig) {
    this.config = config;
  }

  static fromPreferences(preferences: GSDPreferences | undefined): CmuxClient {
    return new CmuxClient(resolveCmuxConfig(preferences));
  }

  getConfig(): ResolvedCmuxConfig {
    return this.config;
  }

  private canRun(): boolean {
    return this.config.available && this.config.cliAvailable;
  }

  private appendWorkspace(args: string[]): string[] {
    return this.config.workspaceId ? [...args, "--workspace", this.config.workspaceId] : args;
  }

  private appendSurface(args: string[], surfaceId?: string): string[] {
    return surfaceId ? [...args, "--surface", surfaceId] : args;
  }

  private runSync(args: string[]): string | null {
    if (!this.canRun()) return null;
    try {
      return execFileSync("cmux", args, {
        encoding: "utf-8",
        timeout: 3000,
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
      });
    } catch {
      return null;
    }
  }

  private async runAsync(args: string[]): Promise<string | null> {
    if (!this.canRun()) return null;
    return new Promise<string | null>((resolve) => {
      const child = spawn("cmux", args, {
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
      });
      const chunks: Buffer[] = [];
      let settled = false;
      const done = (result: string | null) => {
        if (!settled) { settled = true; resolve(result); }
      };
      const timer = setTimeout(() => { child.kill(); done(null); }, 5000);
      child.stdout!.on("data", (chunk: Buffer) => chunks.push(chunk));
      child.on("close", (code) => {
        clearTimeout(timer);
        done(code === 0 ? Buffer.concat(chunks).toString("utf-8") : null);
      });
      child.on("error", () => { clearTimeout(timer); done(null); });
    });
  }

  getCapabilities(): unknown | null {
    const stdout = this.runSync(["capabilities", "--json"]);
    return stdout ? parseJson(stdout) : null;
  }

  identify(): unknown | null {
    const stdout = this.runSync(["identify", "--json"]);
    return stdout ? parseJson(stdout) : null;
  }

  setStatus(label: string, phase: Phase): void {
    if (!this.config.sidebar) return;
    const visuals = phaseVisuals(phase);
    this.runSync(this.appendWorkspace([
      "set-status",
      STATUS_KEY,
      label,
      "--icon",
      visuals.icon,
      "--color",
      visuals.color,
    ]));
  }

  clearStatus(): void {
    if (!this.config.sidebar) return;
    this.runSync(this.appendWorkspace(["clear-status", STATUS_KEY]));
  }

  setProgress(progress: CmuxSidebarProgress | null): void {
    if (!this.config.sidebar) return;
    if (!progress) {
      this.runSync(this.appendWorkspace(["clear-progress"]));
      return;
    }
    this.runSync(this.appendWorkspace([
      "set-progress",
      progress.value.toFixed(3),
      "--label",
      progress.label,
    ]));
  }

  log(message: string, level: CmuxLogLevel = "info", source = "gsd"): void {
    if (!this.config.sidebar) return;
    this.runSync(this.appendWorkspace([
      "log",
      "--level",
      level,
      "--source",
      source,
      "--",
      message,
    ]));
  }

  notify(title: string, body: string, subtitle?: string): boolean {
    if (!this.config.notifications) return false;
    const args = ["notify", "--title", title, "--body", body];
    if (subtitle) args.push("--subtitle", subtitle);
    return this.runSync(args) !== null;
  }

  async listSurfaceIds(): Promise<string[]> {
    const stdout = await this.runAsync(this.appendWorkspace(["list-surfaces", "--json", "--id-format", "both"]));
    const parsed = stdout ? parseJson(stdout) : null;
    return extractSurfaceIds(parsed);
  }

  async createSplit(direction: "right" | "down" | "left" | "up"): Promise<string | null> {
    return this.createSplitFrom(this.config.surfaceId, direction);
  }

  async createSplitFrom(
    sourceSurfaceId: string | undefined,
    direction: "right" | "down" | "left" | "up",
  ): Promise<string | null> {
    if (!this.config.splits) return null;
    const before = new Set(await this.listSurfaceIds());
    const args = ["new-split", direction];
    const scopedArgs = this.appendSurface(this.appendWorkspace(args), sourceSurfaceId);
    await this.runAsync(scopedArgs);
    const after = await this.listSurfaceIds();
    for (const id of after) {
      if (!before.has(id)) return id;
    }
    return null;
  }

  /**
   * Create a grid of surfaces for parallel agent execution.
   *
   * Layout strategy (gsd stays in the original surface):
   *   1 agent:  [gsd | A]
   *   2 agents: [gsd | A]
   *             [    | B]
   *   3 agents: [gsd | A]
   *             [ C  | B]
   *   4 agents: [gsd | A]
   *             [ C  | B]  (D splits from B downward)
   *             [    | D]
   *
   * Returns surface IDs in order, or empty array on failure.
   */
  async createGridLayout(count: number): Promise<string[]> {
    if (!this.config.splits || count <= 0) return [];
    const surfaces: string[] = [];

    // First split: create right column from the gsd surface
    const rightCol = await this.createSplitFrom(this.config.surfaceId, "right");
    if (!rightCol) return [];
    surfaces.push(rightCol);
    if (count === 1) return surfaces;

    // Second split: split right column down → bottom-right
    const bottomRight = await this.createSplitFrom(rightCol, "down");
    if (!bottomRight) return surfaces;
    surfaces.push(bottomRight);
    if (count === 2) return surfaces;

    // Third split: split gsd surface down → bottom-left
    const bottomLeft = await this.createSplitFrom(this.config.surfaceId, "down");
    if (!bottomLeft) return surfaces;
    surfaces.push(bottomLeft);
    if (count === 3) return surfaces;

    // Fourth+: split subsequent surfaces down from the last created
    let lastSurface = bottomRight;
    for (let i = 3; i < count; i++) {
      const next = await this.createSplitFrom(lastSurface, "down");
      if (!next) break;
      surfaces.push(next);
      lastSurface = next;
    }

    return surfaces;
  }

  async sendSurface(surfaceId: string, text: string): Promise<boolean> {
    const payload = text.endsWith("\n") ? text : `${text}\n`;
    const stdout = await this.runAsync(["send-surface", "--surface", surfaceId, payload]);
    return stdout !== null;
  }
}

export function syncCmuxSidebar(preferences: GSDPreferences | undefined, state: GSDState): void {
  const client = CmuxClient.fromPreferences(preferences);
  const config = client.getConfig();
  if (!config.sidebar) return;

  const label = buildCmuxStatusLabel(state);
  const progress = buildCmuxProgress(state);
  const snapshot = JSON.stringify({ label, progress, phase: state.phase });
  const key = sidebarSnapshotKey(config);
  if (lastSidebarSnapshots.get(key) === snapshot) return;

  client.setStatus(label, state.phase);
  client.setProgress(progress);
  lastSidebarSnapshots.set(key, snapshot);
}

export function clearCmuxSidebar(preferences: GSDPreferences | undefined): void {
  const config = resolveCmuxConfig(preferences);
  if (!config.available || !config.cliAvailable) return;
  const client = new CmuxClient({ ...config, enabled: true, sidebar: true });
  const key = sidebarSnapshotKey(config);
  client.clearStatus();
  client.setProgress(null);
  lastSidebarSnapshots.delete(key);
}

export function logCmuxEvent(
  preferences: GSDPreferences | undefined,
  message: string,
  level: CmuxLogLevel = "info",
): void {
  CmuxClient.fromPreferences(preferences).log(message, level);
}

export function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function normalizeNotificationText(value: string): string {
  return value.replace(/\r?\n/g, " ").trim();
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function extractSurfaceIds(value: unknown): string[] {
  const found = new Set<string>();

  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (!node || typeof node !== "object") return;

    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      if (
        typeof child === "string"
        && (key === "surface_id" || key === "surface" || (key === "id" && child.includes("surface")))
      ) {
        found.add(child);
      }
      visit(child);
    }
  };

  visit(value);
  return Array.from(found);
}
