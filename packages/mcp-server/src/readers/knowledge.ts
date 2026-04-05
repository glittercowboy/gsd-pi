/**
 * gsd_knowledge — project knowledge base (rules, patterns, lessons).
 */

import { join } from 'node:path';
import { gsdDir, readFileSafe } from './shared.js';

interface KnowledgeEntry {
  section: string;
  text: string;
}

interface KnowledgeResult {
  entries: KnowledgeEntry[];
  raw: string | null;
}

export async function readKnowledge(projectDir: string): Promise<KnowledgeResult> {
  const base = gsdDir(projectDir);
  const content = await readFileSafe(join(base, 'KNOWLEDGE.md'));
  if (!content) return { entries: [], raw: null };

  const entries: KnowledgeEntry[] = [];
  let currentSection = 'General';

  for (const line of content.split('\n')) {
    const headerMatch = line.match(/^##\s+(.+)/);
    if (headerMatch) {
      currentSection = headerMatch[1].trim();
      continue;
    }

    const bulletMatch = line.match(/^[-*]\s+(.+)/);
    if (bulletMatch) {
      entries.push({ section: currentSection, text: bulletMatch[1].trim() });
    }
  }

  return { entries, raw: content };
}
