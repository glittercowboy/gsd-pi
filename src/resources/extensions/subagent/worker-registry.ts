/**
 * Worker Registry — Tracks active subagent sessions for dashboard visibility.
 *
 * Provides a global registry of currently-running parallel workers so the
 * GSD dashboard overlay can display real-time worker status.
 */

export interface WorkerEntry {
  id: string;
  agent: string;
  task: string;
  startedAt: number;
  status: "running" | "completed" | "failed";
  /** Index within a parallel batch (0-based) */
  index: number;
  /** Total workers in the parallel batch */
  batchSize: number;
  /** Unique batch identifier for grouping parallel runs */
  batchId: string;
}

const activeWorkers = new Map<string, WorkerEntry>();
let workerIdCounter = 0;

/**
 * Register a new worker. Returns the worker ID for later updates.
 */
export function registerWorker(
  agent: string,
  task: string,
  index: number,
  batchSize: number,
  batchId: string,
): string {
  const id = `worker-${++workerIdCounter}`;
  activeWorkers.set(id, {
    id,
    agent,
    task,
    startedAt: Date.now(),
    status: "running",
    index,
    batchSize,
    batchId,
  });
  return id;
}

/**
 * Update worker status when it completes or fails.
 */
export function updateWorker(id: string, status: "completed" | "failed"): void {
  const entry = activeWorkers.get(id);
  if (entry) {
    entry.status = status;
    // Remove after a brief display window (5 seconds)
    setTimeout(() => {
      activeWorkers.delete(id);
    }, 5000);
  }
}

/**
 * Get all currently-tracked workers (running + recently completed).
 */
export function getActiveWorkers(): WorkerEntry[] {
  return Array.from(activeWorkers.values());
}

/**
 * Get workers grouped by batch.
 */
export function getWorkerBatches(): Map<string, WorkerEntry[]> {
  const batches = new Map<string, WorkerEntry[]>();
  for (const worker of activeWorkers.values()) {
    const batch = batches.get(worker.batchId) ?? [];
    batch.push(worker);
    batches.set(worker.batchId, batch);
  }
  return batches;
}

/**
 * Check if any parallel workers are currently running.
 */
export function hasActiveWorkers(): boolean {
  for (const worker of activeWorkers.values()) {
    if (worker.status === "running") return true;
  }
  return false;
}

/**
 * Reset registry state. Used for testing.
 */
export function resetWorkerRegistry(): void {
  activeWorkers.clear();
  workerIdCounter = 0;
}
