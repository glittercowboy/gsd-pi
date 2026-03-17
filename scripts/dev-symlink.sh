#!/bin/bash
# dev-symlink.sh — Symlink src/resources/ to ~/.gsd/agent/ for live development
#
# This allows you to modify extensions/skills/agents in your checkout and have
# changes reflected immediately without running pi:install-global.
#
# Usage:
#   ./scripts/dev-symlink.sh      # Create symlinks
#   ./scripts/dev-symlink.sh --remove  # Remove symlinks, restore copies
#   ./scripts/dev-symlink.sh --status   # Check current state

set -e

AGENT_DIR="$HOME/.gsd/agent"
SRC_RESOURCES="$PWD/src/resources"
EXTENSIONS_SRC="$SRC_RESOURCES/extensions"
SKILLS_SRC="$SRC_RESOURCES/skills"
AGENTS_SRC="$SRC_RESOURCES/agents"
WORKFLOW_SRC="$SRC_RESOURCES/GSD-WORKFLOW.md"

AGENT_EXTENSIONS="$AGENT_DIR/extensions"
AGENT_SKILLS="$AGENT_DIR/skills"
AGENT_AGENTS="$AGENT_DIR/agents"
AGENT_AGENTS_MD="$AGENT_DIR/AGENTS.md"
AGENT_WORKFLOW="$HOME/.gsd/GSD-WORKFLOW.md"

MODE="${1:-create}"

echo "🔧 GSD Development Symlinks"
echo "   Agent dir: $AGENT_DIR"
echo "   Source: $SRC_RESOURCES"
echo ""

if [ "$MODE" = "--status" ] || [ "$MODE" = "status" ]; then
    echo "📊 Current state:"
    echo ""
    
    check_symlink() {
        local name="$1"
        local target="$2"
        local src="$3"
        
        if [ -L "$target" ]; then
            actual_target=$(readlink "$target")
            if [ "$actual_target" = "$src" ]; then
                echo "  ✓ $name → $src"
            else
                echo "  ⚠ $name → $actual_target (unexpected)"
            fi
        elif [ -d "$target" ] || [ -f "$target" ]; then
            echo "  ✗ $name is a regular file/dir (not symlinked)"
        else
            echo "  - $name does not exist"
        fi
    }
    
    check_symlink "extensions" "$AGENT_EXTENSIONS" "$EXTENSIONS_SRC"
    check_symlink "skills" "$AGENT_SKILLS" "$SKILLS_SRC"
    check_symlink "agents" "$AGENT_AGENTS" "$AGENTS_SRC"
    check_symlink "AGENTS.md" "$AGENT_AGENTS_MD" "$AGENTS_SRC"
    check_symlink "GSD-WORKFLOW.md" "$AGENT_WORKFLOW" "$WORKFLOW_SRC"
    
    exit 0
fi

if [ "$MODE" = "--remove" ] || [ "$MODE" = "remove" ]; then
    echo "🗑️  Removing symlinks..."
    
    remove_if_symlink() {
        local name="$1"
        local path="$2"
        
        if [ -L "$path" ]; then
            rm "$path"
            echo "  ✓ Removed symlink: $name"
        elif [ -e "$path" ]; then
            echo "  ⚠ Skipped $name (not a symlink, preserve manually if needed)"
        fi
    }
    
    remove_if_symlink "extensions" "$AGENT_EXTENSIONS"
    remove_if_symlink "skills" "$AGENT_SKILLS"
    remove_if_symlink "agents" "$AGENT_AGENTS"
    remove_if_symlink "AGENTS.md" "$AGENT_AGENTS_MD"
    remove_if_symlink "GSD-WORKFLOW.md" "$AGENT_WORKFLOW"
    
    echo ""
    echo "💡 To restore copies, run: npm run pi:install-global"
    exit 0
fi

# Default: create symlinks
echo "🔗 Creating symlinks..."

# Ensure agent directory exists
mkdir -p "$AGENT_DIR"

# Files to PRESERVE (do NOT symlink or backup)
PRESERVE_FILES=("auth.json" "models.json" "settings.json" "managed-resources.json")

# Check and warn about files that will be preserved
for file in "${PRESERVE_FILES[@]}"; do
    if [ -f "$AGENT_DIR/$file" ]; then
        echo "  📌 Preserving: $file (not symlinked)"
    fi
done
echo ""

create_symlink() {
    local name="$1"
    local target="$2"
    local src="$3"
    
    # Remove existing symlink or directory
    if [ -L "$target" ]; then
        rm "$target"
    elif [ -d "$target" ] || [ -f "$target" ]; then
        # Backup if it's a real directory/file
        mv "$target" "${target}.backup-$(date +%Y%m%d-%H%M%S)" 2>/dev/null || true
    fi
    
    # Create symlink
    ln -s "$src" "$target"
    echo "  ✓ $name → $src"
}

# Create symlinks
create_symlink "extensions" "$AGENT_EXTENSIONS" "$EXTENSIONS_SRC"
create_symlink "skills" "$AGENT_SKILLS" "$SKILLS_SRC"
create_symlink "agents" "$AGENT_AGENTS" "$AGENTS_SRC"

# AGENTS.md is a file in the agents directory, symlink to the directory instead
# But we also need AGENTS.md specifically, so symlink to the file
create_symlink "AGENTS.md" "$AGENT_AGENTS_MD" "$AGENTS_SRC/researcher.md" 2>/dev/null || \
    create_symlink "AGENTS.md" "$AGENT_AGENTS_MD" "$AGENTS_SRC"

# GSD-WORKFLOW.md goes to ~/.gsd/ not ~/.gsd/agent/
mkdir -p "$HOME/.gsd"
create_symlink "GSD-WORKFLOW.md" "$AGENT_WORKFLOW" "$WORKFLOW_SRC"

echo ""
echo "✅ Symlinks created!"
echo ""
echo "📝 Now changes to:"
echo "   • src/resources/extensions/*"
echo "   • src/resources/skills/*"
echo "   • src/resources/agents/*"
echo "   • src/resources/GSD-WORKFLOW.md"
echo ""
echo "  Will be reflected immediately in ~/.gsd/agent/"
echo ""
echo "🚀 Run 'node dist/loader.js' to start GSD"
echo ""
echo "💡 To remove symlinks: ./scripts/dev-symlink.sh --remove"
echo "💡 To check status: ./scripts/dev-symlink.sh --status"
