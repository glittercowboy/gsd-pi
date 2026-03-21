/**
 * Prompt Ordering Optimizer — reorders assembled prompt sections
 * to maximize cache prefix stability.
 *
 * Identifies sections by markdown heading patterns and rearranges
 * them so stable content appears first. Anthropic caches the last
 * user message by prefix match, so placing static/semi-static
 * content before dynamic content improves cache hit rates.
 */

/** Section extracted from a prompt by heading markers */
export interface ExtractedSection {
  heading: string;
  content: string;
  role: "static" | "semi-static" | "dynamic";
}

/**
 * Known heading to role mappings for GSD prompts.
 * Static: templates, executor constraints, system instructions
 * Semi-static: slice plan, decisions, requirements, prior summaries, overrides
 * Dynamic: task plan, resume state, carry-forward, verification
 */
const HEADING_ROLES: Record<string, "static" | "semi-static" | "dynamic"> = {
  // Static — never changes per task
  "Output Template": "static",
  "Executor Context Constraints": "static",
  "Working Directory": "static",
  "Backing Source Artifacts": "static",

  // Semi-static — changes per slice but not per task
  "Slice Plan Excerpt": "semi-static",
  "Decisions": "semi-static",
  "Requirements": "semi-static",
  "Prior Task Summaries": "semi-static",
  "Overrides": "semi-static",
  "Project Knowledge": "semi-static",
  "Dependency Summaries": "semi-static",
  "Context Manifest": "semi-static",

  // Dynamic — changes per task
  "Inlined Task Plan": "dynamic",
  "Resume State": "dynamic",
  "Carry-Forward Context": "dynamic",
  "Verification": "dynamic",
  "Verification Evidence": "dynamic",
};

/**
 * Extract the heading text from a line like "## Some Heading" or "## UNIT: Execute Task ...".
 * Returns the full text after "## " for role lookup.
 */
function extractHeadingText(line: string): string {
  return line.replace(/^##\s+/, "").trim();
}

/**
 * Classify a heading by matching against known roles.
 * Uses substring matching so headings like "## UNIT: Execute Task T1.1" don't match
 * but "## Inlined Task Plan" does. Unknown headings default to "dynamic".
 */
function classifyHeading(heading: string): "static" | "semi-static" | "dynamic" {
  for (const [key, role] of Object.entries(HEADING_ROLES)) {
    if (heading === key || heading.startsWith(key)) {
      return role;
    }
  }
  return "dynamic";
}

/**
 * Split a prompt into sections at ## heading boundaries.
 * Sub-headings (### and deeper) stay with their parent ## section.
 * Returns a preamble (content before first ##) and an array of sections.
 */
function splitSections(prompt: string): { preamble: string; sections: ExtractedSection[] } {
  const lines = prompt.split("\n");
  let preamble = "";
  const sections: ExtractedSection[] = [];
  let currentHeading = "";
  let currentContent: string[] = [];

  for (const line of lines) {
    // Match ## headings but NOT ### or deeper
    if (/^## (?!#)/.test(line)) {
      // Flush previous section
      if (currentHeading) {
        sections.push({
          heading: currentHeading,
          content: currentContent.join("\n"),
          role: classifyHeading(currentHeading),
        });
      } else if (currentContent.length > 0) {
        preamble = currentContent.join("\n");
      }
      currentHeading = extractHeadingText(line);
      currentContent = [line];
    } else {
      currentContent.push(line);
    }
  }

  // Flush last section
  if (currentHeading) {
    sections.push({
      heading: currentHeading,
      content: currentContent.join("\n"),
      role: classifyHeading(currentHeading),
    });
  } else if (currentContent.length > 0) {
    preamble = currentContent.join("\n");
  }

  return { preamble, sections };
}

const ROLE_ORDER: Record<string, number> = {
  "static": 0,
  "semi-static": 1,
  "dynamic": 2,
};

/**
 * Reorder a prompt's sections for cache efficiency.
 * Extracts sections by ## heading markers, classifies them,
 * and reorders: static -> semi-static -> dynamic.
 *
 * Content before the first ## heading is treated as a preamble
 * and always placed first (it's usually static instructions).
 *
 * @param prompt The assembled prompt string
 * @returns Reordered prompt string
 */
export function reorderForCaching(prompt: string): string {
  const { preamble, sections } = splitSections(prompt);

  // Nothing to reorder
  if (sections.length <= 1) {
    return prompt;
  }

  // Stable sort: sections with the same role keep their original relative order
  const sorted = [...sections].sort((a, b) => {
    return ROLE_ORDER[a.role] - ROLE_ORDER[b.role];
  });

  const parts: string[] = [];
  if (preamble) {
    parts.push(preamble);
  }
  for (const section of sorted) {
    parts.push(section.content);
  }

  return parts.join("\n");
}

/**
 * Analyze a prompt's cache efficiency without reordering.
 * Returns stats about how much of the prompt is cacheable.
 */
export function analyzeCacheEfficiency(prompt: string): {
  totalChars: number;
  staticChars: number;
  semiStaticChars: number;
  dynamicChars: number;
  cacheEfficiency: number;
} {
  const { preamble, sections } = splitSections(prompt);

  let staticChars = preamble.length;
  let semiStaticChars = 0;
  let dynamicChars = 0;

  for (const section of sections) {
    switch (section.role) {
      case "static":
        staticChars += section.content.length;
        break;
      case "semi-static":
        semiStaticChars += section.content.length;
        break;
      case "dynamic":
        dynamicChars += section.content.length;
        break;
    }
  }

  const totalChars = staticChars + semiStaticChars + dynamicChars;
  const cacheEfficiency = totalChars > 0
    ? (staticChars + semiStaticChars) / totalChars
    : 0;

  return {
    totalChars,
    staticChars,
    semiStaticChars,
    dynamicChars,
    cacheEfficiency,
  };
}
