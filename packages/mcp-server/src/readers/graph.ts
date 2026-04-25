// GSD MCP Server — knowledge graph reader
// Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>

/**
 * Knowledge Graph for GSD projects.
 *
 * Parses .gsd/ artifacts (STATE.md, milestone ROADMAPs, slice PLANs,
 * KNOWLEDGE.md) into a graph of nodes and edges. Parse errors in any
 * single artifact are caught and never propagate — the artifact is skipped
 * and the rest of the graph is returned.
 *
 * writeGraph() is atomic: writes to graph.tmp.json then renames to graph.json.
 */

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { resolveGsdRoot, findMilestoneIds, resolveMilestoneDir, findSliceIds, resolveSliceDir } from './paths.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type NodeType =
  | 'milestone'
  | 'slice'
  | 'task'
  | 'rule'
  | 'pattern'
  | 'lesson'
  | 'concept'
  | 'decision';

export type EdgeType =
  | 'contains'
  | 'depends_on'
  | 'relates_to'
  | 'implements';

export type ConfidenceTier = 'EXTRACTED' | 'INFERRED' | 'AMBIGUOUS';

export interface GraphNode {
  id: string;
  label: string;
  type: NodeType;
  description?: string;
  confidence: ConfidenceTier;
  sourceFile?: string;
}

export interface GraphEdge {
  from: string;
  to: string;
  type: EdgeType;
  confidence: ConfidenceTier;
}

export interface KnowledgeGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  builtAt: string;
}

export interface GraphStatusResult {
  exists: boolean;
  lastBuild?: string;
  nodeCount?: number;
  edgeCount?: number;
  stale?: boolean;
  ageHours?: number;
}

export interface GraphQueryResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
  term: string;
  budget: number;
}

export interface GraphDiffResult {
  nodes: {
    added: string[];
    removed: string[];
    changed: string[];
  };
  edges: {
    added: string[];
    removed: string[];
  };
}

// ---------------------------------------------------------------------------
// Graph file paths
// ---------------------------------------------------------------------------

function graphsDir(gsdRoot: string): string {
  return join(gsdRoot, 'graphs');
}

function graphJsonPath(gsdRoot: string): string {
  return join(graphsDir(gsdRoot), 'graph.json');
}

function graphTmpPath(gsdRoot: string): string {
  return join(graphsDir(gsdRoot), 'graph.tmp.json');
}

function snapshotPath(gsdRoot: string): string {
  return join(graphsDir(gsdRoot), '.last-build-snapshot.json');
}

// ---------------------------------------------------------------------------
// Parsers — each returns nodes/edges and never throws
// ---------------------------------------------------------------------------

/**
 * Parse STATE.md for active milestone and phase concepts.
 */
function parseStateFile(gsdRoot: string, nodes: GraphNode[], _edges: GraphEdge[]): void {
  const statePath = join(gsdRoot, 'STATE.md');
  if (!existsSync(statePath)) return;

  let content: string;
  try {
    content = readFileSync(statePath, 'utf-8');
  } catch {
    return;
  }

  // Extract active milestone
  const activeMilestoneMatch = content.match(/\*\*Active Milestone:\*\*\s+([A-Z]\d+):\s+(.+)/i);
  if (activeMilestoneMatch) {
    const [, milestoneId, title] = activeMilestoneMatch;
    const id = `milestone:${milestoneId}`;
    if (!nodes.some((n) => n.id === id)) {
      nodes.push({
        id,
        label: `${milestoneId}: ${title.trim()}`,
        type: 'milestone',
        description: `Active milestone: ${milestoneId}`,
        confidence: 'EXTRACTED',
        sourceFile: 'STATE.md',
      });
    }
  }

  // Extract phase as concept
  const phaseMatch = content.match(/\*\*Phase:\*\*\s+(\S+)/i);
  if (phaseMatch) {
    const phase = phaseMatch[1].trim();
    nodes.push({
      id: `concept:phase:${phase}`,
      label: `Phase: ${phase}`,
      type: 'concept',
      confidence: 'EXTRACTED',
      sourceFile: 'STATE.md',
    });
  }
}

/**
 * Parse KNOWLEDGE.md for rules, patterns, and lessons.
 */
function parseKnowledgeFile(gsdRoot: string, nodes: GraphNode[], _edges: GraphEdge[]): void {
  const knowledgePath = join(gsdRoot, 'KNOWLEDGE.md');
  if (!existsSync(knowledgePath)) return;

  let content: string;
  try {
    content = readFileSync(knowledgePath, 'utf-8');
  } catch {
    return;
  }

  // Parse Rules table
  const rulesMatch = content.match(/## Rules\s*\n([\s\S]*?)(?=\n## |$)/i);
  if (rulesMatch) {
    for (const line of rulesMatch[1].split('\n')) {
      if (!line.includes('|')) continue;
      const cells = line.split('|').map((c) => c.trim()).filter(Boolean);
      if (cells.length < 3) continue;
      if (cells[0].startsWith('#') || cells[0].startsWith('-')) continue;
      const id = cells[0];
      if (!/^K\d+$/i.test(id)) continue;
      nodes.push({
        id: `rule:${id}`,
        label: id,
        type: 'rule',
        description: cells[2] ?? '',
        confidence: 'EXTRACTED',
        sourceFile: 'KNOWLEDGE.md',
      });
    }
  }

  // Parse Patterns table
  const patternsMatch = content.match(/## Patterns\s*\n([\s\S]*?)(?=\n## |$)/i);
  if (patternsMatch) {
    for (const line of patternsMatch[1].split('\n')) {
      if (!line.includes('|')) continue;
      const cells = line.split('|').map((c) => c.trim()).filter(Boolean);
      if (cells.length < 2) continue;
      if (cells[0].startsWith('#') || cells[0].startsWith('-')) continue;
      const id = cells[0];
      if (!/^P\d+$/i.test(id)) continue;
      nodes.push({
        id: `pattern:${id}`,
        label: id,
        type: 'pattern',
        description: cells[1] ?? '',
        confidence: 'EXTRACTED',
        sourceFile: 'KNOWLEDGE.md',
      });
    }
  }

  // Parse Lessons Learned table
  const lessonsMatch = content.match(/## Lessons Learned\s*\n([\s\S]*?)(?=\n## |$)/i);
  if (lessonsMatch) {
    for (const line of lessonsMatch[1].split('\n')) {
      if (!line.includes('|')) continue;
      const cells = line.split('|').map((c) => c.trim()).filter(Boolean);
      if (cells.length < 2) continue;
      if (cells[0].startsWith('#') || cells[0].startsWith('-')) continue;
      const id = cells[0];
      if (!/^L\d+$/i.test(id)) continue;
      nodes.push({
        id: `lesson:${id}`,
        label: id,
        type: 'lesson',
        description: cells[1] ?? '',
        confidence: 'EXTRACTED',
        sourceFile: 'KNOWLEDGE.md',
      });
    }
  }
}

/**
 * Parse milestone ROADMAP.md files for milestones and slices.
 */
function parseMilestoneFiles(
  gsdRoot: string,
  nodes: GraphNode[],
  edges: GraphEdge[],
): void {
  const milestoneIds = findMilestoneIds(gsdRoot);

  for (const milestoneId of milestoneIds) {
    try {
      parseSingleMilestone(gsdRoot, milestoneId, nodes, edges);
    } catch {
      // Skip this milestone on any error
    }
  }
}

function parseSingleMilestone(
  gsdRoot: string,
  milestoneId: string,
  nodes: GraphNode[],
  edges: GraphEdge[],
): void {
  const mDir = resolveMilestoneDir(gsdRoot, milestoneId);
  if (!mDir) return;

  const milestoneNodeId = `milestone:${milestoneId}`;

  // Try to read the roadmap file
  const roadmapPath = join(mDir, `${milestoneId}-ROADMAP.md`);
  let roadmapContent: string | null = null;
  if (existsSync(roadmapPath)) {
    try {
      roadmapContent = readFileSync(roadmapPath, 'utf-8');
    } catch {
      // Skip
    }
  }

  // Extract milestone title from roadmap
  let milestoneTitle = milestoneId;
  if (roadmapContent) {
    const titleMatch = roadmapContent.match(/^#\s+[A-Z]\d+:\s+(.+)/m);
    if (titleMatch) milestoneTitle = `${milestoneId}: ${titleMatch[1].trim()}`;
  }

  // Ensure milestone node exists
  if (!nodes.some((n) => n.id === milestoneNodeId)) {
    nodes.push({
      id: milestoneNodeId,
      label: milestoneTitle,
      type: 'milestone',
      confidence: 'EXTRACTED',
      sourceFile: roadmapContent ? `milestones/${milestoneId}/${milestoneId}-ROADMAP.md` : undefined,
    });
  }

  // Parse slices from roadmap table or filesystem
  const sliceIds = findSliceIds(gsdRoot, milestoneId);
  for (const sliceId of sliceIds) {
    try {
      parseSingleSlice(gsdRoot, milestoneId, sliceId, milestoneNodeId, nodes, edges);
    } catch {
      // Skip this slice on any error
    }
  }
}

function parseSingleSlice(
  gsdRoot: string,
  milestoneId: string,
  sliceId: string,
  milestoneNodeId: string,
  nodes: GraphNode[],
  edges: GraphEdge[],
): void {
  const sDir = resolveSliceDir(gsdRoot, milestoneId, sliceId);
  if (!sDir) return;

  const sliceNodeId = `slice:${milestoneId}:${sliceId}`;

  // Try to read the slice plan
  const planPath = join(sDir, `${sliceId}-PLAN.md`);
  let sliceTitle = `${milestoneId}/${sliceId}`;
  let planContent: string | null = null;

  if (existsSync(planPath)) {
    try {
      planContent = readFileSync(planPath, 'utf-8');
      const titleMatch = planContent.match(/^#\s+[A-Z]\d+:\s+(.+)/m);
      if (titleMatch) sliceTitle = `${sliceId}: ${titleMatch[1].trim()}`;
    } catch {
      // Use default title
    }
  }

  nodes.push({
    id: sliceNodeId,
    label: sliceTitle,
    type: 'slice',
    confidence: 'EXTRACTED',
    sourceFile: planContent ? `milestones/${milestoneId}/slices/${sliceId}/${sliceId}-PLAN.md` : undefined,
  });

  // Edge: milestone contains slice
  edges.push({
    from: milestoneNodeId,
    to: sliceNodeId,
    type: 'contains',
    confidence: 'EXTRACTED',
  });

  // Parse tasks from the slice plan
  if (planContent) {
    parseTasksFromPlan(planContent, milestoneId, sliceId, sliceNodeId, nodes, edges);
  }
}

function parseTasksFromPlan(
  content: string,
  milestoneId: string,
  sliceId: string,
  sliceNodeId: string,
  nodes: GraphNode[],
  edges: GraphEdge[],
): void {
  // Match lines like: - [ ] **T01: Title** — description
  const taskPattern = /[-*]\s+\[[ x]\]\s+\*\*(T\d+):\s*([^*]+)\*\*/g;
  let match: RegExpExecArray | null;

  while ((match = taskPattern.exec(content)) !== null) {
    const [, taskId, taskTitle] = match;
    const taskNodeId = `task:${milestoneId}:${sliceId}:${taskId}`;

    nodes.push({
      id: taskNodeId,
      label: `${taskId}: ${taskTitle.trim()}`,
      type: 'task',
      confidence: 'EXTRACTED',
    });

    edges.push({
      from: sliceNodeId,
      to: taskNodeId,
      type: 'contains',
      confidence: 'EXTRACTED',
    });
  }
}

// ---------------------------------------------------------------------------
// LEARNINGS.md parser
// ---------------------------------------------------------------------------

/**
 * Parse all *-LEARNINGS.md files found in milestone directories.
 * Extracts Decisions, Lessons, Patterns, and Surprises as typed graph nodes.
 * Surprises are mapped to the 'lesson' NodeType (no distinct type exists).
 * Parse errors per file are caught — the file is skipped, never rethrows.
 */
function parseLearningsFiles(gsdRoot: string, nodes: GraphNode[], edges: GraphEdge[]): void {
  const milestoneIds = findMilestoneIds(gsdRoot);

  for (const milestoneId of milestoneIds) {
    try {
      parseSingleLearningsFile(gsdRoot, milestoneId, nodes, edges);
    } catch {
      // Skip this milestone's LEARNINGS.md on any error
    }
  }
}

function parseSingleLearningsFile(
  gsdRoot: string,
  milestoneId: string,
  nodes: GraphNode[],
  edges: GraphEdge[],
): void {
  const mDir = resolveMilestoneDir(gsdRoot, milestoneId);
  if (!mDir) return;

  const learningsPath = join(mDir, `${milestoneId}-LEARNINGS.md`);
  if (!existsSync(learningsPath)) return;

  let content: string;
  try {
    content = readFileSync(learningsPath, 'utf-8');
  } catch {
    return;
  }

  // Strip YAML frontmatter if present
  const withoutFrontmatter = content.replace(/^---[\s\S]*?---\n?/, '');

  const milestoneNodeId = `milestone:${milestoneId}`;
  const sourceFile = `milestones/${milestoneId}/${milestoneId}-LEARNINGS.md`;

  // Parse each section: [sectionName, nodeType, idPrefix]
  const sections: Array<[string, NodeType, string]> = [
    ['Decisions', 'decision', 'decision'],
    ['Lessons', 'lesson', 'lesson'],
    ['Patterns', 'pattern', 'pattern'],
    ['Surprises', 'lesson', 'surprise'],
  ];

  for (const [sectionName, nodeType, idPrefix] of sections) {
    const sectionMatch = withoutFrontmatter.match(
      new RegExp(`##\\s+${sectionName}\\s*\\n([\\s\\S]*?)(?=\\n##\\s|$)`, 'i'),
    );
    if (!sectionMatch) continue;

    const sectionContent = sectionMatch[1];
    parseLearningsSection(
      sectionContent,
      milestoneId,
      idPrefix,
      nodeType,
      milestoneNodeId,
      sourceFile,
      nodes,
      edges,
    );
  }
}

function parseLearningsSection(
  sectionContent: string,
  milestoneId: string,
  idPrefix: string,
  nodeType: NodeType,
  milestoneNodeId: string,
  sourceFile: string,
  nodes: GraphNode[],
  edges: GraphEdge[],
): void {
  // Each item is a bullet line starting with "- " followed by optional
  // indented "Source: ..." line.
  // We collect bullet items and their associated source attribution.
  const lines = sectionContent.split('\n');
  let itemIndex = 0;
  let currentText: string | null = null;
  let currentSource: string | null = null;

  const flushItem = (): void => {
    if (!currentText) return;
    itemIndex += 1;
    const nodeId = `${idPrefix}:${milestoneId}:${itemIndex}`;
    const description = currentSource ? `${currentSource}` : undefined;

    nodes.push({
      id: nodeId,
      label: currentText,
      type: nodeType,
      description,
      confidence: 'EXTRACTED',
      sourceFile,
    });

    // Edge: milestone relates_to this learning node
    edges.push({
      from: milestoneNodeId,
      to: nodeId,
      type: 'relates_to',
      confidence: 'EXTRACTED',
    });

    currentText = null;
    currentSource = null;
  };

  for (const line of lines) {
    const bulletMatch = line.match(/^[-*]\s+(.+)/);
    if (bulletMatch) {
      flushItem();
      currentText = bulletMatch[1].trim();
      continue;
    }

    // Indented source attribution: "  Source: ..."
    const sourceMatch = line.match(/^\s+Source:\s+(.+)/i);
    if (sourceMatch && currentText !== null) {
      currentSource = `Source: ${sourceMatch[1].trim()}`;
      continue;
    }

    // Continuation of current item text (indented non-source line)
    const continuationMatch = line.match(/^\s{2,}(.+)/);
    if (continuationMatch && currentText !== null && currentSource === null) {
      currentText += ' ' + continuationMatch[1].trim();
    }
  }

  flushItem();
}

// ---------------------------------------------------------------------------
// buildGraph
// ---------------------------------------------------------------------------

/**
 * Build a KnowledgeGraph by parsing all .gsd/ artifacts.
 *
 * Parse errors in any single artifact are caught — the artifact is skipped
 * and never causes buildGraph() to throw.
 */
export async function buildGraph(projectDir: string): Promise<KnowledgeGraph> {
  const gsdRoot = resolveGsdRoot(resolve(projectDir));

  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  // Each parser is wrapped so a crash in one never stops others
  const parsers: Array<(g: string, n: GraphNode[], e: GraphEdge[]) => void> = [
    parseStateFile,
    parseKnowledgeFile,
    parseMilestoneFiles,
    parseLearningsFiles,
  ];

  for (const parser of parsers) {
    try {
      parser(gsdRoot, nodes, edges);
    } catch {
      // Parsing error — skip this artifact, mark as ambiguous
      nodes.push({
        id: `error:${parser.name}:${Date.now()}`,
        label: `Parse error in ${parser.name}`,
        type: 'concept',
        confidence: 'AMBIGUOUS',
      });
    }
  }

  // Deduplicate nodes by id (keep first occurrence)
  const seen = new Set<string>();
  const dedupedNodes = nodes.filter((n) => {
    if (seen.has(n.id)) return false;
    seen.add(n.id);
    return true;
  });

  return {
    nodes: dedupedNodes,
    edges,
    builtAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// writeGraph — atomic write via tmp + rename
// ---------------------------------------------------------------------------

/**
 * Write the graph to .gsd/graphs/graph.json atomically.
 *
 * Writes to graph.tmp.json first, then renames to graph.json.
 * Creates the graphs/ directory if it does not exist.
 */
export async function writeGraph(gsdRoot: string, graph: KnowledgeGraph): Promise<void> {
  const dir = graphsDir(gsdRoot);
  mkdirSync(dir, { recursive: true });

  const tmp = graphTmpPath(gsdRoot);
  const final = graphJsonPath(gsdRoot);

  writeFileSync(tmp, JSON.stringify(graph, null, 2), 'utf-8');
  renameSync(tmp, final);
}

// ---------------------------------------------------------------------------
// writeSnapshot
// ---------------------------------------------------------------------------

/**
 * Copy the current graph.json to .last-build-snapshot.json.
 * Adds a snapshotAt timestamp to the copy.
 */
export async function writeSnapshot(gsdRoot: string): Promise<void> {
  const src = graphJsonPath(gsdRoot);
  if (!existsSync(src)) return;

  const dir = graphsDir(gsdRoot);
  mkdirSync(dir, { recursive: true });

  const raw = readFileSync(src, 'utf-8');
  let graph: KnowledgeGraph;
  try {
    graph = JSON.parse(raw) as KnowledgeGraph;
  } catch {
    return;
  }
  const snapshot = { ...graph, snapshotAt: new Date().toISOString() };

  writeFileSync(snapshotPath(gsdRoot), JSON.stringify(snapshot, null, 2), 'utf-8');
}

// ---------------------------------------------------------------------------
// graphStatus
// ---------------------------------------------------------------------------

/**
 * Return status of the graph: whether it exists, its age, and whether it is stale.
 * Stale means builtAt is older than 24 hours.
 */
export async function graphStatus(projectDir: string): Promise<GraphStatusResult> {
  const gsdRoot = resolveGsdRoot(resolve(projectDir));
  const graphPath = graphJsonPath(gsdRoot);

  if (!existsSync(graphPath)) {
    return { exists: false };
  }

  try {
    const raw = readFileSync(graphPath, 'utf-8');
    const graph = JSON.parse(raw) as KnowledgeGraph;

    const builtAt = graph.builtAt;
    const ageMs = Date.now() - new Date(builtAt).getTime();
    const ageHours = ageMs / (1000 * 60 * 60);
    const stale = ageHours > 24;

    return {
      exists: true,
      lastBuild: builtAt,
      nodeCount: graph.nodes.length,
      edgeCount: graph.edges.length,
      stale,
      ageHours,
    };
  } catch {
    return { exists: false };
  }
}

// ---------------------------------------------------------------------------
// applyBudget — trim edges to stay within token budget
// ---------------------------------------------------------------------------

/**
 * Given a set of seed node IDs and the full graph, apply BFS to collect
 * reachable nodes and edges. Trims AMBIGUOUS edges first, then INFERRED,
 * stopping when the estimated token count drops within budget.
 *
 * Budget is a rough token estimate: 1 node ≈ 20 tokens, 1 edge ≈ 10 tokens.
 */
function applyBudget(
  graph: KnowledgeGraph,
  seedIds: Set<string>,
  budget: number,
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  // BFS to collect reachable nodes (start from seeds)
  const reachable = new Set<string>(seedIds);
  const queue = [...seedIds];

  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const edge of graph.edges) {
      if (edge.from === current && !reachable.has(edge.to)) {
        reachable.add(edge.to);
        queue.push(edge.to);
      }
    }
  }

  let resultNodes = graph.nodes.filter((n) => reachable.has(n.id));
  let resultEdges = graph.edges.filter(
    (e) => reachable.has(e.from) && reachable.has(e.to),
  );

  // Estimate tokens and trim if over budget
  // Trim AMBIGUOUS edges first, then INFERRED
  const estimate = (): number =>
    resultNodes.length * 20 + resultEdges.length * 10;

  if (estimate() > budget) {
    resultEdges = resultEdges.filter((e) => e.confidence !== 'AMBIGUOUS');
  }
  if (estimate() > budget) {
    resultEdges = resultEdges.filter((e) => e.confidence !== 'INFERRED');
  }
  if (estimate() > budget) {
    // Hard trim — keep only seed nodes and their EXTRACTED edges
    const seedNodes = resultNodes.filter((n) => seedIds.has(n.id));
    const seedEdges = resultEdges.filter(
      (e) => seedIds.has(e.from) && e.confidence === 'EXTRACTED',
    );
    return { nodes: seedNodes, edges: seedEdges };
  }

  return { nodes: resultNodes, edges: resultEdges };
}

// ---------------------------------------------------------------------------
// graphQuery
// ---------------------------------------------------------------------------

/**
 * Query the graph for nodes matching a term (case-insensitive on label + description).
 * BFS from seed nodes, applying budget trimming.
 *
 * Reads from the pre-built graph.json. Falls back to an empty result if no
 * graph exists.
 */
export async function graphQuery(
  projectDir: string,
  term: string,
  budget = 4000,
): Promise<GraphQueryResult> {
  const gsdRoot = resolveGsdRoot(resolve(projectDir));
  const graphPath = graphJsonPath(gsdRoot);

  if (!existsSync(graphPath)) {
    return { nodes: [], edges: [], term, budget };
  }

  let graph: KnowledgeGraph;
  try {
    const raw = readFileSync(graphPath, 'utf-8');
    graph = JSON.parse(raw) as KnowledgeGraph;
  } catch {
    return { nodes: [], edges: [], term, budget };
  }

  if (!term || term.trim() === '') {
    // Empty term — return empty result
    return { nodes: [], edges: [], term, budget };
  }

  const lower = term.toLowerCase();

  // Find seed nodes that match the term
  const seedIds = new Set<string>(
    graph.nodes
      .filter((n) => {
        const labelMatch = n.label.toLowerCase().includes(lower);
        const descMatch = n.description?.toLowerCase().includes(lower) ?? false;
        return labelMatch || descMatch;
      })
      .map((n) => n.id),
  );

  if (seedIds.size === 0) {
    return { nodes: [], edges: [], term, budget };
  }

  const result = applyBudget(graph, seedIds, budget);
  return { ...result, term, budget };
}

// ---------------------------------------------------------------------------
// graphDiff
// ---------------------------------------------------------------------------

/**
 * Compare the current graph.json with .last-build-snapshot.json.
 * Returns added/removed/changed nodes and added/removed edges.
 *
 * If no snapshot exists, returns empty diff arrays.
 */
export async function graphDiff(projectDir: string): Promise<GraphDiffResult> {
  const gsdRoot = resolveGsdRoot(resolve(projectDir));
  const empty: GraphDiffResult = {
    nodes: { added: [], removed: [], changed: [] },
    edges: { added: [], removed: [] },
  };

  const graphPath = graphJsonPath(gsdRoot);
  const snap = snapshotPath(gsdRoot);

  if (!existsSync(graphPath)) return empty;
  if (!existsSync(snap)) return empty;

  let current: KnowledgeGraph;
  let snapshot: KnowledgeGraph;

  try {
    current = JSON.parse(readFileSync(graphPath, 'utf-8')) as KnowledgeGraph;
  } catch {
    return empty;
  }

  try {
    snapshot = JSON.parse(readFileSync(snap, 'utf-8')) as KnowledgeGraph;
  } catch {
    return empty;
  }

  const currentNodeIds = new Set(current.nodes.map((n) => n.id));
  const snapshotNodeIds = new Set(snapshot.nodes.map((n) => n.id));

  const added = current.nodes.filter((n) => !snapshotNodeIds.has(n.id)).map((n) => n.id);
  const removed = snapshot.nodes.filter((n) => !currentNodeIds.has(n.id)).map((n) => n.id);

  // Changed: same id but different label or description
  const snapshotNodeMap = new Map(snapshot.nodes.map((n) => [n.id, n]));
  const changed = current.nodes
    .filter((n) => {
      const snap = snapshotNodeMap.get(n.id);
      if (!snap) return false;
      return n.label !== snap.label || n.description !== snap.description;
    })
    .map((n) => n.id);

  // Edges — compare by string key "from->to:type"
  const edgeKey = (e: GraphEdge): string => `${e.from}->${e.to}:${e.type}`;
  const currentEdgeKeys = new Set(current.edges.map(edgeKey));
  const snapshotEdgeKeys = new Set(snapshot.edges.map(edgeKey));

  const edgesAdded = current.edges.filter((e) => !snapshotEdgeKeys.has(edgeKey(e))).map(edgeKey);
  const edgesRemoved = snapshot.edges.filter((e) => !currentEdgeKeys.has(edgeKey(e))).map(edgeKey);

  return {
    nodes: { added, removed, changed },
    edges: { added: edgesAdded, removed: edgesRemoved },
  };
}
