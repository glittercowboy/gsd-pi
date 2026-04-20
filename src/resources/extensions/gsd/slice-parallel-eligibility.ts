/**
 * GSD Slice Parallel Eligibility — Pure function to determine which slices
 * within a milestone can run in parallel based on dependency satisfaction.
 *
 * This is the slice-level equivalent of parallel-eligibility.ts (which operates
 * at milestone scope). The key difference is the positional fallback: slices
 * without explicit dependencies use sequential ordering as an implicit constraint.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SliceInput {
  id: string;
  done: boolean;
  depends: string[];
}

export interface EligibleSlice {
  id: string;
}

// ─── Core Logic ───────────────────────────────────────────────────────────────

/**
 * Determine which slices are eligible for parallel execution.
 *
 * Rules:
 * 1. Done slices are never eligible (nothing to do).
 * 2. A slice with explicit `depends` entries is eligible when ALL deps
 *    appear in `completedSliceIds`.
 * 3. A slice with NO `depends` entries uses positional fallback: it is
 *    eligible only when every positionally-earlier slice is done.
 *    This preserves backward compatibility with roadmaps that don't
 *    declare inter-slice dependencies.
 *
 * @param slices      All slices in the milestone (ordered by position).
 * @param completedSliceIds  Set of slice IDs that are already complete.
 * @returns           Array of eligible slice descriptors.
 */
export function getEligibleSlices(
  slices: SliceInput[],
  completedSliceIds: Set<string>,
): EligibleSlice[] {
  const eligible: EligibleSlice[] = [];

  for (let i = 0; i < slices.length; i++) {
    const slice = slices[i];

    // Rule 1: skip done slices
    if (slice.done) continue;

    const hasExplicitDeps = slice.depends.length > 0;

    if (hasExplicitDeps) {
      // Rule 2: explicit dependencies — all must be satisfied
      const allDepsSatisfied = slice.depends.every(dep => completedSliceIds.has(dep));
      if (allDepsSatisfied) {
        eligible.push({ id: slice.id });
      }
    } else {
      // Rule 3: no deps declared — positional fallback
      // Eligible only if all positionally-earlier slices are done
      const allEarlierDone = slices.slice(0, i).every(
        earlier => earlier.done || completedSliceIds.has(earlier.id),
      );
      if (allEarlierDone) {
        eligible.push({ id: slice.id });
      }
    }
  }

  return eligible;
}
