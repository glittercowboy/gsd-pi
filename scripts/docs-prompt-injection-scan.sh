#!/usr/bin/env bash
# Scan markdown documentation for prompt injection patterns.
# Designed to catch hidden directives, role overrides, and system prompt
# markers that could influence LLM behavior when docs are ingested as context.
#
# Usage:
#   bash scripts/docs-prompt-injection-scan.sh                  # scan staged .md files
#   bash scripts/docs-prompt-injection-scan.sh --diff origin/main  # scan changed .md files vs branch
#   bash scripts/docs-prompt-injection-scan.sh --file README.md    # scan a single file

set -euo pipefail

RED='\033[0;31m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

IGNOREFILE=".prompt-injection-scanignore"
EXIT_CODE=0
FINDINGS=0

# ── Patterns ──────────────────────────────────────────────────────────
# Format: "Label:::flags:::regex"
# Flags: i = case-insensitive
PATTERNS=(
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
  "Hidden HTML directive::::::<!--[[:space:]]*(PROMPT|INSTRUCTION|SYSTEM|OVERRIDE|INJECT)[[:space:]]*:"
  "Hidden HTML directive::::::<!--[[:space:]]*(ignore|disregard|forget|override)"

  # Tool / function call injection
  "Tool call injection::::::(<tool_call>|<function_call>|<tool_use>)"
  "Tool call injection::::::(<invoke|<function_calls>)"

  # Encoded payload markers
  "Encoded payload:::i:::(eval|exec|decode)\((base64|atob|btoa)"

  # Invisible Unicode tricks (zero-width chars used to hide directives)
  # Match specific zero-width codepoints: U+200B (ZWSP), U+200C (ZWNJ), U+200D (ZWJ), U+FEFF (BOM)
  # Use Perl-compatible Unicode escapes to avoid matching em-dash (U+2014) and similar
  "Invisible Unicode:::P:::\\x{200B}|\\x{200C}|\\x{200D}|\\x{FEFF}"
)

# ── Helpers ───────────────────────────────────────────────────────────

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
  local file="$1" line_content="$2"
  local ignore_patterns
  read -ra ignore_patterns <<< "$(load_ignore_patterns)"

  for pattern in "${ignore_patterns[@]+"${ignore_patterns[@]}"}"; do
    if [[ "$pattern" == *:* ]]; then
      local ignore_file="${pattern%%:*}"
      local ignore_regex="${pattern#*:}"
      if [[ "$file" == $ignore_file ]] && echo "$line_content" | grep -qiE "$ignore_regex" 2>/dev/null; then
        return 0
      fi
    else
      if echo "$line_content" | grep -qiE "$pattern" 2>/dev/null; then
        return 0
      fi
    fi
  done
  return 1
}

# Strip fenced code blocks and inline code from content so we don't flag
# examples/docs. Returns only the prose portions of the markdown.
strip_code_blocks() {
  awk '
    /^```/ { in_code = !in_code; print ""; next }
    in_code { print ""; next }
    {
      # Replace inline backtick spans with empty string
      gsub(/`[^`]+`/, "")
      print
    }
  '
}

get_files() {
  if [[ "${1:-}" == "--diff" ]]; then
    local ref="${2:-HEAD}"
    git diff --name-only --diff-filter=ACMR "$ref" 2>/dev/null | grep -E '\.(md|markdown)$' || true
  elif [[ "${1:-}" == "--file" ]]; then
    echo "${2:-}"
  else
    git diff --cached --name-only --diff-filter=ACMR 2>/dev/null | grep -E '\.(md|markdown)$' || true
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

# ── Parse arguments ───────────────────────────────────────────────────

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
  echo "prompt-injection-scan: no documentation files to scan"
  exit 0
fi

# ── Scan ──────────────────────────────────────────────────────────────

while IFS= read -r file; do
  [[ -z "$file" ]] && continue

  raw_content=$(get_content "$file")
  [[ -z "$raw_content" ]] && continue

  # Strip code blocks so we only scan prose
  content=$(echo "$raw_content" | strip_code_blocks)

  for entry in "${PATTERNS[@]}"; do
    label="${entry%%:::*}"
    rest="${entry#*:::}"
    flags="${rest%%:::*}"
    regex="${rest#*:::}"

    if [[ "$flags" == *P* ]]; then
      grep_flags="-nP"
    else
      grep_flags="-nE"
    fi
    if [[ "$flags" == *i* ]]; then
      grep_flags="${grep_flags}i"
    fi

    matches=$(echo "$content" | grep $grep_flags -e "$regex" 2>/dev/null || true)

    if [[ -n "$matches" ]]; then
      while IFS= read -r match_line; do
        [[ -z "$match_line" ]] && continue
        line_num="${match_line%%:*}"
        line_content="${match_line#*:}"

        if is_ignored "$file" "$line_content"; then
          continue
        fi

        echo -e "${RED}[PROMPT INJECTION]${NC} ${YELLOW}${label}${NC}"
        echo -e "  File: ${CYAN}${file}:${line_num}${NC}"
        echo "  Line: $(echo "$line_content" | head -c 120)..."
        echo ""
        FINDINGS=$((FINDINGS + 1))
        EXIT_CODE=1
      done <<< "$matches"
    fi
  done
done <<< "$FILES"

# ── Report ────────────────────────────────────────────────────────────

if [[ $FINDINGS -gt 0 ]]; then
  echo -e "${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "${RED}Found $FINDINGS potential prompt injection(s) in docs.${NC}"
  echo -e "${RED}Review flagged lines and remove or move to code blocks.${NC}"
  echo -e "${RED}Add exceptions to .prompt-injection-scanignore if these${NC}"
  echo -e "${RED}are false positives.${NC}"
  echo -e "${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
else
  echo "prompt-injection-scan: no prompt injection detected ✓"
fi

exit $EXIT_CODE
