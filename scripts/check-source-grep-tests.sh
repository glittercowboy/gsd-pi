#!/usr/bin/env bash
# GSD-2 — Reject source-grep tests
# Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>
#
# Fails CI if a PR adds or modifies a test file that reads a source file with
# readFileSync / readFile / fs.promises.readFile and asserts against its text
# (regex, includes, match). See "No source-grep tests" in CONTRIBUTING.md.
#
# Escape hatch: add `// allow-source-grep: <reason>` on or directly above the
# offending line. The reason becomes part of the diff and is visible at review.

set -euo pipefail

if [ -n "${PR_BASE_SHA:-}" ]; then
  BASE="$PR_BASE_SHA"
elif [ -n "${PUSH_BEFORE_SHA:-}" ]; then
  BASE="$PUSH_BEFORE_SHA"
else
  BASE="origin/main"
fi

# --- Find added/modified test files in the diff ---
CHANGED=$(git diff --name-only --diff-filter=AM "$BASE" HEAD 2>/dev/null \
  || git diff --name-only --diff-filter=AM HEAD~1)

TEST_FILES=$(echo "$CHANGED" \
  | grep -E '\.(test|spec)\.(ts|mts|mjs|js|cjs)$' \
  || true)

if [ -z "$TEST_FILES" ]; then
  echo "✓ No test files changed — source-grep check does not apply"
  exit 0
fi

# --- Pattern: readFileSync / readFile / fs.promises.readFile applied to a
#     path containing src/ or packages/ — i.e., reading source as text. ---
#
# Matches:
#   readFileSync("src/foo.ts", ...)
#   readFileSync(`packages/x/src/y.ts`, ...)
#   await readFile(join(__dirname, "../src/parser.ts"), ...)
#   fs.promises.readFile("packages/...", ...)
#
# Does NOT match arbitrary readFileSync of fixtures, JSON, etc.
READ_SOURCE_RE='(readFileSync|readFile|fs\.promises\.readFile)[[:space:]]*\([^)]*(src/|packages/)[^)]*\.(ts|mts|mjs|js|cjs|tsx|jsx)'

OFFENDERS=""

while IFS= read -r FILE; do
  [ -z "$FILE" ] && continue
  [ ! -f "$FILE" ] && continue

  # grep with line numbers; allow opt-out via marker on the same line OR the
  # immediately preceding line.
  while IFS=: read -r LINENO MATCH; do
    [ -z "$LINENO" ] && continue

    # Same-line escape hatch
    if echo "$MATCH" | grep -q 'allow-source-grep:'; then
      continue
    fi

    # Previous-line escape hatch
    PREV_LINE=$((LINENO - 1))
    if [ "$PREV_LINE" -gt 0 ]; then
      PREV=$(sed -n "${PREV_LINE}p" "$FILE")
      if echo "$PREV" | grep -q 'allow-source-grep:'; then
        continue
      fi
    fi

    OFFENDERS+="${FILE}:${LINENO}: ${MATCH}"$'\n'
  done < <(grep -nE "$READ_SOURCE_RE" "$FILE" || true)
done <<< "$TEST_FILES"

if [ -n "$OFFENDERS" ]; then
  echo "──────────────────────────────────────────────────────"
  echo "✗ FAILED: Source-grep test pattern detected"
  echo "──────────────────────────────────────────────────────"
  echo ""
  echo "These test files read a source file as text. A test must execute"
  echo "the code under test, not assert on its source string."
  echo ""
  printf '%s' "$OFFENDERS" | sed 's/^/  /'
  echo ""
  echo "See \"No source-grep tests\" in CONTRIBUTING.md."
  echo ""
  echo "If this is a legitimate exception (code generator, file-structure"
  echo "linter, manifest producer), add on or directly above the line:"
  echo "    // allow-source-grep: <one-line reason>"
  exit 1
fi

echo "✓ No source-grep test patterns in changed test files"
