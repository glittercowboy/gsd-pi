#!/usr/bin/env bash
# Installs the git pre-commit hook for secret scanning.
# Safe to run multiple times — only installs if not already present.

set -euo pipefail

HOOK_DIR="$(git rev-parse --git-dir)/hooks"
HOOK_FILE="$HOOK_DIR/pre-commit"
MARKER="# gsd-secret-scan"

mkdir -p "$HOOK_DIR"

# Check if our hook is already installed
if [[ -f "$HOOK_FILE" ]] && grep -q "$MARKER" "$HOOK_FILE" 2>/dev/null; then
  echo "secret-scan pre-commit hook already installed."
  exit 0
fi

# If a pre-commit hook already exists, append; otherwise create
if [[ -f "$HOOK_FILE" ]]; then
  echo "" >> "$HOOK_FILE"
  echo "$MARKER" >> "$HOOK_FILE"
  echo 'bash "$(git rev-parse --show-toplevel)/scripts/secret-scan.sh"' >> "$HOOK_FILE"
  echo "secret-scan appended to existing pre-commit hook."
else
  cat > "$HOOK_FILE" << 'EOF'
#!/usr/bin/env bash
# gsd-secret-scan
# Pre-commit hook: scan staged files for hardcoded secrets
bash "$(git rev-parse --show-toplevel)/scripts/secret-scan.sh"
EOF
  chmod +x "$HOOK_FILE"
  echo "secret-scan pre-commit hook installed."
fi
