# ──────────────────────────────────────────────
# Stage 1: CI Builder
# Image: ghcr.io/gsd-build/gsd-ci-builder
# Used by: pipeline.yml Dev stage
# ──────────────────────────────────────────────
FROM node:24-bookworm AS builder

# Rust toolchain (stable, minimal profile)
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable --profile minimal
ENV PATH="/root/.cargo/bin:${PATH}"

# Cross-compilation for linux-arm64
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc-aarch64-linux-gnu \
    g++-aarch64-linux-gnu \
    && rustup target add aarch64-unknown-linux-gnu \
    && rm -rf /var/lib/apt/lists/*

# Verify toolchain
RUN node --version && rustc --version && cargo --version

# ──────────────────────────────────────────────
# Stage 2: Runtime
# Image: ghcr.io/gsd-build/gsd-pi
# Used by: end users via docker run
# ──────────────────────────────────────────────
FROM node:24-slim AS runtime

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
