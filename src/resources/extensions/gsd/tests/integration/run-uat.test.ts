import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { extractUatType } from '../files.ts';
import { resolveSliceFile } from '../paths.ts';
import { checkNeedsRunUat } from '../auto-prompts.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const worktreePromptsDir = join(__dirname, '..', 'prompts');

function loadPromptFromWorktree(name: string, vars: Record<string, string> = {}): string {
  const path = join(worktreePromptsDir, `${name}.md`);
  let content = readFileSync(path, 'utf-8');
  const effectiveVars = {
    skillActivation: 'If no installed skill clearly matches this unit, skip explicit skill activation and continue with the required workflow.',
    ...vars,
  };
  for (const [key, value] of Object.entries(effectiveVars)) {
    content = content.replaceAll(`{{${key}}}`, value);
  }
  return content.trim();
}

function createFixtureBase(): string {
  const base = mkdtempSync(join(tmpdir(), 'gsd-run-uat-test-'));
  mkdirSync(join(base, '.gsd', 'milestones'), { recursive: true });
  return base;
}

function writeSliceFile(
  base: string,
  mid: string,
  sid: string,
  suffix: string,
  content: string,
): void {
  const dir = join(base, '.gsd', 'milestones', mid, 'slices', sid);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sid}-${suffix}.md`), content);
}

function cleanup(base: string): void {
  rmSync(base, { recursive: true, force: true });
}

function makeUatContent(mode: string): string {
  return `# UAT File\n\n## UAT Type\n\n- UAT mode: ${mode}\n- Some other bullet: value\n`;
}

describe('run-uat', () => {
test('(a) artifact-driven', () => {
  assert.deepStrictEqual(
    extractUatType(makeUatContent('artifact-driven')),
    'artifact-driven',
    'plain artifact-driven → artifact-driven',
  );
  assert.deepStrictEqual(
    extractUatType('## UAT Type\n\n- UAT mode: artifact-driven\n'),
    'artifact-driven',
    'minimal content, artifact-driven',
  );
});

test('(b) live-runtime', () => {
  assert.deepStrictEqual(
    extractUatType(makeUatContent('live-runtime')),
    'live-runtime',
    'plain live-runtime → live-runtime',
  );
});

test('(c) human-experience', () => {
  assert.deepStrictEqual(
    extractUatType(makeUatContent('human-experience')),
    'human-experience',
    'plain human-experience → human-experience',
  );
});

test('(d) mixed standalone', () => {
  assert.deepStrictEqual(
    extractUatType(makeUatContent('mixed')),
    'mixed',
    'plain mixed → mixed',
  );
});

test('(e) mixed parenthetical', () => {
  assert.deepStrictEqual(
    extractUatType(makeUatContent('mixed (artifact-driven + live-runtime)')),
    'mixed',
    'mixed (artifact-driven + live-runtime) → mixed (leading keyword only)',
  );
  assert.deepStrictEqual(
    extractUatType(makeUatContent('mixed (some other description)')),
    'mixed',
    'mixed with arbitrary parenthetical → mixed',
  );
});

test('(f) missing UAT Type section', () => {
  assert.deepStrictEqual(
    extractUatType('# UAT File\n\n## Overview\n\nSome content.\n'),
    undefined,
    'no ## UAT Type section → undefined',
  );
  assert.deepStrictEqual(
    extractUatType(''),
    undefined,
    'empty content → undefined',
  );
});

test('(g) UAT Type section present, no UAT mode: bullet', () => {
  assert.deepStrictEqual(
    extractUatType('## UAT Type\n\n- Some other bullet: value\n- Another bullet\n'),
    undefined,
    'section present but no UAT mode: bullet → undefined',
  );
  assert.deepStrictEqual(
    extractUatType('## UAT Type\n\n'),
    undefined,
    'section present but empty → undefined',
  );
});

test('(h) unknown keyword', () => {
  assert.deepStrictEqual(
    extractUatType(makeUatContent('automated')),
    undefined,
    'unknown keyword automated → undefined',
  );
  assert.deepStrictEqual(
    extractUatType(makeUatContent('fully-automated')),
    undefined,
    'unknown keyword fully-automated → undefined',
  );
});

test('(i) extra whitespace', () => {
  assert.deepStrictEqual(
    extractUatType('## UAT Type\n\n- UAT mode:   artifact-driven   \n'),
    'artifact-driven',
    'leading/trailing whitespace around value → still classified correctly',
  );
  assert.deepStrictEqual(
    extractUatType('## UAT Type\n\n- UAT mode:  mixed (artifact-driven + live-runtime)  \n'),
    'mixed',
    'whitespace around mixed parenthetical → mixed',
  );
});

test('(j) case sensitivity', () => {
  assert.deepStrictEqual(
    extractUatType(makeUatContent('Artifact-Driven')),
    'artifact-driven',
    'Artifact-Driven (title case) → artifact-driven (function lowercases before matching)',
  );
  assert.deepStrictEqual(
    extractUatType(makeUatContent('MIXED')),
    'mixed',
    'MIXED (upper case) → mixed (function lowercases before matching)',
  );
});

test('(k) run-uat prompt template', () => {
  const milestoneId = 'M001';
  const sliceId = 'S01';
  const uatPath = '.gsd/milestones/M001/slices/S01/S01-UAT.md';
  const uatResultPath = '.gsd/milestones/M001/slices/S01/S01-UAT.md';
  const uatType = 'live-runtime';
  const inlinedContext = '<!-- no context -->';
  let promptResult: string | undefined;
  let promptThrew = false;
  try {
    promptResult = loadPromptFromWorktree('run-uat', {
      workingDirectory: '/tmp/test-project',
      milestoneId,
      sliceId,
      uatPath,
      uatResultPath,
      uatType,
      inlinedContext,
    });
  } catch {
    promptThrew = true;
  }
  assert.ok(!promptThrew, 'loadPromptFromWorktree("run-uat", vars) does not throw');
  assert.ok(
    typeof promptResult === 'string' && promptResult.length > 0,
    'run-uat prompt result is a non-empty string',
  );
  assert.ok(
    promptResult?.includes(milestoneId) ?? false,
    `prompt contains milestoneId value "${milestoneId}" after substitution`,
  );
  assert.ok(
    promptResult?.includes(sliceId) ?? false,
    `prompt contains sliceId value "${sliceId}" after substitution`,
  );
  assert.ok(
    promptResult?.includes(uatResultPath) ?? false,
    `prompt contains uatResultPath value after substitution`,
  );
  assert.ok(
    promptResult?.includes(`Detected UAT mode:** \`${uatType}\``) ?? false,
    `prompt contains detected dynamic uatType value "${uatType}" after substitution`,
  );
  assert.ok(
    promptResult?.includes(`uatType: ${uatType}`) ?? false,
    `prompt contains dynamic uatType frontmatter value "${uatType}" after substitution`,
  );
  assert.ok(
    !/\{\{[^}]+\}\}/.test(promptResult ?? ''),
    'no unreplaced {{...}} tokens remain after variable substitution',
  );
  assert.ok(
    /browser|runtime|execute|run/i.test(promptResult ?? ''),
    'prompt contains runtime execution language (browser/runtime/execute/run)',
  );
  assert.ok(
    !/surfaced for human review/i.test(promptResult ?? ''),
    'prompt does not contain "surfaced for human review" (non-artifact UATs are skipped, not dispatched)',
  );
});

test('(k2) run-uat prompt references gsd_summary_save, not direct write', () => {
  const promptResult = loadPromptFromWorktree('run-uat', {
    workingDirectory: '/tmp/test-project',
    milestoneId: 'M001',
    sliceId: 'S01',
    uatPath: '.gsd/milestones/M001/slices/S01/S01-UAT.md',
    uatResultPath: '.gsd/milestones/M001/slices/S01/S01-UAT.md',
    uatType: 'artifact-driven',
    inlinedContext: '<!-- no context -->',
  });

  assert.ok(
    promptResult.includes('gsd_summary_save'),
    'run-uat prompt should reference gsd_summary_save tool',
  );
  assert.ok(
    promptResult.includes('artifact_type: "ASSESSMENT"'),
    'run-uat prompt should specify ASSESSMENT artifact type',
  );
  assert.ok(
    !promptResult.includes('MUST write'),
    'run-uat prompt should not instruct direct file write in footer',
  );
});

test('(l) dispatch preconditions via resolveSliceFile', () => {
    const base = createFixtureBase();
    const uatContent = makeUatContent('artifact-driven');
    try {
      writeSliceFile(base, 'M001', 'S01', 'UAT', uatContent);

      const uatFilePath = resolveSliceFile(base, 'M001', 'S01', 'UAT');
      assert.ok(
        uatFilePath !== null,
        'resolveSliceFile(..., "UAT") returns non-null when UAT file exists (dispatch trigger state)',
      );

      // UAT spec without a verdict line means UAT has not been run yet
      const rawContent = readFileSync(uatFilePath!, 'utf-8');
      assert.ok(
        !/verdict:\s*[\w-]+/i.test(rawContent),
        'UAT file without verdict indicates UAT has not been run (dispatch trigger state)',
      );

      assert.deepStrictEqual(
        extractUatType(rawContent),
        'artifact-driven',
        'extractUatType on fixture UAT file returns expected type (end-to-end data flow)',
      );
    } finally {
      cleanup(base);
    }
});

test('test block at line 307', () => {
    const base = createFixtureBase();
    try {
      // Write UAT file with a verdict — simulates completed UAT
      writeSliceFile(base, 'M001', 'S01', 'UAT', '# UAT Result\n\nverdict: PASS\n');

      const uatFilePath = resolveSliceFile(base, 'M001', 'S01', 'UAT');
      assert.ok(
        uatFilePath !== null,
        'resolveSliceFile(..., "UAT") returns non-null when UAT file exists',
      );
      const content = readFileSync(uatFilePath!, 'utf-8');
      assert.ok(
        /verdict:\s*[\w-]+/i.test(content),
        'UAT file with verdict indicates UAT has been completed (idempotent skip state)',
      );
    } finally {
      cleanup(base);
    }
});

test('(m) non-artifact UAT skip', async () => {
    const base = createFixtureBase();
    try {
      const roadmapDir = join(base, '.gsd', 'milestones', 'M001');
      mkdirSync(roadmapDir, { recursive: true });
      writeFileSync(
        join(roadmapDir, 'M001-ROADMAP.md'),
        [
          '# M001: Test roadmap',
          '',
          '## Slices',
          '',
          '- [x] **S01: First slice** `risk:low` `depends:[]`',
          '- [ ] **S02: Next slice** `risk:low` `depends:[S01]`',
          '',
          '## Boundary Map',
          '',
        ].join('\n'),
      );

      writeSliceFile(base, 'M001', 'S01', 'UAT', makeUatContent('human-experience'));

      const state = {
        activeMilestone: { id: 'M001', title: 'Test roadmap' },
        activeSlice: { id: 'S02', title: 'Next slice' },
        activeTask: null,
        phase: 'planning',
        recentDecisions: [],
        blockers: [],
        nextAction: 'Plan S02',
        registry: [],
      } as const;

      const result = await checkNeedsRunUat(base, 'M001', state as any, { uat_dispatch: true } as any);
      assert.deepStrictEqual(
        result,
        { sliceId: 'S01', uatType: 'human-experience' },
        'human-experience UAT dispatches so auto-mode can pause for manual review',
      );
    } finally {
      cleanup(base);
    }
});

test('(o) verdict gate: PARTIAL is acceptable for mixed/human-experience/live-runtime UAT types', () => {
    // This test verifies the contract that extractUatType correctly identifies
    // the modes where PARTIAL should not block progression.
    // The verdict gate in auto-dispatch.ts uses this to build acceptableVerdicts.
    const mixedType = extractUatType(makeUatContent('mixed'));
    const humanExpType = extractUatType(makeUatContent('human-experience'));
    const liveRuntimeType = extractUatType(makeUatContent('live-runtime'));
    const artifactType = extractUatType(makeUatContent('artifact-driven'));
    const browserType = extractUatType(makeUatContent('browser-executable'));
    const runtimeExecType = extractUatType(makeUatContent('runtime-executable'));

    // These modes should allow PARTIAL (non-fully-automatable)
    const partialAcceptableModes = ['mixed', 'human-experience', 'live-runtime'];
    assert.ok(
      partialAcceptableModes.includes(mixedType!),
      `mixed → "${mixedType}" is in partialAcceptableModes`,
    );
    assert.ok(
      partialAcceptableModes.includes(humanExpType!),
      `human-experience → "${humanExpType}" is in partialAcceptableModes`,
    );
    assert.ok(
      partialAcceptableModes.includes(liveRuntimeType!),
      `live-runtime → "${liveRuntimeType}" is in partialAcceptableModes`,
    );

    // These modes should NOT allow PARTIAL (fully automatable)
    assert.ok(
      !partialAcceptableModes.includes(artifactType!),
      `artifact-driven → "${artifactType}" is NOT in partialAcceptableModes`,
    );
    assert.ok(
      !partialAcceptableModes.includes(browserType!),
      `browser-executable → "${browserType}" is NOT in partialAcceptableModes`,
    );
    assert.ok(
      !partialAcceptableModes.includes(runtimeExecType!),
      `runtime-executable → "${runtimeExecType}" is NOT in partialAcceptableModes`,
    );
});

test('(p) run-uat prompt allows PASS when human-only checks remain as NEEDS-HUMAN', () => {
    const promptResult = loadPromptFromWorktree('run-uat', {
      workingDirectory: '/tmp/test-project',
      milestoneId: 'M001',
      sliceId: 'S01',
      uatPath: '.gsd/milestones/M001/slices/S01/S01-UAT.md',
      uatResultPath: '.gsd/milestones/M001/slices/S01/S01-UAT.md',
      uatType: 'mixed',
      inlinedContext: '<!-- no context -->',
    });

    // PASS verdict should be usable when automatable checks pass (even with NEEDS-HUMAN remaining)
    assert.ok(
      /PASS.*automatable checks passed/i.test(promptResult),
      'prompt defines PASS as valid when all automatable checks passed',
    );
    assert.ok(
      /PARTIAL.*automatable checks.*(skipped|inconclusive)/i.test(promptResult),
      'prompt reserves PARTIAL for when automatable checks themselves are inconclusive',
    );
    // human-experience mode should NOT force PARTIAL when automatable checks pass
    assert.ok(
      !promptResult.includes('use an overall verdict of `PARTIAL`'),
      'prompt does not force PARTIAL verdict for human-experience mode',
    );
});

test('(n) stale replay guard', async () => {
    const base = createFixtureBase();
    try {
      const roadmapDir = join(base, '.gsd', 'milestones', 'M001');
      mkdirSync(roadmapDir, { recursive: true });
      writeFileSync(
        join(roadmapDir, 'M001-ROADMAP.md'),
        [
          '# M001: Test roadmap',
          '',
          '## Slices',
          '',
          '- [x] **S01: First slice** `risk:low` `depends:[]`',
          '- [ ] **S02: Next slice** `risk:low` `depends:[S01]`',
          '',
          '## Boundary Map',
          '',
        ].join('\n'),
      );

      writeSliceFile(base, 'M001', 'S01', 'UAT', makeUatContent('artifact-driven'));
      writeSliceFile(base, 'M001', 'S01', 'UAT', '---\nverdict: FAIL\n---\n');

      const state = {
        activeMilestone: { id: 'M001', title: 'Test roadmap' },
        activeSlice: { id: 'S02', title: 'Next slice' },
        activeTask: null,
        phase: 'planning',
        recentDecisions: [],
        blockers: [],
        nextAction: 'Plan S02',
        registry: [],
      } as const;

      const result = await checkNeedsRunUat(base, 'M001', state as any, { uat_dispatch: true } as any);
      assert.deepStrictEqual(
        result,
        null,
        'existing UAT with FAIL verdict does not re-dispatch; verdict gate owns blocking',
      );
    } finally {
      cleanup(base);
    }
});

test('(q) verdict in ASSESSMENT file skips UAT dispatch (file-based path)', async () => {
    // Regression test for #2644: run-uat prompt writes the verdict to
    // S{sid}-ASSESSMENT.md (via gsd_summary_save artifact_type:"ASSESSMENT"),
    // but checkNeedsRunUat only checked S{sid}-UAT.md — causing a stuck loop.
    const base = createFixtureBase();
    try {
      const roadmapDir = join(base, '.gsd', 'milestones', 'M001');
      mkdirSync(roadmapDir, { recursive: true });
      writeFileSync(
        join(roadmapDir, 'M001-ROADMAP.md'),
        [
          '# M001: Test roadmap',
          '',
          '## Slices',
          '',
          '- [x] **S01: First slice** `risk:low` `depends:[]`',
          '- [ ] **S02: Next slice** `risk:low` `depends:[S01]`',
          '',
          '## Boundary Map',
          '',
        ].join('\n'),
      );

      // UAT spec file WITHOUT a verdict (the spec never gets one)
      writeSliceFile(base, 'M001', 'S01', 'UAT', makeUatContent('artifact-driven'));
      // ASSESSMENT file WITH a verdict (where run-uat actually writes it)
      writeSliceFile(base, 'M001', 'S01', 'ASSESSMENT', '---\nverdict: PASS\n---\n# UAT Assessment\n');

      const state = {
        activeMilestone: { id: 'M001', title: 'Test roadmap' },
        activeSlice: { id: 'S02', title: 'Next slice' },
        activeTask: null,
        phase: 'planning',
        recentDecisions: [],
        blockers: [],
        nextAction: 'Plan S02',
        registry: [],
      } as const;

      const result = await checkNeedsRunUat(base, 'M001', state as any, { uat_dispatch: true } as any);
      assert.deepStrictEqual(
        result,
        null,
        'verdict in ASSESSMENT file should prevent re-dispatch of run-uat',
      );
    } finally {
      cleanup(base);
    }
});

test('(r) no ASSESSMENT file still dispatches UAT (no false skip)', async () => {
    // Guard: when there is no ASSESSMENT file at all, UAT should still dispatch
    // normally. The ASSESSMENT check must not cause a false-negative skip.
    const base = createFixtureBase();
    try {
      const roadmapDir = join(base, '.gsd', 'milestones', 'M001');
      mkdirSync(roadmapDir, { recursive: true });
      writeFileSync(
        join(roadmapDir, 'M001-ROADMAP.md'),
        [
          '# M001: Test roadmap',
          '',
          '## Slices',
          '',
          '- [x] **S01: First slice** `risk:low` `depends:[]`',
          '- [ ] **S02: Next slice** `risk:low` `depends:[S01]`',
          '',
          '## Boundary Map',
          '',
        ].join('\n'),
      );

      // UAT spec file WITHOUT a verdict, and NO ASSESSMENT file
      writeSliceFile(base, 'M001', 'S01', 'UAT', makeUatContent('artifact-driven'));

      const state = {
        activeMilestone: { id: 'M001', title: 'Test roadmap' },
        activeSlice: { id: 'S02', title: 'Next slice' },
        activeTask: null,
        phase: 'planning',
        recentDecisions: [],
        blockers: [],
        nextAction: 'Plan S02',
        registry: [],
      } as const;

      const result = await checkNeedsRunUat(base, 'M001', state as any, { uat_dispatch: true } as any);
      assert.deepStrictEqual(
        result,
        { sliceId: 'S01', uatType: 'artifact-driven' },
        'without ASSESSMENT file, UAT still dispatches normally',
      );
    } finally {
      cleanup(base);
    }
});

test('(s) ASSESSMENT without verdict does not skip UAT dispatch', async () => {
    // Guard: an ASSESSMENT file that exists but has no verdict line should
    // NOT suppress UAT dispatch — only a file with an actual verdict should.
    const base = createFixtureBase();
    try {
      const roadmapDir = join(base, '.gsd', 'milestones', 'M001');
      mkdirSync(roadmapDir, { recursive: true });
      writeFileSync(
        join(roadmapDir, 'M001-ROADMAP.md'),
        [
          '# M001: Test roadmap',
          '',
          '## Slices',
          '',
          '- [x] **S01: First slice** `risk:low` `depends:[]`',
          '- [ ] **S02: Next slice** `risk:low` `depends:[S01]`',
          '',
          '## Boundary Map',
          '',
        ].join('\n'),
      );

      // UAT spec WITHOUT verdict
      writeSliceFile(base, 'M001', 'S01', 'UAT', makeUatContent('artifact-driven'));
      // ASSESSMENT file WITHOUT verdict (partial/incomplete assessment)
      writeSliceFile(base, 'M001', 'S01', 'ASSESSMENT', '# UAT Assessment\n\nStill running checks...\n');

      const state = {
        activeMilestone: { id: 'M001', title: 'Test roadmap' },
        activeSlice: { id: 'S02', title: 'Next slice' },
        activeTask: null,
        phase: 'planning',
        recentDecisions: [],
        blockers: [],
        nextAction: 'Plan S02',
        registry: [],
      } as const;

      const result = await checkNeedsRunUat(base, 'M001', state as any, { uat_dispatch: true } as any);
      assert.deepStrictEqual(
        result,
        { sliceId: 'S01', uatType: 'artifact-driven' },
        'ASSESSMENT without verdict should not suppress UAT dispatch',
      );
    } finally {
      cleanup(base);
    }
});

});
