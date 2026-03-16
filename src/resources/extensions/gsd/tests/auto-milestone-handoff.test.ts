import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

import { createAutoWorktree } from "../auto-worktree.ts";
import { completeAutoWorktreeMilestoneCeremony } from "../auto.ts";
import { createTestContext } from "./test-helpers.ts";

const { assertEq, assertTrue, report } = createTestContext();

function run(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8" }).trim();
}

function createTempRepo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "auto-ms-handoff-")));
  run("git init", dir);
  run("git config user.email test@test.com", dir);
  run("git config user.name Test", dir);
  writeFileSync(join(dir, "README.md"), "# test\n");
  mkdirSync(join(dir, ".gsd"), { recursive: true });
  writeFileSync(join(dir, ".gsd", "STATE.md"), "# State\n");
  run("git add .", dir);
  run("git commit -m init", dir);
  run("git branch -M main", dir);
  return dir;
}

async function main(): Promise<void> {
  const savedCwd = process.cwd();
  const tempDirs: string[] = [];

  try {
    console.log("\n=== milestone handoff merges previous worktree before advancing ===");
    const repo = createTempRepo();
    tempDirs.push(repo);

    const m001Dir = join(repo, ".gsd", "milestones", "M001");
    const m002Dir = join(repo, ".gsd", "milestones", "M002");
    mkdirSync(m001Dir, { recursive: true });
    mkdirSync(m002Dir, { recursive: true });

    writeFileSync(join(m001Dir, "M001-ROADMAP.md"), `# M001: First milestone

## Slices
- [ ] **S01: Finish milestone** \`risk:low\` \`depends:[]\`
`);
    writeFileSync(join(m002Dir, "M002-ROADMAP.md"), `# M002: Next milestone

## Slices
- [ ] **S01: Start next milestone** \`risk:low\` \`depends:[]\`
`);
    run("git add .", repo);
    run('git commit -m "add milestone roadmaps"', repo);

    const wtPath = createAutoWorktree(repo, "M001");
    writeFileSync(join(wtPath, "feature.ts"), "export const feature = true;\n");
    writeFileSync(join(wtPath, ".gsd", "milestones", "M001", "M001-ROADMAP.md"), `# M001: First milestone

## Slices
- [x] **S01: Finish milestone** \`risk:low\` \`depends:[]\`
`);
    writeFileSync(join(wtPath, ".gsd", "milestones", "M001", "M001-SUMMARY.md"), "# M001 Summary\n\nDone.\n");

    const result = await completeAutoWorktreeMilestoneCeremony(wtPath, repo, "M001", "M002");

    const expectedNextWorktree = join(repo, ".gsd", "worktrees", "M002");
    assertEq(result.activeBasePath, expectedNextWorktree, "handoff enters the next milestone worktree");
    assertTrue(existsSync(expectedNextWorktree), "next milestone worktree exists");
    assertEq(result.state.activeMilestone?.id, "M002", "re-derived state advances to M002");
    assertTrue(!existsSync(join(repo, ".gsd", "worktrees", "M001")), "completed milestone worktree removed");
    assertTrue(!run("git branch", repo).includes("milestone/M001"), "completed milestone branch deleted");
    assertTrue(existsSync(join(repo, "feature.ts")), "milestone work merged onto main");
    assertTrue(
      existsSync(join(repo, ".gsd", "milestones", "M001", "M001-SUMMARY.md")),
      "milestone summary merged back into main .gsd directory",
    );
    assertTrue(
      readFileSync(join(repo, ".gsd", "milestones", "M001", "M001-ROADMAP.md"), "utf-8").includes("- [x] **S01: Finish milestone**"),
      "main roadmap reflects completed milestone state after merge",
    );
    assertTrue(
      run("git log -1 --format=%B main", repo).includes("- S01: Finish milestone"),
      "merge commit message uses the worktree roadmap content",
    );
    assertEq(process.cwd(), expectedNextWorktree, "ceremony leaves process inside the next milestone worktree");
  } finally {
    process.chdir(savedCwd);
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  report();
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
