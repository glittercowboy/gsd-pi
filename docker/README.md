# GSD Docker Sandbox

Run GSD auto mode inside an isolated Docker sandbox so it cannot touch your host filesystem, SSH keys, or other projects.

## Prerequisites

- Docker Desktop 4.58+ (macOS or Windows; Linux support is experimental)
- At least one LLM provider API key

## Docker Images

| File | Purpose |
|------|---------|
| `Dockerfile.sandbox` | Runtime sandbox with entrypoint (UID remapping, bootstrap) |
| `Dockerfile.ci-builder` | CI builds — includes build tools, no entrypoint magic |

## Compose Files

| File | Purpose |
|------|---------|
| `docker-compose.yaml` | Minimal zero-config setup — just works with sensible defaults |
| `docker-compose.full.yaml` | Fully documented reference with all options, resource limits, health checks |

Start with `docker-compose.yaml`. Copy options from `docker-compose.full.yaml` when you need them.

## Quick Start

### Option A: Docker Sandbox CLI (recommended)

Docker Sandboxes provide MicroVM isolation — each sandbox runs in a lightweight VM with its own kernel and private Docker daemon.

```bash
# Create a sandbox from the template
docker sandbox create --template ./docker --name gsd-sandbox

# Shell into the sandbox
docker sandbox exec -it gsd-sandbox bash

# Inside the sandbox, run GSD
gsd auto "implement the feature described in issue #42"
```

### Option B: Docker Compose

For environments without Docker Sandbox support, use Compose for container-level isolation:

```bash
# 1. Configure API keys
cp docker/.env.example docker/.env
# Edit docker/.env with your keys

# 2. Start the sandbox
docker compose -f docker/docker-compose.yaml up -d

# 3. Shell into the container
docker exec -it gsd-sandbox bash

# 4. Run GSD inside the container
gsd auto "implement the feature described in issue #42"
```

## UID/GID Remapping

The entrypoint handles UID/GID remapping via `PUID` and `PGID` environment variables. This avoids permission issues on bind-mounted volumes by matching the container's `gsd` user to your host UID/GID.

```bash
# Find your host UID/GID
id -u  # PUID
id -g  # PGID
```

Set these in your `.env` file or in the `environment` section of the compose file. Defaults to `1000:1000`.

## Entrypoint Behavior

The container entrypoint (`entrypoint.sh`) runs four steps on every start:

1. **UID/GID remapping** — adjusts the `gsd` user to match `PUID`/`PGID`
2. **Pre-create critical files** — prevents Docker bind-mount from creating directories where files are expected
3. **Sentinel-based bootstrap** — runs `bootstrap.sh` exactly once on first boot
4. **Drop privileges** — `exec gosu gsd` for proper PID 1 signal forwarding

No hardcoded `user:` directive in compose — the entrypoint starts as root, remaps, then drops to `gsd`.

## Two-Terminal Workflow

GSD's recommended workflow uses two terminals — one for auto mode, one for interactive discussion:

```bash
# Terminal 1: auto mode
docker sandbox exec -it gsd-sandbox bash
gsd auto "your task description"

# Terminal 2: discuss / monitor
docker sandbox exec -it gsd-sandbox bash
gsd discuss
```

With Docker Compose, replace `docker sandbox exec` with `docker exec`.

## Credential Injection

### Docker Sandbox (automatic)

Docker's proxy layer forwards API keys set in your host shell config (`~/.bashrc`, `~/.zshrc`) into the sandbox automatically. Keys are never stored inside the sandbox.

### Docker Compose (manual)

Copy `docker/.env.example` to `docker/.env` and fill in your keys. The `.env` file is gitignored and never committed.

## Network Allowlisting

If you restrict outbound network access in your sandbox, GSD needs these endpoints:

| Purpose | Endpoints |
|---------|-----------|
| LLM APIs | `api.anthropic.com`, `api.openai.com`, `generativelanguage.googleapis.com`, `openrouter.ai` |
| Package registry | `registry.npmjs.org` |
| Research tools | `api.search.brave.com`, `api.tavily.com`, `r.jina.ai` |
| GitHub | `api.github.com`, `github.com` |

## Customizing the Image

Build with a specific GSD version:

```bash
docker compose -f docker/docker-compose.yaml build --build-arg GSD_VERSION=2.51.0
```

## Cleanup

```bash
# Docker Sandbox
docker sandbox rm gsd-sandbox

# Docker Compose
docker compose -f docker/docker-compose.yaml down -v
```

## Known Limitations

- **macOS/Windows only**: Docker Sandboxes require Docker Desktop 4.58+. Linux sandbox support is experimental.
- **Environment parity**: The sandbox runs Ubuntu (Debian). macOS-only dependencies may not work inside the sandbox.
- **Named agent registration**: Docker Desktop's built-in named agents (claude, codex, etc.) are registered by Docker itself. Third-party tools cannot register new named agents. GSD uses the generic shell sandbox type with a custom template instead.
