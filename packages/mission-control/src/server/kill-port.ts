/**
 * Kill any process holding a given TCP port before we try to bind it.
 * Prevents "EADDRINUSE" crashes when a previous server process wasn't cleanly shut down.
 */
import { execSync } from "node:child_process";

function getPidsOnPort(port: number): number[] {
  try {
    if (process.platform === "win32") {
      // Only kill processes LISTENING on the port (not clients connecting to it)
      const out = execSync(`netstat -ano | findstr ":${port}.*LISTENING"`, {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      const pids = new Set<number>();
      for (const line of out.split("\n")) {
        const parts = line.trim().split(/\s+/);
        // Format: Proto  LocalAddr  ForeignAddr  State  PID
        const pid = parseInt(parts[parts.length - 1], 10);
        if (pid && !isNaN(pid) && pid !== process.pid) pids.add(pid);
      }
      return [...pids];
    } else {
      // lsof -ti :<port> returns newline-separated PIDs
      const out = execSync(`lsof -ti :${port}`, {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      return out
        .split("\n")
        .map((l) => parseInt(l.trim(), 10))
        .filter((p) => !isNaN(p) && p !== process.pid);
    }
  } catch {
    return [];
  }
}

function killPid(pid: number): void {
  try {
    if (process.platform === "win32") {
      execSync(`taskkill /PID ${pid} /F`, { stdio: "pipe" });
    } else {
      process.kill(pid, "SIGKILL");
    }
  } catch {
    // Process may have already exited
  }
}

/**
 * Free a port by killing whatever process is holding it.
 * Waits briefly after killing to let the OS reclaim the port.
 */
export async function freePort(port: number): Promise<void> {
  const pids = getPidsOnPort(port);
  if (pids.length === 0) return;

  console.log(`[kill-port] Port ${port} held by PID(s) ${pids.join(", ")} — killing...`);
  for (const pid of pids) {
    killPid(pid);
  }

  // Wait for OS to reclaim the port (up to 2s)
  for (let i = 0; i < 20; i++) {
    await Bun.sleep(100);
    if (getPidsOnPort(port).length === 0) break;
  }
}
