# ──────────────────────────────────────────────
# Runtime
# Image: ghcr.io/gsd-build/gsd-pi
# Used by: end users via docker run
# ──────────────────────────────────────────────
FROM node:24-slim

# Git is required for GSD's git operations
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    && rm -rf /var/lib/apt/lists/*

# Install GSD globally — version is controlled by the build arg
ARG GSD_VERSION=latest
RUN npm install -g gsd-pi@${GSD_VERSION}

# Default working directory for user projects
WORKDIR /workspace

ENTRYPOINT ["gsd"]
CMD ["--help"]
