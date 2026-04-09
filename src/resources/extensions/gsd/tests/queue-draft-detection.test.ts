import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { deriveState } from "../state.js";
import { buildExistingMilestonesContext } from "../guided-flow.js";

describe('queue-draft-detection', () => {
  test('draft and context milestone detection', async () => {
    const tmpBase = mkdtempSync(join(tmpdir(), "gsd-queue-draft-test-"));
    const gsd = join(tmpBase, ".gsd");

    try {
      // M001: has only CONTEXT-DRAFT.md (draft milestone)
      mkdirSync(join(gsd, "milestones", "M001"), { recursive: true });
      writeFileSync(
        join(gsd, "milestones", "M001", "M001-CONTEXT-DRAFT.md"),
        "# M001: Draft Milestone\n\nSeed material from prior discussion.\n",
      );

      // M002: has full CONTEXT.md (ready milestone)
      mkdirSync(join(gsd, "milestones", "M002"), { recursive: true });
      writeFileSync(
        join(gsd, "milestones", "M002", "M002-CONTEXT.md"),
        "# M002: Ready Milestone\n\nFull context from deep discussion.\n",
      );

      // M003: has both CONTEXT.md and CONTEXT-DRAFT.md (CONTEXT wins)
      mkdirSync(join(gsd, "milestones", "M003"), { recursive: true });
      writeFileSync(
        join(gsd, "milestones", "M003", "M003-CONTEXT.md"),
        "# M003: Full Context\n\nThis is the real context.\n",
      );
      writeFileSync(
        join(gsd, "milestones", "M003", "M003-CONTEXT-DRAFT.md"),
        "# M003: Draft\n\nThis should be ignored.\n",
      );

      // M004: has neither (empty milestone dir)
      mkdirSync(join(gsd, "milestones", "M004"), { recursive: true });

      // Build context
      const state = await deriveState(tmpBase);
      const milestoneIds = ["M001", "M002", "M003", "M004"];
      const context = await buildExistingMilestonesContext(tmpBase, milestoneIds, state);

      // draft-only milestone includes "Draft context available"
      assert.ok(
        context.includes("Draft context available"),
        "M001 (draft-only) should include 'Draft context available' label",
      );
      assert.ok(
        context.includes("Seed material from prior discussion"),
        "M001 draft content should be included in context output",
      );

      // full-context milestone uses "Context:" label
      assert.ok(
        context.includes("**Context:**"),
        "M002 (full context) should use 'Context:' label",
      );
      assert.ok(
        context.includes("Full context from deep discussion"),
        "M002 context content should be included",
      );

      // both files: CONTEXT.md wins, no draft label
      const m003Idx = context.indexOf("M003:");
      const m003Section = context.slice(m003Idx, m003Idx + 500);
      assert.ok(
        m003Section.includes("**Context:**"),
        "M003 (both files) should use 'Context:' label (CONTEXT.md wins)",
      );
      assert.ok(
        !m003Section.includes("Draft context available"),
        "M003 (both files) should NOT show draft label — CONTEXT.md takes precedence",
      );
      assert.ok(
        m003Section.includes("This is the real context"),
        "M003 should show CONTEXT.md content, not draft content",
      );

      // neither file: no context section
      const m004Idx = context.indexOf("M004:");
      const m004Section = context.slice(m004Idx, m004Idx + 500);
      assert.ok(
        !m004Section.includes("**Context:**"),
        "M004 (neither file) should not have Context: label",
      );
      assert.ok(
        !m004Section.includes("Draft context available"),
        "M004 (neither file) should not have Draft label",
      );
    } finally {
      rmSync(tmpBase, { recursive: true, force: true });
    }
  });
});
