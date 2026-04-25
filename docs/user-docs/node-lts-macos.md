# Pinning Node.js LTS on macOS with Homebrew

If you installed Node.js via Homebrew (`brew install node`), you're tracking the **latest current release** — which can include odd-numbered development versions (e.g. 23.x, 25.x). These aren't LTS and may have breaking changes or instability.

GSD requires Node.js **v22 or later** and works best on an **LTS (even-numbered) release**. This guide shows how to pin Node 24 LTS using Homebrew.

## Check your current version

```bash
node --version
```

If this shows an odd number (e.g. `v23.x`, `v25.x`), you're on a development release.

## Install Node 24 LTS

Homebrew provides versioned formulas for LTS releases:

```bash
# Unlink the current (possibly non-LTS) version
brew unlink node

# Install Node 24 LTS
brew install node@24

# Link it as the default
brew link --overwrite node@24
```

Verify:

```bash
node --version
# Should show v24.x.x
```

## Why pin to LTS?

- **Stability** — LTS releases receive bug fixes and security patches for 30 months
- **Compatibility** — npm packages (including GSD) test against LTS versions
- **No surprises** — `brew upgrade` won't jump you to an unstable development release

## Prevent accidental upgrades

By default, `brew upgrade` will upgrade all packages, which could move you off the pinned version. Pin the formula:

```bash
brew pin node@24
```

To unpin later:

```bash
brew unpin node@24
```

## Switching between versions

If you need multiple Node versions (e.g. 22 and 24), consider using a version manager instead:

- **[nvm](https://github.com/nvm-sh/nvm)** — `nvm install 24 && nvm use 24`
- **[fnm](https://github.com/Schniz/fnm)** — `fnm install 24 && fnm use 24` (faster, Rust-based)
- **[mise](https://mise.jdx.dev/)** — `mise use node@24` (polyglot version manager)

These let you set per-project Node versions via `.node-version` or `.nvmrc` files.

## Verify GSD works

After pinning:

```bash
node --version   # v24.x.x
npm install -g gsd-pi
gsd --version
```
