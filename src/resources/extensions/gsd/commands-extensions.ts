/**
 * GSD Extensions Command — /gsd extensions
 *
 * Manage the extension registry: list, enable, disable, info, install.
 * Self-contained — no imports outside the extensions tree (extensions are loaded
 * via jiti at runtime from ~/.gsd/agent/, not compiled by tsc).
 */

import type { ExtensionCommandContext } from "@gsd/pi-coding-agent";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { lockSync, unlockSync } from "proper-lockfile";
import semver from "semver";

const gsdHome = process.env.GSD_HOME || join(homedir(), ".gsd");

// ─── Types (mirrored from extension-registry.ts) ────────────────────────────

interface ExtensionManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  tier: "core" | "bundled" | "community";
  requires: { platform: string };
  provides?: {
    tools?: string[];
    commands?: string[];
    hooks?: string[];
    shortcuts?: string[];
  };
  dependencies?: {
    extensions?: string[];
    runtime?: string[];
  };
}

interface ExtensionRegistryEntry {
  id: string;
  enabled: boolean;
  source: "bundled" | "user" | "project";
  disabledAt?: string;
  disabledReason?: string;
  version?: string;
  installedFrom?: string;
  installType?: "npm" | "git" | "local";
}

interface ExtensionRegistry {
  version: 1;
  entries: Record<string, ExtensionRegistryEntry>;
}

// ─── Registry I/O ───────────────────────────────────────────────────────────

function getRegistryPath(): string {
  return join(gsdHome, "extensions", "registry.json");
}

function getAgentExtensionsDir(): string {
  return join(gsdHome, "agent", "extensions");
}

function loadRegistry(): ExtensionRegistry {
  const filePath = getRegistryPath();
  try {
    if (!existsSync(filePath)) return { version: 1, entries: {} };
    const raw = readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && parsed.version === 1 && typeof parsed.entries === "object") {
      return parsed as ExtensionRegistry;
    }
    return { version: 1, entries: {} };
  } catch {
    return { version: 1, entries: {} };
  }
}

function saveRegistry(registry: ExtensionRegistry): void {
  const filePath = getRegistryPath();
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    const tmp = filePath + ".tmp";
    writeFileSync(tmp, JSON.stringify(registry, null, 2), "utf-8");
    renameSync(tmp, filePath);
  } catch { /* non-fatal */ }
}

/**
 * Run a registry load → mutate → save transaction under a cross-process lock.
 * Prevents two concurrent `gsd extensions install/uninstall/update` invocations
 * from trampling each other's registry mutations.
 *
 * Uses proper-lockfile.lockSync against the registry path. Directory is created
 * first so locking works on fresh installs. Lock is always released via finally.
 */
function withRegistryLock<T>(mutate: (registry: ExtensionRegistry) => T): T {
  const filePath = getRegistryPath();
  mkdirSync(dirname(filePath), { recursive: true });
  // lockSync requires the file to exist — ensure it does before acquiring.
  if (!existsSync(filePath)) {
    writeFileSync(filePath, JSON.stringify({ version: 1, entries: {} }, null, 2), "utf-8");
  }
  lockSync(filePath, { retries: { retries: 5, minTimeout: 50, maxTimeout: 500 } });
  try {
    const registry = loadRegistry();
    const result = mutate(registry);
    saveRegistry(registry);
    return result;
  } finally {
    try { unlockSync(filePath); } catch { /* lock may already be gone */ }
  }
}

function isEnabled(registry: ExtensionRegistry, id: string): boolean {
  const entry = registry.entries[id];
  if (!entry) return true;
  return entry.enabled;
}

function readManifest(dir: string): ExtensionManifest | null {
  const mPath = join(dir, "extension-manifest.json");
  if (!existsSync(mPath)) return null;
  try {
    const raw = JSON.parse(readFileSync(mPath, "utf-8"));
    if (typeof raw?.id === "string" && typeof raw?.name === "string") return raw as ExtensionManifest;
    return null;
  } catch {
    return null;
  }
}

// ─── Package Validation (mirrored — D-14, no src/ imports) ────────────────

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export function validateExtensionPackage(packageDir: string): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Check package.json exists
  const pkgPath = join(packageDir, "package.json");
  if (!existsSync(pkgPath)) {
    return { valid: false, errors: ["package.json not found"], warnings };
  }

  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
  } catch {
    return { valid: false, errors: ["package.json is invalid JSON"], warnings };
  }

  // (a) gsd.extension: true marker (D-12a)
  const gsdField = pkg.gsd as Record<string, unknown> | undefined;
  if (gsdField?.extension !== true) {
    errors.push('package.json missing "gsd": { "extension": true }');
  }

  // (b) pi.extensions entry paths exist and are resolvable (D-12b)
  const piField = pkg.pi as Record<string, unknown> | undefined;
  const piExtensions = piField?.extensions;
  if (!Array.isArray(piExtensions) || piExtensions.length === 0) {
    errors.push('package.json missing "pi": { "extensions": [...] }');
  } else {
    for (const entry of piExtensions) {
      if (typeof entry === "string") {
        const resolved = join(packageDir, entry);
        if (!existsSync(resolved)) {
          errors.push(`pi.extensions entry not found: ${entry}`);
        }
      }
    }
  }

  // (c) @gsd/* packages must be in peerDependencies, not dependencies/devDependencies (D-12c)
  // Mirrors validateExtensionManifest below and extension-validator.ts:checkDependencyPlacement.
  for (const field of ["dependencies", "devDependencies"] as const) {
    const deps = (pkg[field] as Record<string, unknown> | undefined) ?? {};
    for (const dep of Object.keys(deps)) {
      if (dep.startsWith("@gsd/")) {
        errors.push(`"${dep}" must be in peerDependencies, not ${field}`);
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

function discoverManifests(): Map<string, ExtensionManifest> {
  const manifests = new Map<string, ExtensionManifest>();
  // Scan both bundled/agent dir and user-installed dir so CLI (list/info/
  // enable/disable) sees the same set the loader will merge at runtime.
  // Bundled entries are scanned first so user-installed IDs override on collision.
  const dirs = [getAgentExtensionsDir(), getInstalledExtDir()];
  for (const extDir of dirs) {
    if (!existsSync(extDir)) continue;
    for (const entry of readdirSync(extDir, { withFileTypes: true })) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const m = readManifest(join(extDir, entry.name));
      if (m) manifests.set(m.id, m);
    }
  }
  return manifests;
}

function getInstalledExtDir(): string {
  return join(gsdHome, "extensions");
}

// Source: derived from npm/git URL conventions (from RESEARCH.md)
function detectInstallType(specifier: string): "npm" | "git" | "local" {
  if (
    specifier.startsWith("/") ||
    specifier.startsWith("./") ||
    specifier.startsWith("../") ||
    specifier.startsWith("~/")
  ) return "local";
  if (
    specifier.startsWith("git+") ||
    specifier.startsWith("git://") ||
    specifier.startsWith("github:") ||
    specifier.startsWith("gitlab:") ||
    specifier.startsWith("bitbucket:") ||
    (specifier.startsWith("https://") && specifier.endsWith(".git")) ||
    (specifier.startsWith("http://") && specifier.endsWith(".git"))
  ) return "git";
  return "npm";
}

// ─── Manifest Validation (mirrored from extension-validator.ts) ─────────────
// Note: distinct from validateExtensionPackage above (which validates a package
// directory on disk and returns string errors). This one validates an already-
// parsed package.json object and returns structured errors, used by install.

interface ManifestValidationError {
  code: string;
  message: string;
  field?: string;
}

interface ManifestValidationResult {
  valid: boolean;
  errors: ManifestValidationError[];
}

function validateExtensionManifest(pkg: unknown, opts: { extensionId?: string; allowGsdNamespace?: boolean } = {}): ManifestValidationResult {
  const errors: ManifestValidationError[] = [];

  // Check gsd.extension === true (strict)
  if (typeof pkg !== "object" || pkg === null) {
    errors.push({ code: "MISSING_GSD_MARKER", message: 'package.json must declare "gsd": { "extension": true } to be recognized as a GSD extension.', field: "gsd.extension" });
  } else {
    const obj = pkg as Record<string, unknown>;
    const gsd = obj.gsd;
    if (typeof gsd !== "object" || gsd === null || (gsd as Record<string, unknown>).extension !== true) {
      errors.push({ code: "MISSING_GSD_MARKER", message: 'package.json must declare "gsd": { "extension": true } to be recognized as a GSD extension.', field: "gsd.extension" });
    }
  }

  // Check namespace reservation
  if (opts.extensionId && opts.extensionId.startsWith("gsd.") && opts.allowGsdNamespace !== true) {
    errors.push({ code: "RESERVED_NAMESPACE", message: `Extension ID "${opts.extensionId}" is reserved for GSD core extensions. Use a different namespace for community extensions.`, field: "extensionId" });
  }

  // Check dependency placement
  if (typeof pkg === "object" && pkg !== null) {
    const obj = pkg as Record<string, unknown>;
    for (const field of ["dependencies", "devDependencies"] as const) {
      const deps = obj[field];
      if (typeof deps === "object" && deps !== null) {
        for (const pkgName of Object.keys(deps as Record<string, unknown>)) {
          if (pkgName.startsWith("@gsd/")) {
            errors.push({ code: "WRONG_DEP_FIELD", message: `"${pkgName}" must not appear in "${field}". Move it to "peerDependencies".`, field });
          }
        }
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

// ─── Post-install convergence ────────────────────────────────────────────────

/**
 * Allowed characters for an extension id when used as a path segment.
 * Rejects anything that could enable traversal or escape (slashes, "..", backslashes).
 */
const SAFE_EXTENSION_ID_RE = /^[A-Za-z0-9._-]+$/;

function isSafeExtensionId(id: string): boolean {
  if (!id || id === "." || id === "..") return false;
  if (id.includes("/") || id.includes("\\") || id.includes("..")) return false;
  return SAFE_EXTENSION_ID_RE.test(id);
}

/**
 * Post-install convergence: validate package and read manifest.
 * Returns the (validated) extension ID and manifest on success, or null on failure.
 * Caller is responsible for writing the registry entry *after* the final commit
 * rename succeeds so a failed move doesn't leave a dangling registry entry.
 */
function postInstallValidate(
  destPath: string,
  specifier: string,
  ctx: ExtensionCommandContext,
): { id: string; manifest: ExtensionManifest } | null {
  // Read package.json
  const pkgJsonPath = join(destPath, "package.json");
  if (!existsSync(pkgJsonPath)) {
    ctx.ui.notify(`Cannot install "${specifier}": no package.json found.`, "error");
    return null;
  }
  let pkgJson: Record<string, unknown>;
  try {
    pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf-8"));
  } catch {
    ctx.ui.notify(`Cannot install "${specifier}": malformed package.json.`, "error");
    return null;
  }

  // Read extension-manifest.json for the ID
  const manifest = readManifest(destPath);
  const extensionId = manifest?.id;

  // Validate
  const validation = validateExtensionManifest(pkgJson, { extensionId });
  if (!validation.valid) {
    const msgs = validation.errors.map(e => e.message).join("\n");
    ctx.ui.notify(`Cannot install "${specifier}": ${msgs}`, "error");
    return null;
  }

  if (!manifest || !extensionId) {
    ctx.ui.notify(`Cannot install "${specifier}": no extension-manifest.json with valid id found.`, "error");
    return null;
  }

  // The id from the manifest is used as a path segment under installedExtDir.
  // Reject unsafe ids before the caller performs any path joins.
  if (!isSafeExtensionId(extensionId)) {
    ctx.ui.notify(
      `Cannot install "${specifier}": extension id "${extensionId}" contains unsafe characters (allowed: alphanumerics, ".", "-", "_").`,
      "error",
    );
    return null;
  }

  return { id: extensionId, manifest };
}

/**
 * Write the registry entry for a freshly-installed extension. Called after the
 * final destination commit succeeds so a failed rename can't leave a stale entry.
 */
function writeInstalledRegistryEntry(
  id: string,
  manifest: ExtensionManifest,
  specifier: string,
  installType: "npm" | "git" | "local",
): void {
  withRegistryLock((registry) => {
    registry.entries[id] = {
      id,
      enabled: true,
      source: "user",
      version: manifest.version,
      installedFrom: specifier,
      installType,
    };
  });
}

// ─── Uninstall helpers ───────────────────────────────────────────────────────

/**
 * Scan installed extensions to find which ones depend on the target ID.
 * Used for dependency warning on uninstall (D-06).
 */
function findDependents(targetId: string, installedExtDir: string): string[] {
  const dependents: string[] = [];
  if (!existsSync(installedExtDir)) return dependents;
  for (const entry of readdirSync(installedExtDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifest = readManifest(join(installedExtDir, entry.name));
    if (!manifest) continue;
    if (manifest.dependencies?.extensions?.includes(targetId)) {
      dependents.push(manifest.id);
    }
  }
  return dependents;
}

function handleUninstall(id: string | undefined, ctx: ExtensionCommandContext): void {
  if (!id) {
    ctx.ui.notify("Usage: /gsd extensions uninstall <id>", "warning");
    return;
  }

  // Hold the registry lock for the entire uninstall transaction so a concurrent
  // install can't add or re-enable `id` while we're in the middle of removing it.
  const result = withRegistryLock((registry) => {
    const entry = registry.entries[id];

    // Check if extension exists and is user-installed
    if (!entry || entry.source !== "user") {
      return { ok: false as const, reason: "not-found" as const };
    }

    const installedExtDir = getInstalledExtDir();
    const extDir = join(installedExtDir, id);

    // Check for dependents and warn (D-06: warn-then-proceed)
    const dependents = findDependents(id, installedExtDir);

    // Remove directory first, then registry entry (Pitfall 4 from RESEARCH.md)
    // If rm fails, do NOT remove registry entry — leaves a recoverable state
    try {
      if (existsSync(extDir)) {
        rmSync(extDir, { recursive: true, force: true });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false as const, reason: "rm-failed" as const, msg };
    }

    // Remove registry entry (D-07)
    delete registry.entries[id];
    return { ok: true as const, dependents };
  });

  if (!result.ok) {
    if (result.reason === "not-found") {
      ctx.ui.notify(
        `Extension "${id}" not found in registry. Run /gsd extensions list to see installed extensions.`,
        "warning",
      );
    } else if (result.reason === "rm-failed") {
      ctx.ui.notify(`Failed to remove extension directory for "${id}": ${result.msg}`, "error");
    }
    return;
  }

  if (result.dependents.length > 0) {
    ctx.ui.notify(
      `Warning: the following installed extensions depend on "${id}": ${result.dependents.join(", ")}. Removed anyway.`,
      "warning",
    );
  }
  ctx.ui.notify(`Uninstalled "${id}". Restart GSD to deactivate.`, "info");
}

// ─── Update subcommand ───────────────────────────────────────────────────────

async function getLatestNpmVersion(packageName: string): Promise<string | null> {
  try {
    const res = await fetch(`https://registry.npmjs.org/${packageName}/latest`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const data = await res.json() as { version?: string };
    return data.version ?? null;
  } catch {
    return null;
  }
}

async function handleUpdate(id: string | undefined, ctx: ExtensionCommandContext): Promise<void> {
  const registry = loadRegistry();

  if (id) {
    // Update single extension (D-12)
    await updateSingleExtension(id, registry, ctx);
  } else {
    // Update all installed extensions (D-11)
    await updateAllExtensions(registry, ctx);
  }
}

async function updateSingleExtension(
  id: string,
  registry: ExtensionRegistry,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const entry = registry.entries[id];

  if (!entry || entry.source !== "user") {
    ctx.ui.notify(
      `Extension "${id}" not found in registry. Run /gsd extensions list to see installed extensions.`,
      "warning",
    );
    return;
  }

  // Git and local installs: "reinstall to update" hint (D-10, D-12)
  if (entry.installType !== "npm") {
    const source = entry.installType ?? "unknown";
    const hint = entry.installedFrom ? `gsd extensions install ${entry.installedFrom}` : `gsd extensions install <specifier>`;
    ctx.ui.notify(
      `"${id}" was installed from ${source}. Reinstall to update: ${hint}`,
      "warning",
    );
    return;
  }

  // npm extension: check for newer version (D-09)
  const current = entry.version ?? "0.0.0";
  const specifier = entry.installedFrom;
  if (!specifier) {
    ctx.ui.notify(`"${id}" has no recorded install source. Reinstall manually.`, "warning");
    return;
  }

  // Split npm specifier into name + optional pin.
  // Scoped (`@scope/name[@version]`) vs unscoped (`name[@version]`).
  const { name: packageName, pin } = parseNpmSpecifier(specifier);

  // Pinned installs: the user explicitly requested a specific version. Don't
  // silently upgrade past the pin — tell them to re-install with a new pin.
  if (pin) {
    ctx.ui.notify(
      `"${id}" was installed with a pinned version (${pin}). To update, run: gsd extensions install ${packageName}@<new-version>`,
      "info",
    );
    return;
  }

  const latest = await getLatestNpmVersion(packageName);
  if (!latest) {
    ctx.ui.notify(`Could not fetch latest version for "${id}".`, "warning");
    return;
  }

  if (semver.gt(latest, current)) {
    ctx.ui.notify(`Updating "${id}": v${current} → v${latest}...`, "info");
    await handleInstall(packageName, ctx);
  } else {
    ctx.ui.notify(`"${id}" is already at the latest version (v${current}).`, "info");
  }
}

/**
 * Parse an npm specifier into its package name and optional version pin.
 * Handles scoped (`@scope/name[@version]`) and unscoped (`name[@version]`).
 */
function parseNpmSpecifier(specifier: string): { name: string; pin: string | null } {
  const isScoped = specifier.startsWith("@");
  const searchFrom = isScoped ? specifier.indexOf("/") + 1 : 0;
  const atIdx = specifier.indexOf("@", searchFrom);
  if (atIdx === -1) return { name: specifier, pin: null };
  return { name: specifier.slice(0, atIdx), pin: specifier.slice(atIdx + 1) };
}

async function updateAllExtensions(
  registry: ExtensionRegistry,
  ctx: ExtensionCommandContext,
): Promise<void> {
  // Find all user-installed extensions
  const userEntries = Object.values(registry.entries).filter(e => e.source === "user");

  if (userEntries.length === 0) {
    ctx.ui.notify("No user-installed extensions found. Use: gsd extensions install <package> to add one.", "warning");
    return;
  }

  ctx.ui.notify(`Checking ${userEntries.length} installed extension(s) for updates...`, "info");

  let updated = 0;
  let skipped = 0;

  for (const entry of userEntries) {
    // Skip non-npm installs (D-11)
    if (entry.installType !== "npm") {
      const source = entry.installType ?? "unknown";
      ctx.ui.notify(`  ${entry.id}: installed from ${source} — reinstall to update`, "info");
      skipped++;
      continue;
    }

    const current = entry.version ?? "0.0.0";
    const packageName = entry.installedFrom;
    if (!packageName) {
      ctx.ui.notify(`  ${entry.id}: no recorded install source — skip`, "info");
      skipped++;
      continue;
    }

    const latest = await getLatestNpmVersion(packageName);
    if (!latest) {
      ctx.ui.notify(`  ${entry.id}: could not fetch latest version — skip`, "info");
      skipped++;
      continue;
    }

    if (semver.gt(latest, current)) {
      ctx.ui.notify(`  ${entry.id}: v${current} → v${latest} (updating)`, "info");
      await handleInstall(packageName, ctx);
      updated++;
    } else {
      ctx.ui.notify(`  ${entry.id}: v${current} (already up to date)`, "info");
    }
  }

  ctx.ui.notify(`Updated ${updated} extension(s). ${skipped} skipped (git/local — reinstall to update).`, "info");
}

// ─── Install subcommand ──────────────────────────────────────────────────────

async function handleInstall(specifier: string | undefined, ctx: ExtensionCommandContext): Promise<void> {
  if (!specifier) {
    ctx.ui.notify("Usage: /gsd extensions install <npm-package|git-url|local-path>", "warning");
    return;
  }

  const installType = detectInstallType(specifier);
  const installedExtDir = getInstalledExtDir();
  mkdirSync(installedExtDir, { recursive: true });

  process.stderr.write(`Installing ${specifier}...\n`);

  if (installType === "npm") {
    installFromNpm(specifier, installedExtDir, ctx);
  } else if (installType === "git") {
    installFromGit(specifier, installedExtDir, ctx);
  } else {
    installFromLocal(specifier, installedExtDir, ctx);
  }
}

function installFromNpm(specifier: string, installedExtDir: string, ctx: ExtensionCommandContext): void {
  // packDir holds the tarball in tmpdir(). The *extractDir* is staged inside
  // installedExtDir so the final renameSync to destPath stays on a single
  // filesystem (avoids EXDEV when tmpdir() and ~/.gsd live on different mounts).
  const packDir = mkdtempSync(join(tmpdir(), "gsd-install-"));
  let extractDir: string | null = null;
  try {
    // Step 1: npm pack to tmpdir (D-01, D-05)
    execFileSync("npm", ["pack", specifier, "--pack-destination", packDir, "--ignore-scripts"], {
      stdio: "pipe",
      encoding: "utf-8",
    });

    // Step 2: Find the tarball
    const tgzFile = readdirSync(packDir).find(f => f.endsWith(".tgz"));
    if (!tgzFile) throw new Error("npm pack produced no tarball");

    // Step 3: Extract via tar into a staging dir *inside* installedExtDir
    extractDir = mkdtempSync(join(installedExtDir, "tmp-npm-"));
    execFileSync("tar", ["xzf", join(packDir, tgzFile), "-C", extractDir, "--strip-components=1"], { stdio: "pipe" });

    // Step 4: Validate and get extension ID
    const validated = postInstallValidate(extractDir, specifier, ctx);
    if (!validated) {
      return; // Error already notified
    }

    // Step 5: Move to final destination — same filesystem as extractDir
    const destPath = join(installedExtDir, validated.id);
    if (existsSync(destPath)) {
      rmSync(destPath, { recursive: true, force: true });
    }
    renameSync(extractDir, destPath);
    extractDir = null; // Successfully moved; skip cleanup

    // Step 6: Commit the registry entry only after the rename succeeds.
    writeInstalledRegistryEntry(validated.id, validated.manifest, specifier, "npm");
    ctx.ui.notify(`Installed "${validated.id}" v${validated.manifest.version ?? "unknown"}. Restart GSD to activate.`, "info");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.ui.notify(`Failed to install "${specifier}": ${msg}`, "error");
  } finally {
    if (extractDir && existsSync(extractDir)) {
      try { rmSync(extractDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
    rmSync(packDir, { recursive: true, force: true });
  }
}

function installFromGit(gitUrl: string, installedExtDir: string, ctx: ExtensionCommandContext): void {
  // Clone into temp dir, validate, then rename to real ID (D-02)
  const tmpDir = join(installedExtDir, `__installing-${Date.now()}`);
  try {
    execFileSync("git", ["clone", "--depth=1", gitUrl, tmpDir], { stdio: "pipe" });

    // Remove .git directory — not needed after clone
    const dotGit = join(tmpDir, ".git");
    if (existsSync(dotGit)) {
      rmSync(dotGit, { recursive: true, force: true });
    }

    const validated = postInstallValidate(tmpDir, gitUrl, ctx);
    if (!validated) {
      rmSync(tmpDir, { recursive: true, force: true });
      return;
    }

    const destPath = join(installedExtDir, validated.id);
    if (existsSync(destPath)) {
      rmSync(destPath, { recursive: true, force: true });
    }
    renameSync(tmpDir, destPath);

    writeInstalledRegistryEntry(validated.id, validated.manifest, gitUrl, "git");
    ctx.ui.notify(`Installed "${validated.id}" v${validated.manifest.version ?? "unknown"}. Restart GSD to activate.`, "info");
  } catch (err) {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
    const msg = err instanceof Error ? err.message : String(err);
    ctx.ui.notify(`Failed to install "${gitUrl}": ${msg}`, "error");
  }
}

function installFromLocal(localPath: string, installedExtDir: string, ctx: ExtensionCommandContext): void {
  // Resolve path and copy (not symlink) per D-03
  const sourcePath = resolve(localPath.startsWith("~/") ? join(homedir(), localPath.slice(2)) : localPath);

  if (!existsSync(sourcePath)) {
    ctx.ui.notify(`Cannot install "${localPath}": path does not exist.`, "error");
    return;
  }

  // Copy to temp dir first, validate, then rename
  const tmpDir = join(installedExtDir, `__installing-${Date.now()}`);
  try {
    cpSync(sourcePath, tmpDir, { recursive: true });

    const validated = postInstallValidate(tmpDir, localPath, ctx);
    if (!validated) {
      rmSync(tmpDir, { recursive: true, force: true });
      return;
    }

    const destPath = join(installedExtDir, validated.id);
    if (existsSync(destPath)) {
      rmSync(destPath, { recursive: true, force: true });
    }
    renameSync(tmpDir, destPath);

    writeInstalledRegistryEntry(validated.id, validated.manifest, localPath, "local");
    ctx.ui.notify(`Installed "${validated.id}" v${validated.manifest.version ?? "unknown"}. Restart GSD to activate.`, "info");
  } catch (err) {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
    const msg = err instanceof Error ? err.message : String(err);
    ctx.ui.notify(`Failed to install "${localPath}": ${msg}`, "error");
  }
}

// ─── Command Handler ────────────────────────────────────────────────────────

export async function handleExtensions(args: string, ctx: ExtensionCommandContext): Promise<void> {
  const parts = args.split(/\s+/).filter(Boolean);
  const subCmd = parts[0] ?? "list";

  if (subCmd === "list") {
    handleList(ctx);
    return;
  }

  if (subCmd === "enable") {
    handleEnable(parts[1], ctx);
    return;
  }

  if (subCmd === "disable") {
    handleDisable(parts[1], parts.slice(2).join(" "), ctx);
    return;
  }

  if (subCmd === "info") {
    handleInfo(parts[1], ctx);
    return;
  }

  if (subCmd === "install") {
    await handleInstall(parts[1], ctx);
    return;
  }

  if (subCmd === "uninstall") {
    handleUninstall(parts[1], ctx);
    return;
  }

  if (subCmd === "update") {
    await handleUpdate(parts[1], ctx);
    return;
  }

  if (subCmd === "validate") {
    handleValidate(parts[1], ctx);
    return;
  }

  ctx.ui.notify(
    `Unknown: /gsd extensions ${subCmd}. Usage: /gsd extensions [list|enable|disable|info|install|uninstall|update|validate]`,
    "warning",
  );
}

function handleList(ctx: ExtensionCommandContext): void {
  const manifests = discoverManifests();
  const registry = loadRegistry();

  if (manifests.size === 0) {
    ctx.ui.notify("No extension manifests found.", "warning");
    return;
  }

  // Sort: core first, then alphabetical
  const sorted = [...manifests.values()].sort((a, b) => {
    if (a.tier === "core" && b.tier !== "core") return -1;
    if (b.tier === "core" && a.tier !== "core") return 1;
    return a.id.localeCompare(b.id);
  });

  const lines: string[] = [];
  const hdr = padRight("Extensions", 38) + padRight("Status", 10) + padRight("Tier", 10) + padRight("Tools", 7) + "Commands";
  lines.push(hdr);
  lines.push("─".repeat(hdr.length));

  for (const m of sorted) {
    const enabled = isEnabled(registry, m.id);
    const status = enabled ? "enabled" : "disabled";
    const toolCount = m.provides?.tools?.length ?? 0;
    const cmdCount = m.provides?.commands?.length ?? 0;
    const label = `${m.id} (${m.name})`;

    lines.push(
      padRight(label, 38) +
      padRight(status, 10) +
      padRight(m.tier, 10) +
      padRight(String(toolCount), 7) +
      String(cmdCount),
    );

    // Show source indicator and install info for user-installed extensions
    const regEntry = registry.entries[m.id];
    if (regEntry?.source === "user") {
      // Append [user] tag to the last line
      const lastLine = lines[lines.length - 1];
      lines[lines.length - 1] = lastLine + "      [user]";
      if (regEntry.installedFrom) {
        const typePrefix = regEntry.installType ? `${regEntry.installType}:` : "";
        const versionSuffix = regEntry.version ? `@${regEntry.version}` : "";
        lines.push(`  installed from: ${typePrefix}${regEntry.installedFrom}${versionSuffix}`);
      }
    }

    if (!enabled) {
      lines.push(`  ↳ gsd extensions enable ${m.id}`);
    }
  }

  ctx.ui.notify(lines.join("\n"), "info");
}

function handleEnable(id: string | undefined, ctx: ExtensionCommandContext): void {
  if (!id) {
    ctx.ui.notify("Usage: /gsd extensions enable <id>", "warning");
    return;
  }

  const manifests = discoverManifests();
  if (!manifests.has(id)) {
    ctx.ui.notify(`Extension "${id}" not found. Run /gsd extensions list to see available extensions.`, "warning");
    return;
  }

  const alreadyEnabled = withRegistryLock((registry) => {
    if (isEnabled(registry, id)) return true;
    const entry = registry.entries[id];
    if (entry) {
      entry.enabled = true;
      delete entry.disabledAt;
      delete entry.disabledReason;
    } else {
      registry.entries[id] = { id, enabled: true, source: "bundled" };
    }
    return false;
  });
  if (alreadyEnabled) {
    ctx.ui.notify(`Extension "${id}" is already enabled.`, "info");
    return;
  }
  ctx.ui.notify(`Enabled "${id}". Restart GSD to activate.`, "info");
}

function handleDisable(id: string | undefined, reason: string, ctx: ExtensionCommandContext): void {
  if (!id) {
    ctx.ui.notify("Usage: /gsd extensions disable <id>", "warning");
    return;
  }

  const manifests = discoverManifests();
  const manifest = manifests.get(id) ?? null;

  if (!manifests.has(id)) {
    ctx.ui.notify(`Extension "${id}" not found. Run /gsd extensions list to see available extensions.`, "warning");
    return;
  }

  if (manifest?.tier === "core") {
    ctx.ui.notify(`Cannot disable "${id}" — it is a core extension.`, "warning");
    return;
  }

  const alreadyDisabled = withRegistryLock((registry) => {
    if (!isEnabled(registry, id)) return true;
    const entry = registry.entries[id];
    if (entry) {
      entry.enabled = false;
      entry.disabledAt = new Date().toISOString();
      entry.disabledReason = reason || undefined;
    } else {
      registry.entries[id] = {
        id,
        enabled: false,
        source: "bundled",
        disabledAt: new Date().toISOString(),
        disabledReason: reason || undefined,
      };
    }
    return false;
  });
  if (alreadyDisabled) {
    ctx.ui.notify(`Extension "${id}" is already disabled.`, "info");
    return;
  }
  ctx.ui.notify(`Disabled "${id}". Restart GSD to deactivate.`, "info");
}

function handleInfo(id: string | undefined, ctx: ExtensionCommandContext): void {
  if (!id) {
    ctx.ui.notify("Usage: /gsd extensions info <id>", "warning");
    return;
  }

  const manifests = discoverManifests();
  const manifest = manifests.get(id);
  if (!manifest) {
    ctx.ui.notify(`Extension "${id}" not found.`, "warning");
    return;
  }

  const registry = loadRegistry();
  const enabled = isEnabled(registry, id);
  const entry = registry.entries[id];

  const lines: string[] = [
    `${manifest.name} (${manifest.id})`,
    "",
    `  Version:     ${manifest.version}`,
    `  Description: ${manifest.description}`,
    `  Tier:        ${manifest.tier}`,
    `  Status:      ${enabled ? "enabled" : "disabled"}`,
  ];

  if (entry?.disabledAt) {
    lines.push(`  Disabled at: ${entry.disabledAt}`);
  }
  if (entry?.disabledReason) {
    lines.push(`  Reason:      ${entry.disabledReason}`);
  }

  // Phase 8 fields for user-installed extensions (per UI-SPEC)
  if (entry?.source === "user") {
    if (entry.installedFrom) {
      lines.push(`  Installed from: ${entry.installedFrom}`);
    }
    if (entry.installType) {
      lines.push(`  Install type:   ${entry.installType}`);
    }
  }

  if (manifest.provides) {
    lines.push("");
    lines.push("  Provides:");
    if (manifest.provides.tools?.length) {
      lines.push(`    Tools:     ${manifest.provides.tools.join(", ")}`);
    }
    if (manifest.provides.commands?.length) {
      lines.push(`    Commands:  ${manifest.provides.commands.join(", ")}`);
    }
    if (manifest.provides.hooks?.length) {
      lines.push(`    Hooks:     ${manifest.provides.hooks.join(", ")}`);
    }
    if (manifest.provides.shortcuts?.length) {
      lines.push(`    Shortcuts: ${manifest.provides.shortcuts.join(", ")}`);
    }
  }

  if (manifest.dependencies) {
    lines.push("");
    lines.push("  Dependencies:");
    if (manifest.dependencies.extensions?.length) {
      lines.push(`    Extensions: ${manifest.dependencies.extensions.join(", ")}`);
    }
    if (manifest.dependencies.runtime?.length) {
      lines.push(`    Runtime:    ${manifest.dependencies.runtime.join(", ")}`);
    }
  }

  ctx.ui.notify(lines.join("\n"), "info");
}

function handleValidate(path: string | undefined, ctx: ExtensionCommandContext): void {
  if (!path) {
    ctx.ui.notify("Usage: /gsd extensions validate <path>", "warning");
    return;
  }
  const resolved = resolve(path);
  if (!existsSync(resolved)) {
    ctx.ui.notify(`Path not found: ${resolved}`, "warning");
    return;
  }
  const result = validateExtensionPackage(resolved);
  if (result.valid) {
    ctx.ui.notify(`Valid extension package: ${resolved}`, "info");
  } else {
    ctx.ui.notify(
      `Invalid extension package: ${resolved}\n` +
      result.errors.map(e => `  - ${e}`).join("\n"),
      "warning",
    );
  }
}

function padRight(str: string, len: number): string {
  return str.length >= len ? str + " " : str + " ".repeat(len - str.length);
}
