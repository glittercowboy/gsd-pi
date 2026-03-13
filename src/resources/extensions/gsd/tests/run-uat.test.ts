// Tests for extractUatType — the core UAT classification primitive — plus
// prompt template loading and dispatch precondition assertions (via
// resolveSliceFile / extractUatType on real fixture files).
//
// Sections:
//   (a)–(j)  extractUatType classification (17 assertions from T01)
//   (k)      run-uat prompt template loading and content integrity (8 assertions)
//   (l)      dispatch precondition assertions via resolveSliceFile (4 assertions)

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { extractUatType } from '../files.ts';
import { resolveSliceFile } from '../paths.ts';

// ─── Worktree-aware prompt loader ──────────────────────────────────────────
// Resolves prompts relative to this test file so the worktree copy is used
// instead of the main checkout copy (matches complete-milestone.test.ts pattern).

const __dirname = dirname(fileURLToPath(import.meta.url));
const worktreePromptsDir = join(__dirname, '..', 'prompts');

function loadPromptFromWorktree(name: string, vars: Record<string, string> = {}): string {
  const path = join(worktreePromptsDir, `${name}.md`);
  let content = readFileSync(path, 'utf-8');
  for (const [key, value] of Object.entries(vars)) {
    content = content.replaceAll(`{{${key}}}`, value);
  }
  return content.trim();
}

// ─── Assertion helpers ─────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    passed++;
  } else {
    failed++;
    console.error(`  FAIL: ${message}`);
  }
}

function assertEq<T>(actual: T, expected: T, message: string): void {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    passed++;
  } else {
    failed++;
    console.error(`  FAIL: ${message} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// ─── Fixture helpers ───────────────────────────────────────────────────────

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

// ═══════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════

async function main(): Promise<void> {

  // ─── (a) artifact-driven ──────────────────────────────────────────────────
  console.log('\n── (a) artifact-driven');

  assertEq(
    extractUatType(makeUatContent('artifact-driven')),
    'artifact-driven',
    'plain artifact-driven → artifact-driven',
  );

  assertEq(
    extractUatType('## UAT Type\n\n- UAT mode: artifact-driven\n'),
    'artifact-driven',
    'minimal content, artifact-driven',
  );

  // ─── (b) live-runtime ─────────────────────────────────────────────────────
  console.log('\n── (b) live-runtime');

  assertEq(
    extractUatType(makeUatContent('live-runtime')),
    'live-runtime',
    'plain live-runtime → live-runtime',
  );

  // ─── (c) human-experience ─────────────────────────────────────────────────
  console.log('\n── (c) human-experience');

  assertEq(
    extractUatType(makeUatContent('human-experience')),
    'human-experience',
    'plain human-experience → human-experience',
  );

  // ─── (d) mixed standalone ─────────────────────────────────────────────────
  console.log('\n── (d) mixed standalone');

  assertEq(
    extractUatType(makeUatContent('mixed')),
    'mixed',
    'plain mixed → mixed',
  );

  // ─── (e) mixed with parenthetical ─────────────────────────────────────────
  console.log('\n── (e) mixed parenthetical');

  assertEq(
    extractUatType(makeUatContent('mixed (artifact-driven + live-runtime)')),
    'mixed',
    'mixed (artifact-driven + live-runtime) → mixed (leading keyword only)',
  );

  assertEq(
    extractUatType(makeUatContent('mixed (some other description)')),
    'mixed',
    'mixed with arbitrary parenthetical → mixed',
  );

  // ─── (f) missing ## UAT Type section ──────────────────────────────────────
  console.log('\n── (f) missing UAT Type section');

  assertEq(
    extractUatType('# UAT File\n\n## Overview\n\nSome content.\n'),
    undefined,
    'no ## UAT Type section → undefined',
  );

  assertEq(
    extractUatType(''),
    undefined,
    'empty content → undefined',
  );

  // ─── (g) ## UAT Type present but no UAT mode: bullet ─────────────────────
  console.log('\n── (g) UAT Type section present, no UAT mode: bullet');

  assertEq(
    extractUatType('## UAT Type\n\n- Some other bullet: value\n- Another bullet\n'),
    undefined,
    'section present but no UAT mode: bullet → undefined',
  );

  assertEq(
    extractUatType('## UAT Type\n\n'),
    undefined,
    'section present but empty → undefined',
  );

  // ─── (h) unknown keyword ──────────────────────────────────────────────────
  console.log('\n── (h) unknown keyword');

  assertEq(
    extractUatType(makeUatContent('automated')),
    undefined,
    'unknown keyword automated → undefined',
  );

  assertEq(
    extractUatType(makeUatContent('fully-automated')),
    undefined,
    'unknown keyword fully-automated → undefined',
  );

  // ─── (i) extra whitespace around value ────────────────────────────────────
  console.log('\n── (i) extra whitespace');

  assertEq(
    extractUatType('## UAT Type\n\n- UAT mode:   artifact-driven   \n'),
    'artifact-driven',
    'leading/trailing whitespace around value → still classified correctly',
  );

  assertEq(
    extractUatType('## UAT Type\n\n- UAT mode:  mixed (artifact-driven + live-runtime)  \n'),
    'mixed',
    'whitespace around mixed parenthetical → mixed',
  );

  // ─── (j) case sensitivity ─────────────────────────────────────────────────
  console.log('\n── (j) case sensitivity');

  assertEq(
    extractUatType(makeUatContent('Artifact-Driven')),
    'artifact-driven',
    'Artifact-Driven (title case) → artifact-driven (function lowercases before matching)',
  );

  assertEq(
    extractUatType(makeUatContent('MIXED')),
    'mixed',
    'MIXED (upper case) → mixed (function lowercases before matching)',
  );

  // ─── (k) prompt template loading and content integrity ────────────────────
  console.log('\n── (k) run-uat prompt template');

  const milestoneId = 'M001';
  const sliceId = 'S01';
  const uatPath = '.gsd/milestones/M001/slices/S01/S01-UAT.md';
  const uatResultPath = '.gsd/milestones/M001/slices/S01/S01-UAT-RESULT.md';
  const uatType = 'artifact-driven';
  const inlinedContext = '<!-- no context -->';

  let promptResult: string | undefined;
  let promptThrew = false;
  try {
    promptResult = loadPromptFromWorktree('run-uat', {
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

  assert(!promptThrew, 'loadPromptFromWorktree("run-uat", vars) does not throw');
  assert(
    typeof promptResult === 'string' && promptResult.length > 0,
    'run-uat prompt result is a non-empty string',
  );
  assert(
    promptResult?.includes(milestoneId) ?? false,
    `prompt contains milestoneId value "${milestoneId}" after substitution`,
  );
  assert(
    promptResult?.includes(sliceId) ?? false,
    `prompt contains sliceId value "${sliceId}" after substitution`,
  );
  assert(
    promptResult?.includes(uatResultPath) ?? false,
    `prompt contains uatResultPath value after substitution`,
  );
  assert(
    !/\{\{[^}]+\}\}/.test(promptResult ?? ''),
    'no unreplaced {{...}} tokens remain after variable substitution',
  );
  assert(
    /artifact|execute|run/i.test(promptResult ?? ''),
    'prompt contains artifact-driven execution language (artifact/execute/run)',
  );
  assert(
    /surfaced for human review/i.test(promptResult ?? ''),
    'prompt contains "surfaced for human review" text for non-artifact-driven path',
  );

  // ─── (l) dispatch precondition assertions via resolveSliceFile ────────────
  console.log('\n── (l) dispatch preconditions via resolveSliceFile');

  // State A: UAT file exists, UAT-RESULT file does NOT — triggers dispatch
  {
    const base = createFixtureBase();
    const uatContent = makeUatContent('artifact-driven');
    try {
      writeSliceFile(base, 'M001', 'S01', 'UAT', uatContent);

      const uatFilePath = resolveSliceFile(base, 'M001', 'S01', 'UAT');
      assert(
        uatFilePath !== null,
        'resolveSliceFile(..., "UAT") returns non-null when UAT file exists (dispatch trigger state)',
      );

      const uatResultFilePath = resolveSliceFile(base, 'M001', 'S01', 'UAT-RESULT');
      assertEq(
        uatResultFilePath,
        null,
        'resolveSliceFile(..., "UAT-RESULT") returns null when result file missing (dispatch trigger state)',
      );

      // End-to-end: file content → parse → classify
      const rawContent = readFileSync(uatFilePath!, 'utf-8');
      assertEq(
        extractUatType(rawContent),
        'artifact-driven',
        'extractUatType on fixture UAT file returns expected type (end-to-end data flow)',
      );
    } finally {
      cleanup(base);
    }
  }

  // State B: UAT-RESULT file exists — dispatch is skipped (idempotent)
  {
    const base = createFixtureBase();
    try {
      writeSliceFile(base, 'M001', 'S01', 'UAT', makeUatContent('artifact-driven'));
      writeSliceFile(base, 'M001', 'S01', 'UAT-RESULT', '# UAT Result\n\nverdict: PASS\n');

      const uatResultFilePath = resolveSliceFile(base, 'M001', 'S01', 'UAT-RESULT');
      assert(
        uatResultFilePath !== null,
        'resolveSliceFile(..., "UAT-RESULT") returns non-null when result file exists (idempotent skip state)',
      );
    } finally {
      cleanup(base);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Results
  // ═══════════════════════════════════════════════════════════════════════════

  console.log(`\n${'='.repeat(40)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  } else {
    console.log('All tests passed ✓');
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
