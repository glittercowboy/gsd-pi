/**
 * Regression tests for the headless vs interactive milestone-bootstrap divergence.
 *
 * Two defects were covered here:
 *   1. `showHeadlessMilestoneCreation` dispatched with `unitType: "plan-milestone"`
 *      instead of `"discuss-milestone"`. The `discuss-` prefix drives tool
 *      scoping (`guided-flow.ts:583`) and enables the `checkAutoStartAfterDiscuss`
 *      guardrails — routing through `plan-milestone` bypassed them even
 *      though headless is semantically a discuss flow.
 *   2. The `discuss-headless.md` ready-phrase pre-condition was a prose
 *      sentence, so models that treated it as advisory could skip ahead to
 *      the ready phrase without actually writing the artifacts. The checkbox
 *      format from `discuss.md` has lower abstraction cost and is harder to
 *      rationalize past.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const GUIDED_FLOW_PATH = join(__dirname, "..", "guided-flow.ts");
const DISCUSS_HEADLESS_PATH = join(__dirname, "..", "prompts", "discuss-headless.md");

function getGuidedFlowSource(): string {
  return readFileSync(GUIDED_FLOW_PATH, "utf-8");
}

function getHeadlessPromptSource(): string {
  return readFileSync(DISCUSS_HEADLESS_PATH, "utf-8");
}

describe("headless milestone bootstrap — parity with interactive flow", () => {
  test("showHeadlessMilestoneCreation dispatches as discuss-milestone, not plan-milestone", () => {
    const source = getGuidedFlowSource();
    const fnStart = source.indexOf("export async function showHeadlessMilestoneCreation");
    assert.ok(fnStart > -1, "showHeadlessMilestoneCreation must exist");

    // Scope: from the function start to the next top-level export (or EOF).
    const nextExport = source.indexOf("\nexport ", fnStart + 1);
    const fnBody = source.slice(fnStart, nextExport === -1 ? source.length : nextExport);

    // Match only the actual dispatchWorkflow call — comments in the body
    // may mention "plan-milestone" as part of the fix rationale.
    const dispatchMatches = [...fnBody.matchAll(/dispatchWorkflow\([^)]*,\s*"([^"]+)"\s*\)/g)];
    assert.strictEqual(
      dispatchMatches.length,
      1,
      `expected exactly one dispatchWorkflow call, found ${dispatchMatches.length}`,
    );
    assert.strictEqual(
      dispatchMatches[0][1],
      "discuss-milestone",
      `showHeadlessMilestoneCreation must dispatch as "discuss-milestone" so tool scoping and discuss-flow guardrails apply; got "${dispatchMatches[0][1]}"`,
    );
  });

  test("discuss-headless single-milestone pre-condition uses the non-bypassable checkbox format", () => {
    const source = getHeadlessPromptSource();
    const section = source.split("### Multi-Milestone")[0];
    assert.ok(
      /### Ready-phrase pre-condition \(NON-BYPASSABLE\)/.test(section),
      "single-milestone ready-phrase section must be present",
    );
    // All four required artifacts must appear as checkboxes, not a prose list.
    for (const artifact of [
      "`.gsd/PROJECT.md`",
      "`.gsd/REQUIREMENTS.md`",
      "`{{contextPath}}`",
      "`gsd_plan_milestone`",
    ]) {
      assert.ok(
        new RegExp(`- \\[ \\] [A-Za-z]+ ${artifact.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(section),
        `single-milestone pre-condition must include a checkbox for ${artifact}`,
      );
    }
    assert.ok(
      /If ANY box is unchecked, \*\*STOP\*\*/.test(section),
      "single-milestone pre-condition must include the 'If ANY box is unchecked, STOP' sentinel",
    );
    assert.ok(
      /Do not announce the ready phrase as something you are "about to" do/.test(section),
      "single-milestone pre-condition must include the 'do not announce intent' guard",
    );
  });

  test("discuss-headless multi-milestone pre-condition uses the non-bypassable checkbox format", () => {
    const source = getHeadlessPromptSource();
    const multiIdx = source.indexOf("### Multi-Milestone");
    assert.ok(multiIdx > -1, "multi-milestone section must be present");
    const multiSection = source.slice(multiIdx);

    assert.ok(
      /### Ready-phrase pre-condition \(NON-BYPASSABLE\)/.test(multiSection),
      "multi-milestone ready-phrase section must be present",
    );
    for (const artifact of [
      "`.gsd/PROJECT.md`",
      "`.gsd/REQUIREMENTS.md`",
      "`gsd_plan_milestone`",
      "`.gsd/DISCUSSION-MANIFEST.json`",
    ]) {
      const escaped = artifact.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      assert.ok(
        new RegExp(`- \\[ \\] [\\s\\S]*?${escaped}`).test(multiSection),
        `multi-milestone pre-condition must include a checkbox referencing ${artifact}`,
      );
    }
    assert.ok(
      /gates_completed === total/.test(multiSection),
      "multi-milestone pre-condition must still enforce gates_completed === total",
    );
  });
});
