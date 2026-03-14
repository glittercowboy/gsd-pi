#!/usr/bin/env bash
# validate-pack.sh — Verify the npm tarball is installable before publishing.
#
# Packs the tarball, checks critical files exist, then does a real npm install
# from the tarball in an isolated directory. If install fails, the package is
# broken and must not be published.
#
# Usage: npm run validate-pack (or bash scripts/validate-pack.sh)
# Exit 0 = safe to publish, Exit 1 = broken package.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"

echo "==> Packing tarball..."
TARBALL_NAME=$(npm pack --ignore-scripts 2>/dev/null | tail -1)
TARBALL="$ROOT/$TARBALL_NAME"

if [ ! -f "$TARBALL" ]; then
  echo "ERROR: npm pack produced no tarball (expected $TARBALL)"
  exit 1
fi

INSTALL_DIR=$(mktemp -d)
trap 'rm -rf "$INSTALL_DIR" "$TARBALL"' EXIT

echo "==> Tarball: $TARBALL_NAME"

# --- Check 1: Critical files exist in tarball ---
echo "==> Checking tarball contents..."
MISSING=0
for required in \
  "package/dist/loader.js" \
  "package/packages/pi-coding-agent/dist/index.js" \
  "package/packages/pi-ai/dist/index.js" \
  "package/packages/pi-agent-core/dist/index.js" \
  "package/packages/pi-tui/dist/index.js" \
  "package/scripts/link-workspace-packages.cjs" \
  "package/scripts/postinstall.js"; do
  if ! tar tzf "$TARBALL" | grep -q "^${required}$"; then
    echo "    MISSING: $required"
    MISSING=1
  fi
done
if [ "$MISSING" = "1" ]; then
  echo "ERROR: Critical files missing from tarball. Run 'npm run build' first."
  exit 1
fi
echo "    Critical files present."

# --- Check 2: Install test — the real proof ---
echo "==> Testing install in isolated directory..."
cd "$INSTALL_DIR"
npm init -y > /dev/null 2>&1

if npm install "$TARBALL" 2>&1; then
  echo "==> Install succeeded."
else
  echo ""
  echo "ERROR: npm install of tarball failed. This package would break for users."
  echo "Check that all dependencies resolve and workspace linking works."
  exit 1
fi

# --- Check 3: Verify workspace packages are linked ---
echo "==> Verifying workspace package resolution..."
LINK_FAILED=0
for ws_pkg in native pi-agent-core pi-ai pi-coding-agent pi-tui; do
  PKG_DIR="node_modules/gsd-pi/node_modules/@gsd/${ws_pkg}"
  if [ ! -d "$PKG_DIR" ] && [ ! -L "$PKG_DIR" ]; then
    echo "    NOT FOUND: @gsd/${ws_pkg}"
    LINK_FAILED=1
  fi
done
if [ "$LINK_FAILED" = "1" ]; then
  echo "ERROR: Workspace packages not linked after install."
  echo "    Check scripts/link-workspace-packages.cjs and postinstall."
  exit 1
fi
echo "    All workspace packages resolved."

echo ""
echo "Package is installable. Safe to publish."
