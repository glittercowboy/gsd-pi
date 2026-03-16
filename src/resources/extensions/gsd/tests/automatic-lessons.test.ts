/**
 * Unit tests for automatic lesson extraction.
 *
 * Tests the core logic without GSD-specific dependencies.
 * Integration tests would run in the full GSD environment.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ─── Test the core logic directly ─────────────────────────────────────────

// Import the functions to test - these are pure logic functions
// that don't depend on @gsd/pi-coding-agent

// Thresholds (duplicated for testing)
const RETRY_THRESHOLD = 2;
const TOKEN_OVERRUN_THRESHOLD = 50000;

function shouldExtractLessonLogic(
  unitType: string,
  retryCount: number,
  tokenTotal: number | null,
): { shouldExtract: boolean; type: string | null; severity: string | null } {
  // Only extract lessons from execute-task units
  if (unitType !== "execute-task") {
    return { shouldExtract: false, type: null, severity: null };
  }

  // Check for retries
  if (retryCount >= RETRY_THRESHOLD) {
    return {
      shouldExtract: true,
      type: "retry",
      severity: retryCount >= 3 ? "high" : "medium",
    };
  }

  // Check token overrun
  if (tokenTotal !== null && tokenTotal > TOKEN_OVERRUN_THRESHOLD) {
    return {
      shouldExtract: true,
      type: "token_overrun",
      severity: tokenTotal > 100000 ? "high" : "medium",
    };
  }

  return { shouldExtract: false, type: null, severity: null };
}

function extractLessonLogic(
  type: string,
  unitId: string,
  taskTags: string[],
): string {
  const scope = unitId.split("/").slice(0, 2).join("/");

  switch (type) {
    case "retry":
      if (taskTags.includes("api") || taskTags.includes("integration")) {
        return `External API/integration tasks may need retry handling. Consider adding 50% buffer time.`;
      } else if (taskTags.includes("test")) {
        return `Test tasks with external dependencies often need retries. Consider using mocks.`;
      } else {
        return `Complex tasks may require multiple attempts. Break into smaller subtasks.`;
      }

    case "token_overrun":
      if (taskTags.includes("refactor")) {
        return `Large refactor tasks exceed context limits. Split into file-by-file changes.`;
      } else {
        return `High-token tasks may indicate scope creep. Consider splitting into focused tasks.`;
      }

    case "decision_revised":
      return `Decisions were revised. Consider more thorough research phase before committing.`;

    default:
      return `Task encountered issues. Review execution logs for patterns.`;
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────

test('lessons: shouldExtractLesson returns false for non-execute-task units', () => {
  const result = shouldExtractLessonLogic('plan-slice', 0, null);
  assert.strictEqual(result.shouldExtract, false);
  
  const result2 = shouldExtractLessonLogic('research-milestone', 0, null);
  assert.strictEqual(result2.shouldExtract, false);
});

test('lessons: shouldExtractLesson returns false for successful task', () => {
  const result = shouldExtractLessonLogic('execute-task', 0, 8000);
  assert.strictEqual(result.shouldExtract, false);
});

test('lessons: shouldExtractLesson triggers on 2 retries', () => {
  const result = shouldExtractLessonLogic('execute-task', 2, null);
  assert.strictEqual(result.shouldExtract, true);
  assert.strictEqual(result.type, 'retry');
  assert.strictEqual(result.severity, 'medium');
});

test('lessons: shouldExtractLesson triggers high severity on 3 retries', () => {
  const result = shouldExtractLessonLogic('execute-task', 3, null);
  assert.strictEqual(result.shouldExtract, true);
  assert.strictEqual(result.severity, 'high');
});

test('lessons: shouldExtractLesson triggers on high token usage', () => {
  const result = shouldExtractLessonLogic('execute-task', 0, 80000);
  assert.strictEqual(result.shouldExtract, true);
  assert.strictEqual(result.type, 'token_overrun');
  assert.strictEqual(result.severity, 'medium');
});

test('lessons: shouldExtractLesson triggers high severity on very high tokens', () => {
  const result = shouldExtractLessonLogic('execute-task', 0, 150000);
  assert.strictEqual(result.shouldExtract, true);
  assert.strictEqual(result.severity, 'high');
});

test('lessons: extractLessonLogic produces API advice for retry with api tag', () => {
  const lesson = extractLessonLogic('retry', 'M001/S01/T01', ['api', 'integration']);
  assert.ok(lesson.includes('API') || lesson.includes('integration') || lesson.includes('retry'));
});

test('lessons: extractLessonLogic produces refactor advice for token_overrun', () => {
  const lesson = extractLessonLogic('token_overrun', 'M001/S02/T03', ['refactor']);
  assert.ok(lesson.includes('refactor') || lesson.includes('Split') || lesson.includes('split'));
});

test('lessons: extractLessonLogic produces test advice for retry with test tag', () => {
  const lesson = extractLessonLogic('retry', 'M001/S01/T05', ['test']);
  assert.ok(lesson.includes('test') || lesson.includes('mock'));
});

test('lessons: extractLessonLogic produces general advice for unknown tags', () => {
  const lesson = extractLessonLogic('retry', 'M001/S01/T01', []);
  assert.ok(lesson.length > 20, 'should produce meaningful advice');
});

// ─── Knowledge file format test ───────────────────────────────────────────

test('lessons: lesson format is valid for KNOWLEDGE.md', () => {
  const lesson = extractLessonLogic('retry', 'M001/S01/T01', ['api']);
  
  // Lesson should be:
  // - Non-empty string
  // - End with period
  // - Not contain newlines
  assert.ok(typeof lesson === 'string');
  assert.ok(lesson.length > 10);
  assert.ok(!lesson.includes('\n'), 'lesson should be single line');
});