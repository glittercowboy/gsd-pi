/**
 * GSD Changelog — Fetch and display categorized release notes from GitHub
 *
 * Fetches releases from the gsd-build/gsd-2 GitHub repository,
 * prompts the user for a version filter, and sends raw release notes
 * into the conversation for the LLM to summarize.
 *
 * Entry point: handleChangelog() called from commands.ts
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@gsd/pi-coding-agent";

// ─── Types ────────────────────────────────────────────────────────────────────

interface GitHubRelease {
  tag_name: string;
  name: string;
  body: string;
}

// ─── Semver comparison ────────────────────────────────────────────────────────

function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const va = pa[i] || 0;
    const vb = pb[i] || 0;
    if (va > vb) return 1;
    if (va < vb) return -1;
  }
  return 0;
}

function stripV(tag: string): string {
  return tag.startsWith("v") ? tag.slice(1) : tag;
}

// ─── Body parsing ─────────────────────────────────────────────────────────────

interface CategorySection {
  heading: string;
  content: string;
}

function parseReleaseBody(body: string): CategorySection[] {
  if (!body) return [];

  const sections: CategorySection[] = [];
  const lines = body.split("\n");
  let currentHeading: string | null = null;
  let currentLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith("### ")) {
      if (currentHeading !== null) {
        const content = currentLines.join("\n").trim();
        if (content) {
          sections.push({ heading: currentHeading, content });
        }
      }
      currentHeading = line.slice(4).trim();
      currentLines = [];
    } else if (currentHeading !== null) {
      currentLines.push(line);
    }
  }

  if (currentHeading !== null) {
    const content = currentLines.join("\n").trim();
    if (content) {
      sections.push({ heading: currentHeading, content });
    }
  }

  return sections;
}

// ─── Display formatting ──────────────────────────────────────────────────────

function formatRelease(release: GitHubRelease): string {
  const version = stripV(release.tag_name);
  const title = release.name || `v${version}`;
  const sections = parseReleaseBody(release.body);

  const parts: string[] = [`## ${title}`];

  if (sections.length === 0) {
    if (release.body?.trim()) {
      parts.push(release.body.trim());
    } else {
      parts.push("_No release notes._");
    }
  } else {
    for (const section of sections) {
      parts.push(`### ${section.heading}`);
      parts.push(section.content);
    }
  }

  return parts.join("\n\n");
}

// ─── Entry Point ──────────────────────────────────────────────────────────────

const RELEASES_URL = "https://api.github.com/repos/gsd-build/gsd-2/releases?per_page=100";

export async function handleChangelog(
  args: string,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
): Promise<void> {
  // ── Fetch releases ──────────────────────────────────────────────────────
  let releases: GitHubRelease[];
  try {
    const response = await fetch(RELEASES_URL, {
      headers: { "User-Agent": "gsd-changelog" },
    });

    if (!response.ok) {
      ctx.ui.notify(
        `Failed to fetch changelog: GitHub API returned ${response.status} ${response.statusText}`,
        "error",
      );
      return;
    }

    releases = (await response.json()) as GitHubRelease[];
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.ui.notify(`Failed to fetch changelog: ${message}`, "error");
    return;
  }

  if (!releases.length) {
    ctx.ui.notify("No releases found in the repository.", "warning");
    return;
  }

  // ── Determine version filter ────────────────────────────────────────────
  const currentVersion = process.env.GSD_VERSION || "";
  let sinceVersion: string | undefined;
  let showCurrentOnly = false;

  if (args.trim()) {
    sinceVersion = stripV(args.trim());
  } else {
    const input = await ctx.ui.input(
      "Show changes since version:",
      currentVersion || "latest",
    );

    if (input === undefined) {
      return;
    }

    if (input.trim() === "") {
      showCurrentOnly = true;
    } else {
      sinceVersion = stripV(input.trim());
    }
  }

  // ── Filter releases ─────────────────────────────────────────────────────
  let matched: GitHubRelease[];

  if (showCurrentOnly) {
    if (!currentVersion) {
      ctx.ui.notify(
        "GSD_VERSION is not set — cannot determine current release. Provide a version instead.",
        "warning",
      );
      return;
    }
    const found = releases.find((r) => stripV(r.tag_name) === currentVersion);
    if (!found) {
      ctx.ui.notify(`No release found matching current version v${currentVersion}`, "warning");
      return;
    }
    matched = [found];
  } else if (sinceVersion) {
    matched = releases
      .filter((r) => compareSemver(stripV(r.tag_name), sinceVersion!) > 0)
      .sort((a, b) => compareSemver(stripV(b.tag_name), stripV(a.tag_name)));

    if (!matched.length) {
      ctx.ui.notify(`No releases found since v${sinceVersion}`, "warning");
      return;
    }
  } else {
    matched = [releases[0]];
  }

  // ── Send to LLM for summarization ───────────────────────────────────────
  const rawOutput = matched.map(formatRelease).join("\n\n---\n\n");
  const versionRange = sinceVersion
    ? `since v${sinceVersion} (${matched.length} release${matched.length === 1 ? "" : "s"})`
    : `for current release ${matched[0].name || matched[0].tag_name}`;

  const prompt = [
    `Here are the raw GSD changelog entries ${versionRange}.`,
    "Summarize the most important changes — group by category (Added, Changed, Fixed, etc.),",
    "keep only the most impactful items (max 5 per category), skip trivial changes,",
    "and include the version where each item appeared. Keep it concise and scannable.",
    "",
    rawOutput,
  ].join("\n");

  pi.sendMessage(
    { customType: "gsd-changelog", content: prompt, display: true },
    { triggerTurn: true },
  );
}
