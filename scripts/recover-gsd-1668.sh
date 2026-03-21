#!/usr/bin/env bash
# recover-gsd-1668.sh — Recovery script for issue #1668 (Linux / macOS)
#
# GSD v2.39.x deleted the milestone branch and worktree directory when a
# merge failed due to the repo using `master` as its default branch (not
# `main`). The commits were never merged — they are orphaned in the git
# object store and can be recovered via git reflog or git fsck.
#
# This script:
#   1. Searches git reflog for the deleted milestone branch (fastest path)
#   2. Falls back to git fsck --unreachable to find orphaned commits
#   3. Ranks candidates by recency and GSD commit message patterns
#   4. Creates a recovery branch at the identified commit
#   5. Reports what was found and how to complete the merge manually
#
# Usage:
#   bash scripts/recover-gsd-1668.sh [--milestone <ID>] [--dry-run] [--auto]
#
# Options:
#   --milestone <ID>   GSD milestone ID (e.g. M001-g2nalq).
#                      When omitted the script scans all recent orphans.
#   --dry-run          Show what would be done without making any changes.
#   --auto             Pick the best candidate automatically (no prompts).
#
# Requirements: git >= 2.23, bash >= 4.x
#
# Affected versions: GSD 2.39.x
# Fixed in: GSD 2.40.1 (PR #1669)

set -euo pipefail

# ─── Colours ──────────────────────────────────────────────────────────────────

RED='\033[0;31m'
YELLOW='\033[1;33m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
RESET='\033[0m'

# ─── Args ─────────────────────────────────────────────────────────────────────

DRY_RUN=false
AUTO=false
MILESTONE_ID=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)    DRY_RUN=true;  shift ;;
    --auto)       AUTO=true;     shift ;;
    --milestone)
      [[ $# -lt 2 ]] && { echo "Error: --milestone requires an argument" >&2; exit 1; }
      MILESTONE_ID="$2"; shift 2 ;;
    --milestone=*)
      MILESTONE_ID="${1#--milestone=}"; shift ;;
    -h|--help)
      sed -n '2,/^set -/p' "$0" | grep '^#' | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *)
      echo "Unknown argument: $1" >&2
      echo "Usage: $0 [--milestone <ID>] [--dry-run] [--auto]" >&2
      exit 1 ;;
  esac
done

# ─── Helpers ──────────────────────────────────────────────────────────────────

info()    { echo -e "${CYAN}[info]${RESET}  $*"; }
ok()      { echo -e "${GREEN}[ok]${RESET}    $*"; }
warn()    { echo -e "${YELLOW}[warn]${RESET}  $*"; }
error()   { echo -e "${RED}[error]${RESET} $*" >&2; }
section() { echo -e "\n${BOLD}$*${RESET}"; }
dim()     { echo -e "${DIM}$*${RESET}"; }

die() {
  error "$*"
  exit 1
}

run() {
  if $DRY_RUN; then
    echo -e "  ${YELLOW}(dry-run)${RESET} $*"
  else
    eval "$*"
  fi
}

# ─── Preflight ────────────────────────────────────────────────────────────────

section "── Preflight ───────────────────────────────────────────────────────────"

if ! git rev-parse --git-dir > /dev/null 2>&1; then
  die "Not inside a git repository. Run this from your project root."
fi

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"
info "Repo root: $REPO_ROOT"

$DRY_RUN && warn "DRY-RUN mode — no changes will be made."

# ─── Step 1: Confirm the milestone branch is gone ─────────────────────────────

section "── Step 1: Verify milestone branch is missing ───────────────────────────"

BRANCH_PATTERN="milestone/"
if [[ -n "$MILESTONE_ID" ]]; then
  BRANCH_PATTERN="milestone/${MILESTONE_ID}"
fi

LIVE_BRANCHES="$(git branch | grep "$BRANCH_PATTERN" 2>/dev/null | tr -d '* ' || true)"

if [[ -n "$LIVE_BRANCHES" ]]; then
  ok "Found live milestone branch(es):"
  echo "$LIVE_BRANCHES" | while IFS= read -r b; do echo "  $b"; done
  echo ""
  warn "The branch still exists — are you sure it was lost?"
  echo "  If you want to check out existing work:  git checkout ${LIVE_BRANCHES%%$'\n'*}"
  echo "  To merge it manually:  git checkout master && git merge --squash ${LIVE_BRANCHES%%$'\n'*}"
  echo ""
  echo "Re-run with --milestone <ID> to force scanning for a specific orphaned commit."
  if [[ -z "$MILESTONE_ID" ]]; then
    exit 0
  fi
fi

if [[ -n "$MILESTONE_ID" && -n "$LIVE_BRANCHES" ]]; then
  warn "Milestone branch milestone/${MILESTONE_ID} is still live — continuing scan anyway."
elif [[ -n "$MILESTONE_ID" ]]; then
  info "Confirmed: milestone/${MILESTONE_ID} branch is gone."
else
  info "No live milestone/ branches found — scanning for orphaned commits."
fi

# ─── Step 2: Search git reflog (fastest, most reliable) ───────────────────────

section "── Step 2: Search git reflog for deleted branch ────────────────────────"

# git reflog stores branch moves and deletions in .git/logs/refs/heads/
# It is retained for 90 days by default (gc.reflogExpire).
REFLOG_FOUND_SHA=""
REFLOG_FOUND_BRANCH=""

if [[ -n "$MILESTONE_ID" ]]; then
  REFLOG_PATH="${REPO_ROOT}/.git/logs/refs/heads/milestone/${MILESTONE_ID}"
  if [[ -f "$REFLOG_PATH" ]]; then
    # Last line of the reflog for this branch is the most recent tip
    REFLOG_FOUND_SHA="$(tail -1 "$REFLOG_PATH" | awk '{print $2}')"
    REFLOG_FOUND_BRANCH="milestone/${MILESTONE_ID}"
    ok "Reflog entry found for milestone/${MILESTONE_ID} — commit: ${REFLOG_FOUND_SHA:0:12}"
  else
    info "No reflog file at .git/logs/refs/heads/milestone/${MILESTONE_ID}"
  fi
fi

# Also try git reflog (in-memory index, works without the raw file)
if [[ -z "$REFLOG_FOUND_SHA" ]]; then
  info "Scanning git reflog for milestone/ commits..."
  REFLOG_MILESTONES="$(git reflog --all --format="%H %gs" 2>/dev/null \
    | grep -E "(checkout|commit|merge).*milestone/" \
    | head -20 || true)"

  if [[ -n "$REFLOG_MILESTONES" ]]; then
    info "Found milestone-related reflog entries:"
    echo "$REFLOG_MILESTONES" | while IFS= read -r line; do
      dim "  $line"
    done
    # Extract the most recent SHA from the most relevant entry
    if [[ -n "$MILESTONE_ID" ]]; then
      MATCH="$(echo "$REFLOG_MILESTONES" | grep "milestone/${MILESTONE_ID}" | head -1 || true)"
    else
      MATCH="$(echo "$REFLOG_MILESTONES" | head -1 || true)"
    fi
    if [[ -n "$MATCH" ]]; then
      REFLOG_FOUND_SHA="$(echo "$MATCH" | awk '{print $1}')"
      REFLOG_FOUND_BRANCH="$(echo "$MATCH" | grep -oE 'milestone/[^ ]+' | head -1 || echo "milestone/unknown")"
    fi
  else
    info "No milestone/ entries in reflog."
  fi
fi

# ─── Step 3: Fall back to git fsck if reflog didn't find it ───────────────────

section "── Step 3: Scan for orphaned (unreachable) commits ───────────────────"

FSCK_CANDIDATES=()
FSCK_CANDIDATE_MSGS=()
FSCK_CANDIDATE_DATES=()
FSCK_CANDIDATE_FILES=()

if [[ -z "$REFLOG_FOUND_SHA" ]]; then
  info "Running git fsck --unreachable (this may take a moment)..."

  # Collect all unreachable commit hashes
  UNREACHABLE_COMMITS="$(git fsck --unreachable --no-reflogs 2>/dev/null \
    | grep '^unreachable commit' \
    | awk '{print $3}' || true)"

  if [[ -z "$UNREACHABLE_COMMITS" ]]; then
    # Try without --no-reflogs as a fallback (less conservative)
    UNREACHABLE_COMMITS="$(git fsck --unreachable 2>/dev/null \
      | grep '^unreachable commit' \
      | awk '{print $3}' || true)"
  fi

  TOTAL="$(echo "$UNREACHABLE_COMMITS" | grep -c . || true)"
  info "Found ${TOTAL} unreachable commit object(s)."

  if [[ -z "$UNREACHABLE_COMMITS" || "$TOTAL" -eq 0 ]]; then
    error "No unreachable commits found."
    echo ""
    echo "This means one of:"
    echo "  1. git gc has already been run and the objects were pruned"
    echo "     (objects are pruned after 14 days by default)"
    echo "  2. The commits were never written to the object store"
    echo "  3. The wrong repository is being scanned"
    echo ""
    echo "If git gc ran, the objects may be unrecoverable without a backup."
    echo "Try: git reflog --all | grep milestone"
    exit 1
  fi

  # Score each unreachable commit — rank by recency and GSD message patterns.
  # GSD milestone commits look like: "feat(M001-g2nalq): <title>"
  # Slice merges look like:          "feat(M001-g2nalq/S01): <slice>"
  #
  # Performance: use a single `git log --no-walk=unsorted --stdin` call to
  # read all commit metadata in one pass instead of one `git show` per commit.
  CUTOFF="$(date -d '30 days ago' '+%s' 2>/dev/null || date -v-30d '+%s' 2>/dev/null || echo 0)"
  WEEK_AGO="$(date -d '7 days ago' '+%s' 2>/dev/null || date -v-7d '+%s' 2>/dev/null || echo 0)"

  # Batch-read all commits: output format per commit is:
  #   HASH<TAB>UNIX_TIMESTAMP<TAB>ISO_DATE<TAB>SUBJECT
  # separated by NUL so multi-line subjects don't break parsing.
  BATCH_LOG="$(echo "$UNREACHABLE_COMMITS" \
    | git log --no-walk=unsorted --stdin --format=$'%H\t%ct\t%ci\t%s' 2>/dev/null || true)"

  while IFS=$'\t' read -r sha commit_ts commit_date_hr commit_msg; do
    [[ -z "$sha" ]] && continue
    [[ -z "$commit_ts" || "$commit_ts" -lt "$CUTOFF" ]] && continue

    # Score: milestone pattern in subject is highest signal
    SCORE=0
    if [[ -n "$MILESTONE_ID" ]] && echo "$commit_msg" | grep -qiE "(milestone[/ ])?${MILESTONE_ID}"; then
      SCORE=$((SCORE + 100))
    fi
    if echo "$commit_msg" | grep -qE '^feat\([A-Z][0-9]+'; then
      SCORE=$((SCORE + 50))
    fi
    if echo "$commit_msg" | grep -qiE 'milestone/|complete-milestone|GSD|slice'; then
      SCORE=$((SCORE + 20))
    fi
    if [[ "$commit_ts" -gt "$WEEK_AGO" ]]; then
      SCORE=$((SCORE + 10))
    fi

    FSCK_CANDIDATES+=("$sha|$SCORE")
    FSCK_CANDIDATE_MSGS+=("$commit_msg")
    FSCK_CANDIDATE_DATES+=("$commit_date_hr")
    FSCK_CANDIDATE_FILES+=("?")
  done <<< "$BATCH_LOG"

  if [[ ${#FSCK_CANDIDATES[@]} -eq 0 ]]; then
    error "No recent unreachable commits found within the last 30 days."
    echo ""
    echo "Objects may have been pruned by git gc, or the issue occurred more than 30 days ago."
    echo "Try: git fsck --unreachable --no-reflogs 2>/dev/null | grep commit"
    exit 1
  fi

  # Sort by score descending, keep top 10
  IFS=$'\n' SORTED_CANDIDATES=($(
    for i in "${!FSCK_CANDIDATES[@]}"; do
      echo "${FSCK_CANDIDATES[$i]}|$i"
    done | sort -t'|' -k2 -rn | head -10
  ))
  unset IFS

  info "Top candidates (scored by recency and GSD message patterns):"
  echo ""
  NUM=1
  SORTED_IDXS=()
  for entry in "${SORTED_CANDIDATES[@]}"; do
    SHA="${entry%%|*}"
    IDX="${entry##*|}"
    SORTED_IDXS+=("$IDX")
    MSG="${FSCK_CANDIDATE_MSGS[$IDX]}"
    DATE="${FSCK_CANDIDATE_DATES[$IDX]}"
    FILES="${FSCK_CANDIDATE_FILES[$IDX]}"
    echo -e "  ${BOLD}${NUM})${RESET} ${sha:0:12}  ${GREEN}${MSG}${RESET}"
    echo -e "       ${DIM}${DATE} — ${FILES}${RESET}"
    NUM=$((NUM + 1))
  done
  echo ""
fi

# ─── Step 4: Select the recovery commit ───────────────────────────────────────

section "── Step 4: Select recovery commit ──────────────────────────────────────"

RECOVERY_SHA=""
RECOVERY_SOURCE=""

if [[ -n "$REFLOG_FOUND_SHA" ]]; then
  RECOVERY_SHA="$REFLOG_FOUND_SHA"
  RECOVERY_SOURCE="reflog (${REFLOG_FOUND_BRANCH})"
  info "Using reflog candidate: ${RECOVERY_SHA:0:12}"
  MSG="$(git show -s --format="%s %ci" "$RECOVERY_SHA" 2>/dev/null || echo "unknown")"
  dim "  $MSG"

elif [[ ${#SORTED_IDXS[@]} -eq 1 ]] || $AUTO; then
  # Auto-select first (highest scored) candidate
  FIRST_ENTRY="${SORTED_CANDIDATES[0]}"
  FIRST_SHA="${FIRST_ENTRY%%|*}"
  FIRST_IDX="${FIRST_ENTRY##*|}"
  RECOVERY_SHA="$FIRST_SHA"
  RECOVERY_SOURCE="fsck (auto-selected)"
  info "Auto-selecting best candidate: ${RECOVERY_SHA:0:12}"

else
  # Prompt user to select
  echo -n "Select a candidate to recover [1-${#SORTED_CANDIDATES[@]}, or q to quit]: "
  read -r SELECTION

  if [[ "$SELECTION" == "q" ]]; then
    info "Aborted."
    exit 0
  fi

  if ! [[ "$SELECTION" =~ ^[0-9]+$ ]] || \
     [[ "$SELECTION" -lt 1 ]] || \
     [[ "$SELECTION" -gt ${#SORTED_CANDIDATES[@]} ]]; then
    die "Invalid selection: $SELECTION"
  fi

  SEL_IDX=$((SELECTION - 1))
  SEL_ENTRY="${SORTED_CANDIDATES[$SEL_IDX]}"
  RECOVERY_SHA="${SEL_ENTRY%%|*}"
  RECOVERY_SOURCE="fsck (user-selected #${SELECTION})"
fi

if [[ -z "$RECOVERY_SHA" ]]; then
  die "Could not determine a recovery commit. See output above."
fi

ok "Recovery commit: ${RECOVERY_SHA:0:16}  (source: ${RECOVERY_SOURCE})"

# Show what's in this commit
echo ""
info "Commit details:"
git show -s --format="  Message:   %s%n  Author:    %an <%ae>%n  Date:      %ci%n  Full SHA:  %H" "$RECOVERY_SHA"
echo ""
info "Files at this commit (first 30):"
git show --stat --format="" "$RECOVERY_SHA" 2>/dev/null | head -30
echo ""

# ─── Step 5: Create recovery branch ───────────────────────────────────────────

section "── Step 5: Create recovery branch ──────────────────────────────────────"

# Determine recovery branch name
if [[ -n "$MILESTONE_ID" ]]; then
  RECOVERY_BRANCH="recovery/1668/${MILESTONE_ID}"
elif [[ -n "$REFLOG_FOUND_BRANCH" ]]; then
  CLEAN_NAME="${REFLOG_FOUND_BRANCH//\//-}"
  RECOVERY_BRANCH="recovery/1668/${CLEAN_NAME}"
else
  SHORT_SHA="${RECOVERY_SHA:0:8}"
  RECOVERY_BRANCH="recovery/1668/commit-${SHORT_SHA}"
fi

# Check if it already exists
if git show-ref --verify --quiet "refs/heads/${RECOVERY_BRANCH}" 2>/dev/null; then
  warn "Branch ${RECOVERY_BRANCH} already exists."
  if ! $AUTO; then
    echo -n "Overwrite it? [y/N]: "
    read -r ANSWER
    if [[ "$ANSWER" != "y" && "$ANSWER" != "Y" ]]; then
      info "Aborted. Existing branch preserved."
      exit 0
    fi
  fi
  run "git branch -D \"${RECOVERY_BRANCH}\""
fi

run "git branch \"${RECOVERY_BRANCH}\" \"${RECOVERY_SHA}\""

if ! $DRY_RUN; then
  ok "Recovery branch created: ${RECOVERY_BRANCH}"
else
  ok "(dry-run) Would create branch: ${RECOVERY_BRANCH} → ${RECOVERY_SHA:0:12}"
fi

# ─── Step 6: Verify the recovery branch ───────────────────────────────────────

if ! $DRY_RUN; then
  section "── Step 6: Verify recovery branch ──────────────────────────────────────"

  FILE_LIST="$(git ls-tree -r --name-only "${RECOVERY_BRANCH}" 2>/dev/null | grep -v '^\.gsd/' || true)"
  FILE_COUNT="$(echo "$FILE_LIST" | grep -c . || true)"

  info "Files recoverable (excluding .gsd/ state files): ${FILE_COUNT}"
  echo "$FILE_LIST" | head -30 | while IFS= read -r f; do echo "  $f"; done
  if [[ "$FILE_COUNT" -gt 30 ]]; then
    dim "  ... and $((FILE_COUNT - 30)) more"
  fi
fi

# ─── Summary ──────────────────────────────────────────────────────────────────

section "── Recovery Summary ─────────────────────────────────────────────────────"

if $DRY_RUN; then
  echo -e "${YELLOW}Dry-run complete. Re-run without --dry-run to apply.${RESET}"
  exit 0
fi

DEFAULT_BRANCH="$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's|refs/remotes/origin/||' \
  || git for-each-ref --format='%(refname:short)' 'refs/heads/main' 'refs/heads/master' 2>/dev/null | head -1 \
  || git branch --show-current)"

echo -e "${GREEN}Recovery branch ready: ${BOLD}${RECOVERY_BRANCH}${RESET}"
echo ""
echo "Next steps:"
echo ""
echo -e "  ${BOLD}1. Inspect the recovered files:${RESET}"
echo "     git checkout ${RECOVERY_BRANCH}"
echo "     ls -la"
echo ""
echo -e "  ${BOLD}2. Verify your code is intact:${RESET}"
echo "     git log --oneline ${RECOVERY_BRANCH} | head -20"
echo "     git show --stat ${RECOVERY_BRANCH}"
echo ""
echo -e "  ${BOLD}3. Merge to your default branch (${DEFAULT_BRANCH}):${RESET}"
echo "     git checkout ${DEFAULT_BRANCH}"
echo "     git merge --squash ${RECOVERY_BRANCH}"
echo "     git commit -m \"feat: recover milestone from #1668\""
echo ""
echo -e "  ${BOLD}4. Clean up after verifying:${RESET}"
echo "     git branch -D ${RECOVERY_BRANCH}"
echo ""
echo -e "${DIM}Note: update GSD to v2.40.1+ to prevent this from recurring.${RESET}"
echo "      PR: https://github.com/gsd-build/gsd-2/pull/1669"
echo ""
