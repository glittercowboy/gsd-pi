/**
 * GSD branch naming patterns — single source of truth.
 *
 * gsd/<worktree>/<milestone>/<slice>  → SLICE_BRANCH_RE
 * gsd/quick/<id>-<slug>               → QUICK_BRANCH_RE
 * gsd/<workflow>/<...>                 → WORKFLOW_BRANCH_RE (non-milestone gsd/ branches)
 */

/** Matches gsd/ slice branches: gsd/[worktree/]M001[-hash]/S01 */
export const SLICE_BRANCH_RE = /^gsd\/(?:([a-zA-Z0-9_-]+)\/)?(M\d+(?:-[a-z0-9]{6})?)\/(S\d+)$/;

/** Matches gsd/quick/ task branches */
export const QUICK_BRANCH_RE = /^gsd\/quick\//;

/** Matches gsd/ workflow branches (non-milestone, e.g. gsd/workflow-name/...) */
export const WORKFLOW_BRANCH_RE = /^gsd\/(?!M\d)[\w-]+\//;
