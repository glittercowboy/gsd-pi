#!/usr/bin/env bash
#
# verify-m009-links.sh — Verify all artifact references in M009 documentation
#
# Extracts backtick-quoted file paths (.json, .md) from the evidence-grounded
# pipeline report and reproducibility docs, checks each exists on disk.
#
# Exit codes:
#   0 — all links resolve
#   1 — one or more missing artifacts
#
# Usage:
#   bash scripts/verify-m009-links.sh
#

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Track counts
checked=0
missing=0

# Temporary file for unique paths
paths_file=$(mktemp)
trap 'rm -f "$paths_file"' EXIT

echo "=== M009 Artifact Link Verification ==="
echo ""

# Extract all backtick-quoted paths ending in .json or .md from target docs
# Deduplicate with sort -u
grep -hoP '(?<=`)[^`]+\.(json|md)(?=`)' \
    docs/evidence-grounded-pipeline.md \
    docs/reproducibility/*.md \
    2>/dev/null \
    | sort -u > "$paths_file" || true

# Check each path
while IFS= read -r path; do
    checked=$((checked + 1))
    if [[ -f "$path" ]]; then
        echo -e "  ${GREEN}✓${NC} $path"
    else
        missing=$((missing + 1))
        echo -e "  ${RED}✗ MISSING: $path${NC}"
    fi
done < "$paths_file"

# Summary
echo ""
echo "=== Summary ==="
echo "Checked: $checked"
echo "Passed:  $((checked - missing))"
echo "Missing: $missing"
echo ""

if [[ $missing -eq 0 ]]; then
    echo -e "${GREEN}PASS${NC} — All artifact links resolved"
    exit 0
else
    echo -e "${RED}FAIL${NC} — $missing artifact(s) missing"
    exit 1
fi
