/**
 * GSD File API — reads .gsd/ files inline for the Milestone view.
 *
 * GET /api/gsd-file?sliceId=S01&type=plan|task|diff|uat_results
 *
 * Returns { content: string } — always 200 (missing file returns "(file not found)").
 * Returns 400 for missing/invalid params.
 */
import { join } from "node:path";
import { spawn as nodeSpawn } from "node:child_process";

const VALID_TYPES = ["plan", "task", "diff", "uat_results"] as const;
type GsdFileType = (typeof VALID_TYPES)[number];

/**
 * Read a text file safely — returns "(file not found)" if the file doesn't exist
 * or any read error occurs.
 */
async function readFileSafe(path: string): Promise<string> {
  try {
    return await Bun.file(path).text();
  } catch {
    return "(file not found)";
  }
}

/**
 * Spawn a process and capture stdout as a string.
 * Resolves with stdout string; rejects on non-zero exit.
 */
function spawnCapture(cmd: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = nodeSpawn(cmd, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

    proc.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`Process exited with code ${code}: ${stderr}`));
      }
    });

    proc.on("error", reject);
  });
}

/**
 * Derive a taskId from a sliceId.
 * Best-effort: read S{NN}-PLAN.md and find the first T{NN} entry.
 * Falls back to replacing the "S" prefix with "T" (e.g. S01 → T01).
 */
async function resolveTaskId(
  gsdDir: string,
  sliceId: string,
  explicitTaskId?: string
): Promise<string> {
  if (explicitTaskId) return explicitTaskId;

  // Attempt to read the slice plan and find the first task reference
  try {
    const planContent = await Bun.file(join(gsdDir, `${sliceId}-PLAN.md`)).text();
    const match = planContent.match(/\b(T\d+)\b/);
    if (match) return match[1];
  } catch {
    // Ignore — use fallback
  }

  // Fallback: S01 → T01
  return sliceId.replace(/^S/, "T");
}

/**
 * Get the diff content for the last commit on the current branch.
 * Returns git show --stat output or a "(no commits on this branch)" placeholder.
 */
async function getDiffContent(repoRoot: string): Promise<string> {
  try {
    const hash = (await spawnCapture("git", ["log", "-1", "--format=%H", "--", "."], repoRoot)).trim();
    if (!hash) return "(no commits on this branch)";
    const stat = await spawnCapture("git", ["show", "--stat", hash], repoRoot);
    return stat || "(no commits on this branch)";
  } catch {
    return "(no commits on this branch)";
  }
}

/**
 * HTTP request handler for GET /api/gsd-file.
 * Returns Response or null if route not matched.
 */
export async function handleGsdFileRequest(
  req: Request,
  url: URL,
  gsdDir: string,
  repoRoot: string
): Promise<Response | null> {
  if (url.pathname !== "/api/gsd-file" || req.method !== "GET") {
    return null;
  }

  const sliceId = url.searchParams.get("sliceId");
  if (!sliceId) {
    return Response.json({ error: "sliceId query param is required" }, { status: 400 });
  }

  const typeParam = url.searchParams.get("type");
  if (!typeParam || !(VALID_TYPES as readonly string[]).includes(typeParam)) {
    return Response.json(
      { error: `type must be one of: plan, task, diff, uat_results` },
      { status: 400 }
    );
  }

  const type = typeParam as GsdFileType;

  let content: string;

  switch (type) {
    case "plan": {
      const filePath = join(gsdDir, `${sliceId}-PLAN.md`);
      content = await readFileSafe(filePath);
      break;
    }
    case "task": {
      const taskId = await resolveTaskId(
        gsdDir,
        sliceId,
        url.searchParams.get("taskId") ?? undefined
      );
      const filePath = join(gsdDir, `${taskId}-SUMMARY.md`);
      content = await readFileSafe(filePath);
      break;
    }
    case "uat_results": {
      const filePath = join(gsdDir, `${sliceId}-UAT-RESULTS.md`);
      content = await readFileSafe(filePath);
      break;
    }
    case "diff": {
      content = await getDiffContent(repoRoot);
      break;
    }
  }

  return Response.json({ content });
}
