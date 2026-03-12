/**
 * State derivation engine for the file-to-state pipeline.
 * Parses all .planning/ files into a typed PlanningState object.
 * Called on startup (full rebuild) and on file change events.
 */
import matter from "gray-matter";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import type {
  PlanningState,
  ProjectState,
  RoadmapState,
  RoadmapPhase,
  PhaseState,
  PhaseStatus,
  PlanState,
  ConfigState,
  RequirementState,
  MustHaves,
  MustHavesArtifact,
  MustHavesKeyLink,
  VerificationState,
  VerificationTruth,
} from "./types";

// -- Default values for missing files --

const DEFAULT_PROJECT_STATE: ProjectState = {
  milestone: "",
  milestone_name: "",
  status: "unknown",
  stopped_at: "",
  last_updated: "",
  last_activity: "",
  branch: "",
  progress: {
    total_phases: 0,
    completed_phases: 0,
    total_plans: 0,
    completed_plans: 0,
    percent: 0,
  },
};

const DEFAULT_CONFIG_STATE: ConfigState = {
  model_profile: "balanced",
  commit_docs: false,
  search_gitignored: false,
  branching_strategy: "none",
  phase_branch_template: "",
  milestone_branch_template: "",
  workflow: {
    research: true,
    plan_check: true,
    verifier: true,
    nyquist_validation: true,
    _auto_chain_active: false,
  },
  parallelization: false,
  brave_search: false,
  mode: "balanced",
  granularity: "fine",
  skip_permissions: true,
  worktree_enabled: false,
};

// -- File reading helpers --

async function readFileText(path: string): Promise<string | null> {
  try {
    return await Bun.file(path).text();
  } catch {
    return null;
  }
}

async function readFileJson(path: string): Promise<any | null> {
  try {
    return await Bun.file(path).json();
  } catch {
    return null;
  }
}

// -- Parsers --

/**
 * Parses ROADMAP.md content into RoadmapState.
 * Extracts phase checkbox list: `- [x] **Phase N: Name** - Description`
 */
export function parseRoadmap(content: string): RoadmapState {
  const phases: RoadmapPhase[] = [];
  const phaseRegex = /^- \[([ x])\] \*\*Phase (\d+): (.+?)\*\* - (.+)$/gm;
  let match;

  while ((match = phaseRegex.exec(content)) !== null) {
    phases.push({
      completed: match[1] === "x",
      number: parseInt(match[2], 10),
      name: match[3],
      description: match[4],
    });
  }

  return { phases };
}

/**
 * Parses REQUIREMENTS.md content into RequirementState array.
 * Extracts checkbox list: `- [x] **ID**: Description`
 */
export function parseRequirements(content: string): RequirementState[] {
  const requirements: RequirementState[] = [];
  const reqRegex = /^- \[([ x])\] \*\*([A-Z]+-\d+)\*\*: (.+)$/gm;
  let match;

  while ((match = reqRegex.exec(content)) !== null) {
    requirements.push({
      id: match[2],
      description: match[3],
      completed: match[1] === "x",
    });
  }

  return requirements;
}

/**
 * Extracts phase number from a phase directory name like "02-file-to-state-pipeline".
 */
function extractPhaseNumber(dirName: string): number {
  const match = dirName.match(/^(\d+)/);
  return match ? parseInt(match[1], 10) : 0;
}

/**
 * Extracts phase name from a phase directory name like "02-file-to-state-pipeline".
 */
function extractPhaseName(dirName: string): string {
  const match = dirName.match(/^\d+-(.+)$/);
  if (!match) return dirName;
  return match[1]
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/**
 * Discovers and parses all PLAN.md files in the phases directory.
 * Groups plans by phase number into PhaseState objects.
 */
async function parseAllPhases(planningDir: string): Promise<PhaseState[]> {
  const phasesDir = join(planningDir, "phases");
  let phaseDirs: string[];

  try {
    phaseDirs = readdirSync(phasesDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }

  const phaseMap = new Map<number, PhaseState>();

  for (const phaseDir of phaseDirs) {
    const phaseNumber = extractPhaseNumber(phaseDir);
    const phaseName = extractPhaseName(phaseDir);
    const fullPhaseDir = join(phasesDir, phaseDir);

    // Find all PLAN.md files in this phase directory
    let planFiles: string[];
    try {
      planFiles = readdirSync(fullPhaseDir)
        .filter((f) => f.endsWith("-PLAN.md"))
        .sort();
    } catch {
      continue;
    }

    const plans: PlanState[] = [];

    for (const planFile of planFiles) {
      const planPath = join(fullPhaseDir, planFile);
      const content = await readFileText(planPath);
      if (!content) continue;

      try {
        const parsed = matter(content);
        const data = parsed.data;
        const body = parsed.content;

        // Parse must_haves if present
        let must_haves: MustHaves | undefined;
        if (data.must_haves && typeof data.must_haves === "object") {
          const mh = data.must_haves;
          must_haves = {
            truths: Array.isArray(mh.truths) ? mh.truths : [],
            artifacts: Array.isArray(mh.artifacts)
              ? mh.artifacts.map((a: any): MustHavesArtifact => ({
                  path: a.path || "",
                  provides: a.provides || "",
                  ...(a.exports ? { exports: a.exports } : {}),
                  ...(a.contains ? { contains: a.contains } : {}),
                  ...(a.min_lines != null ? { min_lines: a.min_lines } : {}),
                }))
              : [],
            key_links: Array.isArray(mh.key_links)
              ? mh.key_links.map((k: any): MustHavesKeyLink => ({
                  from: k.from || "",
                  to: k.to || "",
                  via: k.via || "",
                  ...(k.pattern ? { pattern: k.pattern } : {}),
                }))
              : [],
          };
        }

        // Count <task occurrences in plan body
        const taskMatches = body.match(/<task[\s>]/g);
        const task_count = taskMatches ? taskMatches.length : 0;

        plans.push({
          phase: data.phase || phaseDir,
          plan: typeof data.plan === "number" ? data.plan : parseInt(data.plan, 10) || 0,
          wave: typeof data.wave === "number" ? data.wave : parseInt(data.wave, 10) || 0,
          requirements: Array.isArray(data.requirements) ? data.requirements : [],
          autonomous: data.autonomous === true,
          type: data.type || "execute",
          files_modified: Array.isArray(data.files_modified) ? data.files_modified : [],
          depends_on: Array.isArray(data.depends_on) ? data.depends_on : [],
          must_haves,
          task_count,
        });
      } catch {
        // Skip files that fail to parse
        continue;
      }
    }

    // Determine phase status from plans and summaries
    let summaryCount = 0;
    try {
      summaryCount = readdirSync(fullPhaseDir).filter((f) =>
        f.endsWith("-SUMMARY.md")
      ).length;
    } catch {
      // ignore
    }

    // Parse VERIFICATION.md files
    const verifications: VerificationState[] = [];
    try {
      const verificationFiles = readdirSync(fullPhaseDir)
        .filter((f) => f.endsWith("-VERIFICATION.md"))
        .sort();

      for (const vFile of verificationFiles) {
        const vPath = join(fullPhaseDir, vFile);
        const vContent = await readFileText(vPath);
        if (!vContent) continue;

        try {
          const vParsed = matter(vContent);
          const vData = vParsed.data;
          const vBody = vParsed.content;

          // Parse truth table rows from body
          const truths: VerificationTruth[] = [];
          const truthRegex = /^\|\s*(.+?)\s*\|\s*(pass|fail|skip)\s*\|$/gm;
          let truthMatch;
          while ((truthMatch = truthRegex.exec(vBody)) !== null) {
            const truthText = truthMatch[1].trim();
            // Skip header/separator rows
            if (truthText === "Truth" || truthText.startsWith("---")) continue;
            truths.push({
              truth: truthText,
              status: truthMatch[2].trim() as "pass" | "fail" | "skip",
            });
          }

          verifications.push({
            score: typeof vData.score === "number" ? vData.score : 0,
            status: vData.status || "unknown",
            truths,
          });
        } catch {
          // Skip unparseable verification files
        }
      }
    } catch {
      // ignore
    }

    let status: PhaseStatus = "not_started";
    if (plans.length > 0 && summaryCount >= plans.length) {
      status = "complete";
    } else if (summaryCount > 0) {
      status = "in_progress";
    }

    phaseMap.set(phaseNumber, {
      number: phaseNumber,
      name: phaseName,
      status,
      completedPlans: summaryCount,
      plans,
      verifications,
    });
  }

  // Return phases sorted by number
  return Array.from(phaseMap.values()).sort((a, b) => a.number - b.number);
}

/**
 * Builds the complete PlanningState from .planning/ files.
 * This is the main entry point for state derivation.
 *
 * Handles missing files gracefully by returning default values.
 * Calling this twice on the same files produces identical output (SERV-09).
 */
export async function buildFullState(planningDir: string): Promise<PlanningState> {
  // Read all top-level files concurrently
  const [stateRaw, roadmapRaw, configRaw, requirementsRaw] = await Promise.all([
    readFileText(join(planningDir, "STATE.md")),
    readFileText(join(planningDir, "ROADMAP.md")),
    readFileJson(join(planningDir, "config.json")),
    readFileText(join(planningDir, "REQUIREMENTS.md")),
  ]);

  // Parse STATE.md
  let projectState: ProjectState = { ...DEFAULT_PROJECT_STATE };
  if (stateRaw) {
    try {
      const parsed = matter(stateRaw);
      const data = parsed.data;
      projectState = {
        milestone: data.milestone || "",
        milestone_name: data.milestone_name || "",
        status: data.status || "unknown",
        stopped_at: data.stopped_at || "",
        last_updated: data.last_updated || "",
        last_activity: data.last_activity || "",
        branch: "", // Set by git detection below
        progress: {
          total_phases: data.progress?.total_phases || 0,
          completed_phases: data.progress?.completed_phases || 0,
          total_plans: data.progress?.total_plans || 0,
          completed_plans: data.progress?.completed_plans || 0,
          percent: data.progress?.percent || 0,
        },
      };
    } catch {
      // Use defaults on parse failure
    }
  }

  // Parse ROADMAP.md
  const roadmap: RoadmapState = roadmapRaw
    ? parseRoadmap(roadmapRaw)
    : { phases: [] };

  // Parse config.json
  const config: ConfigState = configRaw
    ? (configRaw as ConfigState)
    : { ...DEFAULT_CONFIG_STATE };

  // Parse REQUIREMENTS.md
  const requirements: RequirementState[] = requirementsRaw
    ? parseRequirements(requirementsRaw)
    : [];

  // Parse all phase/plan files
  const phases = await parseAllPhases(planningDir);

  // Detect git branch
  let branch = "unknown";
  try {
    const proc = Bun.spawn(["git", "rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: planningDir,
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = await new Response(proc.stdout).text();
    branch = output.trim() || "unknown";
  } catch {
    // Keep default "unknown"
  }
  projectState.branch = branch;

  return {
    state: projectState,
    roadmap,
    config,
    phases,
    requirements,
  };
}
