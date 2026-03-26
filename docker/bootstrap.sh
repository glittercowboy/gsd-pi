#!/bin/bash
set -e

# ──────────────────────────────────────────────
# GSD First-Boot Bootstrap
#
# Runs once on initial container creation.
# Called by entrypoint.sh as the gsd user.
#
# This script is idempotent — safe to run multiple
# times, but the sentinel in entrypoint.sh ensures
# it only runs once in practice.
# ──────────────────────────────────────────────

# ── Git Identity ────────────────────────────────────────
# Without this, git commits inside the container will fail
# or use garbage defaults.

if [ -n "${GIT_AUTHOR_NAME}" ]; then
    git config --global user.name "${GIT_AUTHOR_NAME}"
fi

if [ -n "${GIT_AUTHOR_EMAIL}" ]; then
    git config --global user.email "${GIT_AUTHOR_EMAIL}"
fi

echo "Bootstrap complete."
