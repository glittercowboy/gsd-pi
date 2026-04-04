/**
 * Status predicates for GSD state-machine guards.
 *
 * The DB stores status as free-form strings. Three values indicate
 * "closed": "complete" (canonical), "done" (legacy / alias), and
 * "skipped" (user-directed skip via rethink or backtrack).
 * Every inline `status === "complete" || status === "done"` should
 * use isClosedStatus() instead.
 */

/** Returns true when a milestone, slice, or task status indicates closure. */
export function isClosedStatus(status: string): boolean {
  return status === "complete" || status === "done" || status === "skipped";
}
