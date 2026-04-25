// Shared assertion helpers for GSD test files.
//
// Usage:
//   import { createTestContext } from './test-helpers.ts';
//   const { assertEq, assertTrue, assertMatch, assertNoMatch, report } = createTestContext();

/**
 * Create an isolated set of assertion helpers with their own pass/fail counters.
 * Each test file gets its own context to avoid shared state across vitest workers.
 */
export function createTestContext() {
  let passed = 0;
  let failed = 0;

  function assertEq<T>(actual: T, expected: T, message: string): void {
    if (JSON.stringify(actual) === JSON.stringify(expected)) {
      passed++;
    } else {
      failed++;
      console.error(`  FAIL: ${message} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
  }

  function assertTrue(condition: boolean, message: string): void {
    if (condition) {
      passed++;
    } else {
      failed++;
      console.error(`  FAIL: ${message}`);
    }
  }

  function assertMatch(value: string, pattern: RegExp, message: string): void {
    if (pattern.test(value)) {
      passed++;
    } else {
      failed++;
      console.error(`  FAIL: ${message} — "${value}" did not match ${pattern}`);
    }
  }

  function assertNoMatch(value: string, pattern: RegExp, message: string): void {
    if (!pattern.test(value)) {
      passed++;
    } else {
      failed++;
      console.error(`  FAIL: ${message} — "${value}" should not have matched ${pattern}`);
    }
  }

  function report(): void {
    console.log(`\nResults: ${passed} passed, ${failed} failed`);
    if (failed > 0) {
      process.exit(1);
    } else {
      console.log('All tests passed');
    }
  }

  return { assertEq, assertTrue, assertMatch, assertNoMatch, report };
}

// ─── Source-inspection helpers (DEPRECATED — do not add new callers) ──────────
//
// `extractSourceRegion` was introduced in #4773 / #4774 as a more-durable
// replacement for hand-rolled `src.slice(idx, idx + N)` patterns. Issue
// #4784 surfaced that the helper is the wrong target: its use case —
// testing that an identifier or phrase exists in production source text
// — is the source-grep antipattern that causes false coverage in the
// first place. Tests should exercise behaviour (call the function,
// assert on its return value or observable effects) rather than check
// whether specific identifier strings remain in source.
//
// CONTRIBUTING.md forbids new callers of this helper. Existing callers
// are being migrated one file at a time; the helper is slated for
// removal once the last caller is converted.
//
// Do not add new callers. If you are tempted to, file an issue
// describing the behavioural invariant you want to test and we will
// find a runtime assertion instead.

/**
 * @deprecated Use a real behaviour test against the function under
 *   inspection instead. See #4784 and CONTRIBUTING.md > "Test behaviour,
 *   not source shape". No new callers.
 *
 * Extract a region of source between a start anchor and either an explicit
 * end anchor or, if none is given, a set of reasonable structural
 * terminators (next `private `/`export `/`function `/`class `/`interface `/
 * `//` section separator). Falls back to end-of-source if none match.
 *
 * @param src        The source text.
 * @param startAnchor Literal substring that marks the start of the region.
 *                   Typically a function name, a section header comment, or
 *                   a distinctive statement.
 * @param endAnchor  Optional. Either a literal substring that marks the end,
 *                   or `{ fromIdx: number }` to find the *next* occurrence
 *                   of `startAnchor` at or after `fromIdx` (useful when the
 *                   anchor appears multiple times and a positional search
 *                   is required). When omitted, structural terminators are
 *                   used.
 *
 * Returns the extracted region (including the start anchor), or an empty
 * string if `startAnchor` is not found.
 */
export function extractSourceRegion(
  src: string,
  startAnchor: string,
  endAnchor?: string | { fromIdx: number },
): string {
  const fromIdx = typeof endAnchor === "object" && endAnchor !== null
    ? endAnchor.fromIdx
    : 0;
  const endLiteral = typeof endAnchor === "string" ? endAnchor : undefined;

  const startIdx = src.indexOf(startAnchor, fromIdx);
  if (startIdx < 0) return "";

  if (endLiteral) {
    const endIdx = src.indexOf(endLiteral, startIdx + startAnchor.length);
    return endIdx > 0 ? src.slice(startIdx, endIdx) : src.slice(startIdx);
  }

  // Heuristic terminators — the next sibling declaration/section.
  const terminators = [
    "\n  private ",
    "\n  public ",
    "\n  protected ",
    "\n  static ",
    "\nexport function ",
    "\nexport async function ",
    "\nfunction ",
    "\nasync function ",
    "\nexport class ",
    "\nclass ",
    "\nexport interface ",
    "\ninterface ",
    "\n// ─", // section separator comments
    "\n/** ", // next docblock
  ];

  let earliestEnd = -1;
  for (const t of terminators) {
    const idx = src.indexOf(t, startIdx + startAnchor.length);
    if (idx > 0 && (earliestEnd < 0 || idx < earliestEnd)) earliestEnd = idx;
  }

  return earliestEnd > 0 ? src.slice(startIdx, earliestEnd) : src.slice(startIdx);
}

/**
 * Poll `condition()` until it returns truthy or `timeoutMs` elapses.
 * Returns the truthy value from `condition()`, or throws on timeout.
 *
 * Use this instead of `await new Promise(r => setTimeout(r, <magic-ms>))`
 * when waiting for a state change that tests produce. The fixed-sleep
 * pattern is flaky: too short → race; too long → slow tests.
 *
 * @param condition  Predicate. Returns truthy when done. May be async.
 * @param opts.timeoutMs  Max total wait. Defaults to 2000ms.
 * @param opts.intervalMs Poll interval. Defaults to 10ms.
 * @param opts.description Included in the timeout error for debuggability.
 */
export async function waitForCondition<T>(
  condition: () => T | Promise<T>,
  opts: { timeoutMs?: number; intervalMs?: number; description?: string } = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 2000;
  const intervalMs = opts.intervalMs ?? 10;
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const result = await condition();
      if (result) return result;
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  const desc = opts.description ?? "condition";
  const errSuffix = lastErr instanceof Error ? ` (last error: ${lastErr.message})` : "";
  throw new Error(`waitForCondition timed out after ${timeoutMs}ms waiting for ${desc}${errSuffix}`);
}

/**
 * Find the first line in rendered output that matches a predicate. Returns
 * the line's index and text, or throws if no line matches.
 *
 * Use this instead of `lines[N]` indexing when the N is positional and
 * could shift under formatting changes.
 */
export function findLine(
  output: string,
  predicate: RegExp | ((line: string) => boolean),
): { index: number; text: string } {
  const lines = output.split("\n");
  const fn = predicate instanceof RegExp
    ? (l: string) => {
        // RegExp.test is stateful when the pattern has /g or /y flags
        // (maintains lastIndex across calls). Reset before each test so
        // matches on different lines don't silently skip.
        if (predicate.global || predicate.sticky) predicate.lastIndex = 0;
        return predicate.test(l);
      }
    : predicate;
  for (let i = 0; i < lines.length; i++) {
    if (fn(lines[i]!)) return { index: i, text: lines[i]! };
  }
  const preview = lines.slice(0, 10).join("\n");
  throw new Error(
    `findLine: no line matched. First 10 lines were:\n${preview}`,
  );
}
