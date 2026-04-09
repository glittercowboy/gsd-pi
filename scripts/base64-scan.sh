#!/usr/bin/env bash
# Base64 obfuscation scanner — extracts base64 blobs from changed files,
# decodes them, and checks decoded content for prompt injection patterns.
#
# Catches obfuscated directives that would bypass docs-prompt-injection-scan.sh,
# which only scans raw text in markdown files.
#
# Usage:
#   scripts/base64-scan.sh                    # scan staged files (pre-commit mode)
#   scripts/base64-scan.sh --diff origin/main # scan diff vs branch (CI mode)
#   scripts/base64-scan.sh --file path        # scan a specific file
#
# Works on macOS (BSD grep) and Linux (GNU grep) — uses only ERE patterns.

set -euo pipefail

RED='\033[0;31m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

IGNOREFILE=".base64scanignore"
EXIT_CODE=0
FINDINGS=0

# Blobs shorter than this have too many false positives.
# 40 base64 chars decodes to ~30 bytes — minimum length for a meaningful directive.
MIN_BLOB_LEN=40

# ── Prompt injection patterns to match against decoded content ────────
# Format: "Label:::flags:::regex"
# Mirrors the patterns in docs-prompt-injection-scan.sh but applied to
# base64-decoded content across all file types.
DECODED_PATTERNS=(
  # System prompt markers
  "System prompt marker:::i:::<system-prompt>"
  "System prompt marker:::i:::<\|im_start\|>system"
  "System prompt marker:::i:::\[SYSTEM\][[:space:]]*:"

  # Role injection / override
  "Role injection:::i:::you are now [a-z]"
  "Instruction override:::i:::ignore (all )?previous instructions"
  "Instruction override:::i:::ignore (all )?prior instructions"
  "Instruction override:::i:::disregard (all )?(above|previous|prior)"
  "Instruction override:::i:::forget (all )?(above|previous|prior) (instructions|context|rules)"
  "Instruction override:::i:::new instructions:"
  "Instruction override:::i:::override (all )?instructions"
  "Instruction override:::i:::your new role is"
  "Instruction override:::i:::from now on,? (you (are|will|must|should)|act as)"

  # Hidden HTML directives
  "Hidden directive::::::<!--[[:space:]]*(PROMPT|INSTRUCTION|SYSTEM|OVERRIDE|INJECT)[[:space:]]*:"
  "Hidden directive::::::<!--[[:space:]]*(ignore|disregard|forget|override)"

  # Tool / function call injection
  "Tool call injection::::::(<tool_call>|<function_call>|<tool_use>)"
  "Tool call injection::::::(<invoke|<function_calls>)"

  # Nested encode/eval attempts
  "Nested encoding:::i:::eval\(|exec\(|Function\("
)

# ── Ignore-file support ───────────────────────────────────────────────
load_ignore_patterns() {
  local ignore_patterns=()
  if [[ -f "$IGNOREFILE" ]]; then
    while IFS= read -r line; do
      [[ -z "$line" || "$line" =~ ^# ]] && continue
      ignore_patterns+=("$line")
    done < "$IGNOREFILE"
  fi
  echo "${ignore_patterns[@]+"${ignore_patterns[@]}"}"
}

is_ignored() {
  local file="$1" blob="$2"
  local ignore_patterns
  read -ra ignore_patterns <<< "$(load_ignore_patterns)"
  for pattern in "${ignore_patterns[@]+"${ignore_patterns[@]}"}"; do
    if [[ "$pattern" == *:* ]]; then
      local ignore_file="${pattern%%:*}"
      local ignore_regex="${pattern#*:}"
      if [[ "$file" == $ignore_file ]] && echo "$blob" | grep -qiE "$ignore_regex" 2>/dev/null; then
        return 0
      fi
    else
      if echo "$blob" | grep -qiE "$pattern" 2>/dev/null; then
        return 0
      fi
    fi
  done
  return 1
}

# ── File filtering ────────────────────────────────────────────────────
# Scans all text file types — encoded instructions can hide anywhere.
should_scan() {
  local file="$1"
  # Skip binary formats
  case "$file" in
    *.png|*.jpg|*.jpeg|*.gif|*.ico|*.woff|*.woff2|*.ttf|*.eot|\
    *.zip|*.tar|*.gz|*.tgz|*.bz2|*.7z|*.rar|\
    *.exe|*.dll|*.so|*.dylib|*.o|*.a|\
    *.pdf|*.doc|*.docx|*.xls|*.xlsx|\
    *.lock|package-lock.json|pnpm-lock.yaml|bun.lock|\
    *.min.js|*.min.css|*.map|\
    *.node|*.wasm)
      return 1 ;;
  esac
  # Skip ignore/meta files
  case "$file" in
    .base64scanignore|.secretscanignore|.gitignore|.gitattributes|LICENSE*|CHANGELOG*)
      return 1 ;;
  esac
  # Skip generated/vendor dirs
  case "$file" in
    node_modules/*|dist/*|coverage/*|.gsd/*)
      return 1 ;;
  esac
  return 0
}

# ── File list and content ─────────────────────────────────────────────
get_files() {
  if [[ "${1:-}" == "--diff" ]]; then
    local ref="${2:-HEAD}"
    git diff --name-only --diff-filter=ACMR "$ref" 2>/dev/null || true
  elif [[ "${1:-}" == "--file" ]]; then
    echo "${2:-}"
  else
    git diff --cached --name-only --diff-filter=ACMR 2>/dev/null || true
  fi
}

get_content() {
  local file="$1"
  if [[ "${SCAN_MODE:-staged}" == "staged" ]]; then
    git show ":$file" 2>/dev/null || cat "$file" 2>/dev/null || true
  else
    cat "$file" 2>/dev/null || true
  fi
}

# ── Decode and check a single blob ────────────────────────────────────
check_blob() {
  local file="$1" blob="$2" line_num="$3"

  # Try to decode; skip if not valid base64
  decoded=$(printf '%s' "$blob" | base64 --decode 2>/dev/null) || return 0

  # Skip binary output: strip printable chars + whitespace; if anything remains it's binary
  remainder=$(printf '%s' "$decoded" | tr -d '[:print:][:space:]')
  [[ -n "$remainder" ]] && return 0

  # Skip trivially short decoded content
  [[ ${#decoded} -lt 8 ]] && return 0

  # Check decoded content against each injection pattern
  for entry in "${DECODED_PATTERNS[@]}"; do
    label="${entry%%:::*}"
    rest="${entry#*:::}"
    flags="${rest%%:::*}"
    regex="${rest#*:::}"

    grep_flags="-E"
    [[ "$flags" == *i* ]] && grep_flags="-Ei"

    if printf '%s' "$decoded" | grep -q $grep_flags "$regex" 2>/dev/null; then
      if is_ignored "$file" "$blob"; then
        continue
      fi

      echo -e "${RED}[BASE64 ENCODED DIRECTIVE]${NC} ${YELLOW}${label}${NC}"
      echo -e "  File:    ${CYAN}${file}:${line_num}${NC}"
      echo "  Encoded: ${blob:0:60}..."
      echo "  Decoded: $(printf '%s' "$decoded" | head -c 120)..."
      echo ""
      FINDINGS=$((FINDINGS + 1))
      EXIT_CODE=1
    fi
  done
}

# ── Argument parsing ──────────────────────────────────────────────────
SCAN_MODE="staged"
FILES_ARG=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --diff) SCAN_MODE="diff"; FILES_ARG=("--diff" "${2:-HEAD}"); shift 2 ;;
    --file) SCAN_MODE="file"; FILES_ARG=("--file" "$2"); shift 2 ;;
    *) shift ;;
  esac
done

FILES=$(get_files "${FILES_ARG[@]+"${FILES_ARG[@]}"}")

if [[ -z "$FILES" ]]; then
  echo "base64-scan: no files to scan"
  exit 0
fi

# ── Main scan ─────────────────────────────────────────────────────────
while IFS= read -r file; do
  [[ -z "$file" ]] && continue
  should_scan "$file" || continue

  content=$(get_content "$file")
  [[ -z "$content" ]] && continue

  line_num=0
  while IFS= read -r line; do
    line_num=$((line_num + 1))

    # Skip data URI lines — legitimate image/font embedding
    echo "$line" | grep -qE 'data:[a-z]+/[a-z+.-]+;base64,' && continue

    # Extract base64 candidates from this line
    blobs=$(printf '%s' "$line" | grep -oE "[A-Za-z0-9+/]{${MIN_BLOB_LEN},}={0,2}" 2>/dev/null || true)
    [[ -z "$blobs" ]] && continue

    while IFS= read -r blob; do
      [[ -z "$blob" ]] && continue
      check_blob "$file" "$blob" "$line_num"
    done <<< "$blobs"
  done <<< "$content"

done <<< "$FILES"

# ── Summary ───────────────────────────────────────────────────────────
if [[ $FINDINGS -gt 0 ]]; then
  echo -e "${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "${RED}Found $FINDINGS base64-encoded directive(s).${NC}"
  echo -e "${RED}Encoded instructions are not permitted in source files.${NC}"
  echo -e "${RED}Add exceptions to .base64scanignore if these are${NC}"
  echo -e "${RED}false positives.${NC}"
  echo -e "${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
else
  echo "base64-scan: no encoded directives detected ✓"
fi

exit $EXIT_CODE
