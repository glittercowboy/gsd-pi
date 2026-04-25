/**
 * Unit tests for KNOWLEDGE.md integration.
 *
 * Tests:
 * - KNOWLEDGE is registered in GSD_ROOT_FILES
 * - resolveGsdRootFile resolves KNOWLEDGE paths correctly
 * - inlineGsdRootFile works with the KNOWLEDGE key
 * - before_agent_start hook includes/omits knowledge block appropriately
 * - loadKnowledgeBlock merges global and project knowledge correctly
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GSD_ROOT_FILES, resolveGsdRootFile } from '../paths.ts';
import { inlineGsdRootFile, inlineKnowledgeBudgeted } from '../auto-prompts.ts';
import { appendKnowledge } from '../files.ts';
import { loadKnowledgeBlock } from '../bootstrap/system-context.ts';

// ─── KNOWLEDGE is registered in GSD_ROOT_FILES ─────────────────────────────

test('knowledge: KNOWLEDGE key exists in GSD_ROOT_FILES', () => {
  assert.ok('KNOWLEDGE' in GSD_ROOT_FILES, 'GSD_ROOT_FILES should have KNOWLEDGE key');
  assert.strictEqual(GSD_ROOT_FILES.KNOWLEDGE, 'KNOWLEDGE.md');
});

// ─── resolveGsdRootFile resolves KNOWLEDGE.md ───────────────────────────────

test('knowledge: resolveGsdRootFile returns canonical path when KNOWLEDGE.md exists', () => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'gsd-knowledge-')));
  const gsdDir = join(tmp, '.gsd');
  mkdirSync(gsdDir, { recursive: true });
  writeFileSync(join(gsdDir, 'KNOWLEDGE.md'), '# Project Knowledge\n');

  const resolved = resolveGsdRootFile(tmp, 'KNOWLEDGE');
  assert.strictEqual(resolved, join(gsdDir, 'KNOWLEDGE.md'));

  rmSync(tmp, { recursive: true, force: true });
});

test('knowledge: resolveGsdRootFile resolves when legacy knowledge.md exists', () => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'gsd-knowledge-')));
  const gsdDir = join(tmp, '.gsd');
  mkdirSync(gsdDir, { recursive: true });
  writeFileSync(join(gsdDir, 'knowledge.md'), '# Project Knowledge\n');

  const resolved = resolveGsdRootFile(tmp, 'KNOWLEDGE');
  // On case-insensitive filesystems (macOS), canonical path matches;
  // on case-sensitive (Linux), legacy path matches. Either is valid.
  const canonical = join(gsdDir, 'KNOWLEDGE.md');
  const legacy = join(gsdDir, 'knowledge.md');
  assert.ok(
    resolved === canonical || resolved === legacy,
    `resolved path should be canonical or legacy, got: ${resolved}`,
  );

  rmSync(tmp, { recursive: true, force: true });
});

test('knowledge: resolveGsdRootFile returns canonical path when file does not exist', () => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'gsd-knowledge-')));
  const gsdDir = join(tmp, '.gsd');
  mkdirSync(gsdDir, { recursive: true });

  const resolved = resolveGsdRootFile(tmp, 'KNOWLEDGE');
  assert.strictEqual(resolved, join(gsdDir, 'KNOWLEDGE.md'));

  rmSync(tmp, { recursive: true, force: true });
});

// ─── inlineGsdRootFile works with knowledge.md ─────────────────────────────

test('knowledge: inlineGsdRootFile returns content when KNOWLEDGE.md exists', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'gsd-knowledge-'));
  const gsdDir = join(tmp, '.gsd');
  mkdirSync(gsdDir, { recursive: true });
  writeFileSync(join(gsdDir, 'KNOWLEDGE.md'), '# Project Knowledge\n\n## Rules\n\nK001: Use real DB');

  const result = await inlineGsdRootFile(tmp, 'knowledge.md', 'Project Knowledge');
  assert.ok(result !== null, 'should return content');
  assert.ok(result!.includes('Project Knowledge'), 'should include label');
  assert.ok(result!.includes('K001'), 'should include knowledge content');

  rmSync(tmp, { recursive: true, force: true });
});

test('knowledge: inlineGsdRootFile returns null when KNOWLEDGE.md does not exist', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'gsd-knowledge-'));
  const gsdDir = join(tmp, '.gsd');
  mkdirSync(gsdDir, { recursive: true });

  const result = await inlineGsdRootFile(tmp, 'knowledge.md', 'Project Knowledge');
  assert.strictEqual(result, null, 'should return null when file does not exist');

  rmSync(tmp, { recursive: true, force: true });
});

// ─── appendKnowledge creates file and appends entries ──────────────────────

test('knowledge: appendKnowledge creates KNOWLEDGE.md with rule when file does not exist', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'gsd-knowledge-'));
  const gsdDir = join(tmp, '.gsd');
  mkdirSync(gsdDir, { recursive: true });

  await appendKnowledge(tmp, 'rule', 'Use real DB for integration tests', 'M001/S01');

  const content = readFileSync(join(gsdDir, 'KNOWLEDGE.md'), 'utf-8');
  assert.ok(content.includes('# Project Knowledge'), 'should have header');
  assert.ok(content.includes('K001'), 'should have K001 id');
  assert.ok(content.includes('Use real DB for integration tests'), 'should have rule text');
  assert.ok(content.includes('M001/S01'), 'should have scope');

  rmSync(tmp, { recursive: true, force: true });
});

test('knowledge: appendKnowledge appends to existing KNOWLEDGE.md with auto-incrementing ID', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'gsd-knowledge-'));
  const gsdDir = join(tmp, '.gsd');
  mkdirSync(gsdDir, { recursive: true });

  // Create initial file with one rule
  await appendKnowledge(tmp, 'rule', 'First rule', 'M001');
  // Add second rule
  await appendKnowledge(tmp, 'rule', 'Second rule', 'M001/S02');

  const content = readFileSync(join(gsdDir, 'KNOWLEDGE.md'), 'utf-8');
  assert.ok(content.includes('K001'), 'should have K001');
  assert.ok(content.includes('K002'), 'should have K002');
  assert.ok(content.includes('First rule'), 'should have first rule');
  assert.ok(content.includes('Second rule'), 'should have second rule');

  rmSync(tmp, { recursive: true, force: true });
});

test('knowledge: appendKnowledge handles pattern type', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'gsd-knowledge-'));
  const gsdDir = join(tmp, '.gsd');
  mkdirSync(gsdDir, { recursive: true });

  await appendKnowledge(tmp, 'pattern', 'Middleware chain for auth', 'M001');

  const content = readFileSync(join(gsdDir, 'KNOWLEDGE.md'), 'utf-8');
  assert.ok(content.includes('P001'), 'should have P001 id');
  assert.ok(content.includes('Middleware chain for auth'), 'should have pattern text');

  rmSync(tmp, { recursive: true, force: true });
});

test('knowledge: appendKnowledge handles lesson type', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'gsd-knowledge-'));
  const gsdDir = join(tmp, '.gsd');
  mkdirSync(gsdDir, { recursive: true });

  await appendKnowledge(tmp, 'lesson', 'API timeout on large payloads', 'M002');

  const content = readFileSync(join(gsdDir, 'KNOWLEDGE.md'), 'utf-8');
  assert.ok(content.includes('L001'), 'should have L001 id');
  assert.ok(content.includes('API timeout on large payloads'), 'should have lesson text');

  rmSync(tmp, { recursive: true, force: true });
});

// ─── loadKnowledgeBlock — global + project merge ────────────────────────────

test('loadKnowledgeBlock: returns empty block when neither file exists', () => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'gsd-kb-')));
  const gsdHome = join(tmp, 'home');
  const cwd = join(tmp, 'project');
  mkdirSync(join(cwd, '.gsd'), { recursive: true });
  mkdirSync(join(gsdHome, 'agent'), { recursive: true });

  const result = loadKnowledgeBlock(gsdHome, cwd);
  assert.strictEqual(result.block, '');
  assert.strictEqual(result.globalSizeKb, 0);

  rmSync(tmp, { recursive: true, force: true });
});

test('loadKnowledgeBlock: uses project knowledge alone when no global file', () => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'gsd-kb-')));
  const gsdHome = join(tmp, 'home');
  const cwd = join(tmp, 'project');
  mkdirSync(join(cwd, '.gsd'), { recursive: true });
  mkdirSync(join(gsdHome, 'agent'), { recursive: true });
  writeFileSync(join(cwd, '.gsd', 'KNOWLEDGE.md'), 'K001: Use real DB');

  const result = loadKnowledgeBlock(gsdHome, cwd);
  assert.ok(result.block.includes('[KNOWLEDGE — Rules, patterns, and lessons learned]'));
  assert.ok(result.block.includes('## Project Knowledge'));
  assert.ok(result.block.includes('K001: Use real DB'));
  assert.ok(!result.block.includes('## Global Knowledge'));
  assert.strictEqual(result.globalSizeKb, 0);

  rmSync(tmp, { recursive: true, force: true });
});

test('loadKnowledgeBlock: uses global knowledge alone when no project file', () => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'gsd-kb-')));
  const gsdHome = join(tmp, 'home');
  const cwd = join(tmp, 'project');
  mkdirSync(join(cwd, '.gsd'), { recursive: true });
  mkdirSync(join(gsdHome, 'agent'), { recursive: true });
  writeFileSync(join(gsdHome, 'agent', 'KNOWLEDGE.md'), 'G001: Respond in English');

  const result = loadKnowledgeBlock(gsdHome, cwd);
  assert.ok(result.block.includes('[KNOWLEDGE — Rules, patterns, and lessons learned]'));
  assert.ok(result.block.includes('## Global Knowledge'));
  assert.ok(result.block.includes('G001: Respond in English'));
  assert.ok(!result.block.includes('## Project Knowledge'));
  assert.ok(result.globalSizeKb > 0);

  rmSync(tmp, { recursive: true, force: true });
});

test('loadKnowledgeBlock: merges global before project when both exist', () => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'gsd-kb-')));
  const gsdHome = join(tmp, 'home');
  const cwd = join(tmp, 'project');
  mkdirSync(join(cwd, '.gsd'), { recursive: true });
  mkdirSync(join(gsdHome, 'agent'), { recursive: true });
  writeFileSync(join(gsdHome, 'agent', 'KNOWLEDGE.md'), 'G001: Global rule');
  writeFileSync(join(cwd, '.gsd', 'KNOWLEDGE.md'), 'K001: Project rule');

  const result = loadKnowledgeBlock(gsdHome, cwd);
  assert.ok(result.block.includes('## Global Knowledge'));
  assert.ok(result.block.includes('## Project Knowledge'));
  assert.ok(result.block.includes('G001: Global rule'));
  assert.ok(result.block.includes('K001: Project rule'));
  // Global section appears before project section
  assert.ok(result.block.indexOf('## Global Knowledge') < result.block.indexOf('## Project Knowledge'));

  rmSync(tmp, { recursive: true, force: true });
});

test('loadKnowledgeBlock: reports globalSizeKb above 4KB threshold', () => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'gsd-kb-')));
  const gsdHome = join(tmp, 'home');
  const cwd = join(tmp, 'project');
  mkdirSync(join(cwd, '.gsd'), { recursive: true });
  mkdirSync(join(gsdHome, 'agent'), { recursive: true });
  // Write > 4KB of content
  writeFileSync(join(gsdHome, 'agent', 'KNOWLEDGE.md'), 'x'.repeat(5000));

  const result = loadKnowledgeBlock(gsdHome, cwd);
  assert.ok(result.globalSizeKb > 4, `expected > 4KB, got ${result.globalSizeKb}`);

  rmSync(tmp, { recursive: true, force: true });
});

// ─── inlineKnowledgeBudgeted — issue #4719 ─────────────────────────────────
// Milestone-phase prompts must not inject the full KNOWLEDGE.md. The budgeted
// helper scopes by milestone-level keywords and caps the injected size.

test('inlineKnowledgeBudgeted: returns scoped H3 entries for single-H2 file', async () => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'gsd-knowledge-')));
  const gsdDir = join(tmp, '.gsd');
  mkdirSync(gsdDir, { recursive: true });

  const content = `# Project Knowledge

## Patterns

### Database: prepared statements
Always use prepared statements with SQLite.

### API: versioned paths
Use /v1/resource style versioning.

### Testing: node:test
Prefer node:test over external frameworks.
`;
  writeFileSync(join(gsdDir, 'KNOWLEDGE.md'), content);

  const result = await inlineKnowledgeBudgeted(tmp, ['database']);
  assert.ok(result !== null, 'should return content');
  assert.ok(result!.includes('Database: prepared statements'), 'includes matching H3');
  assert.ok(!result!.includes('API: versioned paths'), 'excludes non-matching H3');

  rmSync(tmp, { recursive: true, force: true });
});

test('inlineKnowledgeBudgeted: caps payload below budget for large files', async () => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'gsd-knowledge-')));
  const gsdDir = join(tmp, '.gsd');
  mkdirSync(gsdDir, { recursive: true });

  // Build a 200KB KNOWLEDGE with 500 H3 entries all matching 'shared'
  const entries = Array.from({ length: 500 }, (_, i) =>
    `### Entry ${i}: shared topic\n${'filler text '.repeat(30)}\n`,
  ).join('\n');
  const content = `# Project Knowledge\n\n## Patterns\n\n${entries}`;
  writeFileSync(join(gsdDir, 'KNOWLEDGE.md'), content);

  const BUDGET_CHARS = 30_000;
  const result = await inlineKnowledgeBudgeted(tmp, ['shared'], { maxChars: BUDGET_CHARS });
  assert.ok(result !== null, 'should return content');
  // Allow some overhead for header formatting, but must stay close to budget
  assert.ok(
    result!.length <= BUDGET_CHARS + 500,
    `payload ${result!.length} chars should be <= budget ${BUDGET_CHARS} (+overhead)`,
  );
  // Far smaller than the raw file
  assert.ok(
    result!.length < content.length / 4,
    `payload should be much smaller than full content (${content.length} chars)`,
  );
  assert.match(
    result!,
    /\[\.\.\.truncated \d+ chars; rerun with narrower scope if needed\]/,
    'should include truncation note when budget is exceeded',
  );

  rmSync(tmp, { recursive: true, force: true });
});

test('inlineKnowledgeBudgeted: returns null when no KNOWLEDGE.md exists', async () => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'gsd-knowledge-')));
  const gsdDir = join(tmp, '.gsd');
  mkdirSync(gsdDir, { recursive: true });

  const result = await inlineKnowledgeBudgeted(tmp, ['database']);
  assert.strictEqual(result, null);

  rmSync(tmp, { recursive: true, force: true });
});

test('inlineKnowledgeBudgeted: returns null when no entries match', async () => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'gsd-knowledge-')));
  const gsdDir = join(tmp, '.gsd');
  mkdirSync(gsdDir, { recursive: true });
  writeFileSync(
    join(gsdDir, 'KNOWLEDGE.md'),
    '# Project Knowledge\n\n## Patterns\n\n### Database\nuse it\n',
  );

  const result = await inlineKnowledgeBudgeted(tmp, ['nonexistent']);
  assert.strictEqual(result, null);

  rmSync(tmp, { recursive: true, force: true });
});
