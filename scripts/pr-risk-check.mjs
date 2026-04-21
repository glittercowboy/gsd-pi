#!/usr/bin/env node

/**
 * PR Risk Checker — classifies changed files by system and outputs a risk report.
 *
 * Usage:
 *   node scripts/pr-risk-check.mjs                      # auto-detect changed files vs main
 *   node scripts/pr-risk-check.mjs --base <branch>      # compare against a specific base
 *   node scripts/pr-risk-check.mjs --files a.ts,b.ts    # explicit file list
 *   echo "src/cli.ts" | node scripts/pr-risk-check.mjs  # pipe files via stdin
 *   node scripts/pr-risk-check.mjs --json               # JSON output
 *   node scripts/pr-risk-check.mjs --github             # GitHub Actions summary output
 */

import { readFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createInterface } from 'readline';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const MAP_PATH = resolve(REPO_ROOT, 'docs/dev/FILE-SYSTEM-MAP.md');

// ---------------------------------------------------------------------------
// Risk tier definitions
// ---------------------------------------------------------------------------

const RISK_TIERS = {
  critical: [
    'State Machine', 'Agent Core', 'Auth/OAuth', 'Permissions',
    'Auto Engine', 'MCP Server/Client', 'Native/Rust Tools',
  ],
  high: [
    'GSD Workflow', 'Tool System', 'AI Providers', 'Extension Registry',
    'Session Management', 'Extensions', 'Modes', 'Event System',
    'Node.js Bindings', 'Compaction',
  ],
  medium: [
    'Web UI', 'Web Mode', 'TUI Components', 'CLI', 'Commands', 'Worktree',
    'API Routes', 'Doctor/Diagnostics', 'LSP', 'Model System',
    'Subagent', 'Browser Tools', 'Bg Shell', 'Async Jobs', 'TTSR',
  ],
  low: [
    'Build System', 'Skills', 'Integration Tests', 'Config', 'Migration',
    'Onboarding', 'Memory Extension', 'Studio App', 'VS Code Extension',
    'Voice', 'CMux', 'Mac Tools', 'Universal Config', 'Remote Questions',
    'Search the Web', 'Google Search', 'Context7', 'Slash Commands',
    'File Search', 'Syntax Highlighting', 'Text Processing', 'Image Processing',
    'AST', 'Loader/Bootstrap',
  ],
};

const TIER_ORDER = ['critical', 'high', 'medium', 'low'];

const TIER_EMOJI = {
  critical: '🔴',
  high:     '🟠',
  medium:   '🟡',
  low:      '🟢',
};

// Maps each system label to the specific verification task a reviewer/agent should perform.
const SYSTEM_CHECKS = {
  'State Machine':     'test state persistence across a session restart',
  'Agent Core':        'check for race conditions and loop exit paths in the agent loop',
  'Auth/OAuth':        'verify auth token lifecycle (create, refresh, revoke)',
  'Permissions':       'audit permission escalation paths and boundary enforcement',
  'Auto Engine':       'validate auto-mode trigger conditions and loop termination',
  'MCP Server/Client': 'confirm no breaking changes to RPC/MCP protocol compatibility',
  'Native/Rust Tools': 'run native tool smoke tests and check FFI boundary safety',
  'GSD Workflow':      'verify GSD workflow state transitions end-to-end',
  'Tool System':       'verify tool call and response contracts are unchanged',
  'AI Providers':      'confirm provider API contract and error handling are intact',
  'Extension Registry':'check extension registration and lifecycle hooks',
  'Session Management':'test session creation, restoration, and teardown',
  'Extensions':        'verify extension event dispatch and hook ordering',
  'Modes':             'test mode switching transitions and state isolation',
  'Event System':      'confirm event emission ordering and listener cleanup',
  'Node.js Bindings':  'run Node.js native binding smoke tests',
  'Compaction':        'verify compaction does not drop or corrupt context',
};

/**
 * Builds a single copy-paste prompt for a coding agent based on the actual
 * flagged systems in this PR. Returns null if no actionable systems are found.
 */
function buildAgentPrompt(systemRisks) {
  const relevant = systemRisks.filter(({ tier }) => tier === 'critical' || tier === 'high');
  const checks = relevant.map(({ system }) => SYSTEM_CHECKS[system]).filter(Boolean);
  if (checks.length === 0) return null;

  const systemNames = relevant.map(({ system }) => system).join(', ');
  const checkList = checks.map((c, i) => `${i + 1}) ${c}`).join('; ');
  return `Review this PR for risks in: ${systemNames}. Verify: ${checkList}. Report all findings before I merge.`;
}

// ---------------------------------------------------------------------------
// Parse FILE-SYSTEM-MAP.md
// ---------------------------------------------------------------------------

/**
 * Returns a Map<normalizedPathPattern, string[]> of systems.
 * Patterns ending in /* are treated as prefix matches.
 */
function parseMap(mapPath) {
  if (!existsSync(mapPath)) {
    throw new Error(`FILE-SYSTEM-MAP.md not found at ${mapPath}`);
  }

  const lines = readFileSync(mapPath, 'utf8').split('\n');
  const entries = [];

  for (const line of lines) {
    // Only process table rows with at least 3 pipe-separated columns
    if (!line.startsWith('|')) continue;
    const cols = line.split('|').map(c => c.trim()).filter(Boolean);
    if (cols.length < 2) continue;
    // Skip header and separator rows
    if (cols[0].startsWith('-') || cols[0].toLowerCase() === 'file' ||
        cols[0].toLowerCase() === 'file path' || cols[0].toLowerCase() === 'skill directory' ||
        cols[0].toLowerCase() === 'file / directory' || cols[0].toLowerCase() === 'system') continue;

    const rawPath = cols[0];
    const rawSystems = cols[1] || '';

    // Skip bold section headers like **GSD Extension (Core Workflow Engine)**
    if (rawPath.startsWith('**') || rawPath === '') continue;

    // Clean up path — remove parenthetical notes like "(50+ files)"
    const cleanPath = rawPath.replace(/\s*\(.*?\)/g, '').trim();
    if (!cleanPath || cleanPath.startsWith('-')) continue;

    // Parse systems — comma or pipe separated
    const systems = rawSystems
      .split(/[,|]/)
      .map(s => s.trim())
      .filter(Boolean)
      .filter(s => !s.startsWith('-') && s !== 'System Label(s)');

    if (systems.length === 0) continue;

    entries.push({ pattern: cleanPath, systems });
  }

  return entries;
}

/**
 * Normalize a file path to a repo-relative path for matching.
 */
function normalizePath(filePath) {
  return filePath
    .replace(/^\.\//, '')
    .replace(/\\/g, '/');
}

/**
 * Check if a changed file matches a map entry pattern.
 * Supports:
 *   - Exact suffix match:  src/cli.ts  matches  src/cli.ts
 *   - Glob prefix match:   gsd/auto/*  matches  gsd/auto/anything.ts
 *   - Wildcard extension:  *.tsx       matches  any .tsx
 */
function fileMatchesPattern(filePath, pattern) {
  const file = normalizePath(filePath);
  const pat = normalizePath(pattern);

  // Glob prefix: ends with /*  or  /**
  if (pat.endsWith('/*') || pat.endsWith('/**')) {
    const prefix = pat.replace(/\/\*+$/, '/');
    return file.includes(prefix);
  }

  // Wildcard extension: *.ext
  if (pat.startsWith('*.')) {
    return file.endsWith(pat.slice(1));
  }

  // Exact suffix match (map paths are relative, git paths may include root prefix)
  return file === pat || file.endsWith('/' + pat) || pat.endsWith('/' + file);
}

/**
 * Given a list of changed files and map entries, return matched systems.
 */
function classifyFiles(changedFiles, mapEntries) {
  const systemsPerFile = new Map();
  const unmatchedFiles = [];

  for (const file of changedFiles) {
    const matched = new Set();
    for (const entry of mapEntries) {
      if (fileMatchesPattern(file, entry.pattern)) {
        entry.systems.forEach(s => matched.add(s));
      }
    }
    if (matched.size > 0) {
      systemsPerFile.set(file, [...matched]);
    } else {
      unmatchedFiles.push(file);
    }
  }

  return { systemsPerFile, unmatchedFiles };
}

/**
 * Get the risk tier for a system label.
 */
function tierForSystem(system) {
  for (const tier of TIER_ORDER) {
    if (RISK_TIERS[tier].some(s => system.includes(s) || s.includes(system))) {
      return tier;
    }
  }
  return 'low';
}

/**
 * Aggregate overall risk from a set of system labels.
 */
function overallRisk(allSystems) {
  let worst = 'low';
  for (const system of allSystems) {
    const tier = tierForSystem(system);
    if (TIER_ORDER.indexOf(tier) < TIER_ORDER.indexOf(worst)) {
      worst = tier;
    }
  }
  return worst;
}

// ---------------------------------------------------------------------------
// Collect changed files
// ---------------------------------------------------------------------------

async function getChangedFilesFromStdin() {
  return new Promise(resolve => {
    const lines = [];
    const rl = createInterface({ input: process.stdin, terminal: false });
    rl.on('line', line => { if (line.trim()) lines.push(line.trim()); });
    rl.on('close', () => resolve(lines));
  });
}

function getChangedFilesFromGit(base = 'main') {
  try {
    const output = execSync(
      `git diff --name-only ${base}...HEAD`,
      { cwd: REPO_ROOT, encoding: 'utf8' }
    );
    return output.trim().split('\n').filter(Boolean);
  } catch {
    // Fallback: compare staged + unstaged changes
    try {
      const output = execSync(
        'git diff --name-only HEAD',
        { cwd: REPO_ROOT, encoding: 'utf8' }
      );
      return output.trim().split('\n').filter(Boolean);
    } catch {
      return [];
    }
  }
}

// ---------------------------------------------------------------------------
// Render output
// ---------------------------------------------------------------------------

function renderConsole(report) {
  const { changedFiles, systemsPerFile, unmatchedFiles, systemRisks, risk } = report;

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(' GSD2 PR Risk Report');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  console.log(`Overall Risk: ${TIER_EMOJI[risk]} ${risk.toUpperCase()}`);
  console.log(`Files changed: ${changedFiles.length}  |  Systems affected: ${systemRisks.length}\n`);

  if (systemRisks.length > 0) {
    console.log('Affected Systems:');
    for (const { system, tier } of systemRisks) {
      console.log(`  ${TIER_EMOJI[tier]} ${system}`);
    }
    console.log('');
  }

  if (systemsPerFile.size > 0) {
    console.log('File Breakdown:');
    for (const [file, systems] of systemsPerFile) {
      const tier = overallRisk(systems);
      console.log(`  ${TIER_EMOJI[tier]} ${file}`);
      console.log(`     → ${systems.join(', ')}`);
    }
    console.log('');
  }

  if (unmatchedFiles.length > 0) {
    console.log(`Unclassified files (${unmatchedFiles.length}):`);
    unmatchedFiles.forEach(f => console.log(`  ⚪ ${f}`));
    console.log('');
  }

  // Reviewer checklist
  if (risk === 'critical' || risk === 'high') {
    const label = risk === 'critical' ? 'CRITICAL' : 'HIGH-risk';
    console.log(`⚠️  Reviewer checklist for ${label} changes:`);
    for (const { system } of systemRisks.filter(r => r.tier === 'critical' || r.tier === 'high')) {
      const check = SYSTEM_CHECKS[system];
      if (check) console.log(`  • [${system}] ${check}`);
    }
    const prompt = buildAgentPrompt(systemRisks);
    if (prompt) {
      console.log('');
      console.log('  Ask your coding agent before submitting:');
      console.log(`  "${prompt}"`);
      console.log('');
      console.log('  Have a Codex subscription? Run: codex review --adversarial');
    }
  }

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
}

function renderGitHubSummary(report) {
  const { changedFiles, systemsPerFile, unmatchedFiles, systemRisks, risk } = report;

  const lines = [];
  lines.push(`## ${TIER_EMOJI[risk]} PR Risk Report — ${risk.toUpperCase()}`);
  lines.push('');
  lines.push(`| | |`);
  lines.push(`|---|---|`);
  lines.push(`| **Files changed** | ${changedFiles.length} |`);
  lines.push(`| **Systems affected** | ${systemRisks.length} |`);
  lines.push(`| **Overall risk** | ${TIER_EMOJI[risk]} ${risk.toUpperCase()} |`);
  lines.push('');

  if (systemRisks.length > 0) {
    lines.push('### Affected Systems');
    lines.push('');
    lines.push('| Risk | System |');
    lines.push('|------|--------|');
    for (const { system, tier } of systemRisks) {
      lines.push(`| ${TIER_EMOJI[tier]} ${tier} | ${system} |`);
    }
    lines.push('');
  }

  if (systemsPerFile.size > 0) {
    lines.push('<details>');
    lines.push('<summary>File Breakdown</summary>');
    lines.push('');
    lines.push('| Risk | File | Systems |');
    lines.push('|------|------|---------|');
    for (const [file, systems] of systemsPerFile) {
      const tier = overallRisk(systems);
      lines.push(`| ${TIER_EMOJI[tier]} | \`${file}\` | ${systems.join(', ')} |`);
    }
    if (unmatchedFiles.length > 0) {
      for (const file of unmatchedFiles) {
        lines.push(`| ⚪ | \`${file}\` | *(unclassified)* |`);
      }
    }
    lines.push('');
    lines.push('</details>');
    lines.push('');
  }

  if (risk === 'critical' || risk === 'high') {
    const label = risk === 'critical' ? '🔴 Critical' : '🟠 High';
    const flagged = systemRisks.filter(r => r.tier === 'critical' || r.tier === 'high');
    lines.push(`> ⚠️ **${label} risk** — the following systems require verification before merge:`);
    lines.push('>');
    for (const { system, tier } of flagged) {
      const check = SYSTEM_CHECKS[system];
      if (check) lines.push(`> - ${TIER_EMOJI[tier]} **${system}**: ${check}`);
    }
    const relevant = flagged.filter(({ system }) => SYSTEM_CHECKS[system]);
    if (relevant.length > 0) {
      const systemNames = relevant.map(({ system }) => system).join(', ');
      lines.push('>');
      lines.push('> **⛔ This PR should not be merged without executing this follow-up prompt.**');
      lines.push('>');
      lines.push('> **Ask your coding agent to verify before submitting:**');
      lines.push('>');
      lines.push('> ```');
      lines.push(`> Review this PR for risks in: ${systemNames}. Verify:`);
      lines.push('>');
      relevant.forEach(({ system }, i) => {
        lines.push(`> ${i + 1}. ${SYSTEM_CHECKS[system]}`);
      });
      lines.push('>');
      lines.push('> Before modifying any code, assess the scope of this fix:');
      lines.push('>');
      lines.push('> - Identify the root cause, not just the reported symptom.');
      lines.push('> - Search the codebase for other call sites, similar patterns, or duplicated logic that may share the same bug.');
      lines.push('> - List affected tests, documentation, and any downstream consumers that depend on the current behavior.');
      lines.push('> - Flag any changes that extend beyond the immediate file or function.');
      lines.push('>');
      lines.push('> Report findings first. Then propose a fix scoped to the actual root cause, and wait for confirmation before applying changes outside the originally reported location.');
      lines.push('> ```');
      lines.push('>');
      lines.push('> 💡 **Have a Codex subscription?** Get an independent second opinion: `codex review --adversarial`');
    }
  }

  return lines.join('\n');
}

function buildReport({ changedFiles, systemsPerFile, unmatchedFiles }) {
  // Aggregate all systems
  const allSystems = new Set();
  for (const systems of systemsPerFile.values()) {
    systems.forEach(s => allSystems.add(s));
  }

  // Build system → tier list, sorted by risk
  const systemRisks = [...allSystems]
    .map(system => ({ system, tier: tierForSystem(system) }))
    .sort((a, b) => TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier));

  const risk = overallRisk(allSystems);

  return { changedFiles, systemsPerFile, unmatchedFiles, systemRisks, risk };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const isJson = args.includes('--json');
  const isGitHub = args.includes('--github');

  // Collect changed files
  let changedFiles;

  const filesIdx = args.indexOf('--files');
  if (filesIdx !== -1 && args[filesIdx + 1]) {
    changedFiles = args[filesIdx + 1].split(',').map(f => f.trim()).filter(Boolean);
  } else if (!process.stdin.isTTY) {
    changedFiles = await getChangedFilesFromStdin();
  } else {
    const baseIdx = args.indexOf('--base');
    const base = baseIdx !== -1 && args[baseIdx + 1] ? args[baseIdx + 1] : 'main';
    changedFiles = getChangedFilesFromGit(base);
  }

  if (changedFiles.length === 0) {
    console.log('No changed files detected.');
    process.exit(0);
  }

  // Load and parse map
  const mapEntries = parseMap(MAP_PATH);

  // Classify
  const { systemsPerFile, unmatchedFiles } = classifyFiles(changedFiles, mapEntries);
  const report = buildReport({ changedFiles, systemsPerFile, unmatchedFiles });

  // Output
  if (isJson) {
    console.log(JSON.stringify({
      risk: report.risk,
      filesChanged: report.changedFiles.length,
      systemsAffected: report.systemRisks,
      fileBreakdown: Object.fromEntries(report.systemsPerFile),
      unclassified: report.unmatchedFiles,
    }, null, 2));
  } else if (isGitHub) {
    const summary = renderGitHubSummary(report);
    // Write to GitHub step summary if available
    if (process.env.GITHUB_STEP_SUMMARY) {
      const { appendFileSync } = await import('fs');
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary + '\n');
    }
    // Also output the summary markdown for use in PR comments
    console.log(summary);
  } else {
    renderConsole(report);
  }

  // Exit with non-zero for critical so CI can gate on it if desired
  if (report.risk === 'critical') {
    process.exitCode = 2;
  } else if (report.risk === 'high') {
    process.exitCode = 1;
  }
}

main().catch(err => {
  console.error('pr-risk-check error:', err.message);
  process.exit(1);
});
