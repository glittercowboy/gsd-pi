#!/bin/bash
set -e

# ──────────────────────────────────────────────
# GSD Container Entrypoint
#
# Responsibilities:
#   1. UID/GID remapping — match host user via PUID/PGID
#   2. Pre-create critical files — prevent Docker bind-mount
#      from creating directories where files are expected
#   3. Sentinel-based bootstrap — one-time first-boot setup
#   4. Signal forwarding — exec into the final process
# ──────────────────────────────────────────────

GSD_USER="gsd"
GSD_HOME="/home/${GSD_USER}"
GSD_DIR="${GSD_HOME}/.gsd"

# ── 1. UID/GID Remapping ────────────────────────────────
# Accept PUID/PGID from the environment so the container
# can run with the same UID/GID as the host user, avoiding
# permission headaches on bind-mounted volumes.

PUID="${PUID:-1000}"
PGID="${PGID:-1000}"

CURRENT_UID=$(id -u "${GSD_USER}")
CURRENT_GID=$(id -g "${GSD_USER}")

REMAPPED=0

if [ "${PGID}" != "${CURRENT_GID}" ]; then
    groupmod -o -g "${PGID}" "${GSD_USER}"
    REMAPPED=1
fi

if [ "${PUID}" != "${CURRENT_UID}" ]; then
    usermod -o -u "${PUID}" "${GSD_USER}"
    REMAPPED=1
fi

# Fix ownership only when UID/GID actually changed
if [ "${REMAPPED}" -eq 1 ]; then
    chown -R "${PUID}:${PGID}" "${GSD_HOME}"
    chown "${PUID}:${PGID}" /workspace
fi

# ── 2. Pre-create Critical Files ────────────────────────
# Docker bind-mounts will create a *directory* if the target
# path doesn't exist. We need these to be files, so touch
# them before Docker gets a chance to mangle things.

mkdir -p "${GSD_DIR}"

if [ ! -f "${GSD_DIR}/settings.json" ]; then
    echo '{}' > "${GSD_DIR}/settings.json"
fi

chown "${PUID}:${PGID}" "${GSD_DIR}" "${GSD_DIR}/settings.json"

# ── 3. Sentinel-based Bootstrap ─────────────────────────
# Run first-boot setup exactly once. Subsequent container
# starts (or restarts) skip this entirely.

SENTINEL="${GSD_DIR}/.bootstrapped"

if [ ! -f "${SENTINEL}" ]; then
    if [ -x /usr/local/bin/bootstrap.sh ]; then
        # Run bootstrap as the gsd user so files get correct ownership
        gosu "${GSD_USER}" /usr/local/bin/bootstrap.sh
    fi
    touch "${SENTINEL}"
    chown "${PUID}:${PGID}" "${SENTINEL}"
fi

# ── 4. Drop Privileges & Exec ──────────────────────────
# Replace this shell process with the final command running
# as the gsd user. exec + gosu = proper PID 1 = proper
# signal forwarding (SIGTERM, SIGINT, etc.).

exec gosu "${GSD_USER}" "$@"
