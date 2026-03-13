import type { RoadmapSliceEntry, RiskLevel } from "./types.ts";

function extractSlicesSection(content: string): string {
  const headingMatch = /^## Slices\s*$/m.exec(content);
  if (!headingMatch || headingMatch.index == null) return "";

  const start = headingMatch.index + headingMatch[0].length;
  const rest = content.slice(start).replace(/^\r?\n/, "");
  const nextHeading = /^##\s+/m.exec(rest);
  return (nextHeading ? rest.slice(0, nextHeading.index) : rest).trimEnd();
}

export function parseRoadmapSlices(content: string): RoadmapSliceEntry[] {
  const slicesSection = extractSlicesSection(content);
  const slices: RoadmapSliceEntry[] = [];
  if (!slicesSection) return slices;

  const checkboxItems = slicesSection.split("\n");
  let currentSlice: RoadmapSliceEntry | null = null;

  for (const line of checkboxItems) {
    const cbMatch = line.match(/^\s*-\s+\[([ xX])\]\s+\*\*(\w+):\s+(.+?)\*\*\s*(.*)/);
    if (cbMatch) {
      if (currentSlice) slices.push(currentSlice);

      const done = cbMatch[1].toLowerCase() === "x";
      const id = cbMatch[2]!;
      const title = cbMatch[3]!;
      const rest = cbMatch[4] ?? "";

      const riskMatch = rest.match(/`risk:(\w+)`/);
      const risk = (riskMatch ? riskMatch[1] : "low") as RiskLevel;

      const depsMatch = rest.match(/`depends:\[([^\]]*)\]`/);
      const depends = depsMatch && depsMatch[1]!.trim()
        ? depsMatch[1]!.split(",").map(s => s.trim())
        : [];

      currentSlice = { id, title, risk, depends, done, demo: "" };
      continue;
    }

    if (currentSlice && line.trim().startsWith(">")) {
      currentSlice.demo = line.trim().replace(/^>\s*/, "").replace(/^After this:\s*/i, "");
    }
  }

  if (currentSlice) slices.push(currentSlice);
  return slices;
}
