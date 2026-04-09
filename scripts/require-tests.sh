#!/usr/bin/env bash
# GSD-2 — Require tests with source changes
# Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>
#
# Fails CI if a PR changes source files but includes no test file changes.
# Exemptions: docs-only, CI/config, test-only, and chore branches.

set -euo pipefail

# --- resolve base ref ---
if [ -n "${PR_BASE_SHA:-}" ]; then
  BASE="$PR_BASE_SHA"
elif [ -n "${PUSH_BEFORE_SHA:-}" ]; then
  BASE="$PUSH_BEFORE_SHA"
else
  BASE="origin/main"
fi

FILES=$(git diff --name-only "$BASE" HEAD 2>/dev/null || git diff --name-only HEAD~1)

# --- exempt branch types that don't need tests ---
BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")
if [[ "$BRANCH" =~ ^(docs|chore|ci)/ ]]; then
  echo "✓ Branch type '${BRANCH%%/*}/' is exempt from test requirements"
  exit 0
fi

# --- classify changed files ---
# Source files: .ts/.mts/.mjs/.js in src/ or packages/, excluding tests and type declarations
SRC_FILES=$(echo "$FILES" | grep -E '^(src|packages)/.*\.(ts|mts|mjs|js)$' \
  | grep -vE '\.(test|spec)\.' \
  | grep -vE '\.d\.ts$' \
  | grep -vE '__tests__/' \
  | grep -vE '/tests/' \
  || true)

# Test files: anything with .test. or .spec. or inside __tests__/ or tests/
TEST_FILES=$(echo "$FILES" | grep -E '\.(test|spec)\.(ts|mts|mjs|js|cjs)$' || true)

# --- no source changes? nothing to enforce ---
if [ -z "$SRC_FILES" ]; then
  echo "✓ No source file changes detected — test requirement does not apply"
  exit 0
fi

# --- source changes exist — require test changes ---
SRC_COUNT=$(echo "$SRC_FILES" | wc -l | tr -d ' ')

if [ -z "$TEST_FILES" ]; then
  echo "──────────────────────────────────────────────────────"
  echo "✗ FAILED: Source files changed but no tests included"
  echo "──────────────────────────────────────────────────────"
  echo ""
  echo "Changed source files ($SRC_COUNT):"
  echo "$SRC_FILES" | sed 's/^/  /'
  echo ""
  echo "Per CONTRIBUTING.md:"
  echo "  • Bug fixes must include a regression test"
  echo "  • Features must include tests covering primary success + one failure path"
  echo "  • Behavior changes must update existing tests"
  echo ""
  echo "Add or update test files (*.test.ts) to proceed."
  exit 1
fi

TEST_COUNT=$(echo "$TEST_FILES" | wc -l | tr -d ' ')
echo "✓ Test requirement satisfied: $SRC_COUNT source file(s), $TEST_COUNT test file(s) changed"
