// GSD Memory Store — CRUD, ranked queries, maintenance, and prompt formatting
//
// Storage layer for auto-learned project memories. Follows context-store.ts patterns.
// All functions degrade gracefully: return empty results when DB unavailable, never throw.

import { isDbAvailable, _getAdapter, transaction } from './gsd-db.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface Memory {
  seq: number;
  id: string;
  category: string;
  content: string;
  confidence: number;
  source_unit_type: string | null;
  source_unit_id: string | null;
  created_at: string;
  updated_at: string;
  superseded_by: string | null;
  hit_count: number;
}

export type MemoryActionCreate = {
  action: 'CREATE';
  category: string;
  content: string;
  confidence?: number;
};

export type MemoryActionUpdate = {
  action: 'UPDATE';
  id: string;
  content: string;
  confidence?: number;
};

export type MemoryActionReinforce = {
  action: 'REINFORCE';
  id: string;
};

export type MemoryActionSupersede = {
  action: 'SUPERSEDE';
  id: string;
  superseded_by: string;
};

export type MemoryAction =
  | MemoryActionCreate
  | MemoryActionUpdate
  | MemoryActionReinforce
  | MemoryActionSupersede;

// ─── Category Display Order ─────────────────────────────────────────────────

const CATEGORY_PRIORITY: Record<string, number> = {
  gotcha: 0,
  convention: 1,
  architecture: 2,
  pattern: 3,
  environment: 4,
  preference: 5,
};

// ─── Row Mapping ────────────────────────────────────────────────────────────

function rowToMemory(row: Record<string, unknown>): Memory {
  return {
    seq: row['seq'] as number,
    id: row['id'] as string,
    category: row['category'] as string,
    content: row['content'] as string,
    confidence: row['confidence'] as number,
    source_unit_type: (row['source_unit_type'] as string) ?? null,
    source_unit_id: (row['source_unit_id'] as string) ?? null,
    created_at: row['created_at'] as string,
    updated_at: row['updated_at'] as string,
    superseded_by: (row['superseded_by'] as string) ?? null,
    hit_count: row['hit_count'] as number,
  };
}

// ─── Query Functions ────────────────────────────────────────────────────────

/**
 * Get all memories where superseded_by IS NULL.
 * Returns [] if DB is not available. Never throws.
 */
export function getActiveMemories(): Memory[] {
  if (!isDbAvailable()) return [];
  const adapter = _getAdapter();
  if (!adapter) return [];

  try {
    const rows = adapter.prepare('SELECT * FROM memories WHERE superseded_by IS NULL').all();
    return rows.map(rowToMemory);
  } catch {
    return [];
  }
}

/**
 * Get active memories ordered by ranking score: confidence * (1 + hit_count * 0.1).
 * Higher-scored memories are more relevant and frequently confirmed.
 */
export function getActiveMemoriesRanked(limit = 30): Memory[] {
  if (!isDbAvailable()) return [];
  const adapter = _getAdapter();
  if (!adapter) return [];

  try {
    const rows = adapter.prepare(
      `SELECT * FROM memories
       WHERE superseded_by IS NULL
       ORDER BY (confidence * (1.0 + hit_count * 0.1)) DESC
       LIMIT :limit`,
    ).all({ ':limit': limit });
    return rows.map(rowToMemory);
  } catch {
    return [];
  }
}

/**
 * Generate the next memory ID: MEM + zero-padded 3-digit from MAX(seq).
 * Returns MEM001 if no memories exist.
 */
export function nextMemoryId(): string {
  if (!isDbAvailable()) return 'MEM001';
  const adapter = _getAdapter();
  if (!adapter) return 'MEM001';

  try {
    const row = adapter
      .prepare('SELECT MAX(seq) as max_seq FROM memories')
      .get();
    const maxSeq = row ? (row['max_seq'] as number | null) : null;
    if (maxSeq == null || isNaN(maxSeq)) return 'MEM001';
    const next = maxSeq + 1;
    return `MEM${String(next).padStart(3, '0')}`;
  } catch {
    return 'MEM001';
  }
}

// ─── Mutation Functions ─────────────────────────────────────────────────────

/**
 * Insert a new memory with auto-assigned ID.
 * Returns the assigned ID, or null on failure.
 */
export function createMemory(fields: {
  category: string;
  content: string;
  confidence?: number;
  source_unit_type?: string;
  source_unit_id?: string;
}): string | null {
  if (!isDbAvailable()) return null;
  const adapter = _getAdapter();
  if (!adapter) return null;

  try {
    const id = nextMemoryId();
    const now = new Date().toISOString();
    adapter.prepare(
      `INSERT INTO memories (id, category, content, confidence, source_unit_type, source_unit_id, created_at, updated_at)
       VALUES (:id, :category, :content, :confidence, :source_unit_type, :source_unit_id, :created_at, :updated_at)`,
    ).run({
      ':id': id,
      ':category': fields.category,
      ':content': fields.content,
      ':confidence': fields.confidence ?? 0.8,
      ':source_unit_type': fields.source_unit_type ?? null,
      ':source_unit_id': fields.source_unit_id ?? null,
      ':created_at': now,
      ':updated_at': now,
    });
    return id;
  } catch {
    return null;
  }
}

/**
 * Update a memory's content and optionally its confidence.
 */
export function updateMemoryContent(id: string, content: string, confidence?: number): boolean {
  if (!isDbAvailable()) return false;
  const adapter = _getAdapter();
  if (!adapter) return false;

  try {
    const now = new Date().toISOString();
    if (confidence != null) {
      adapter.prepare(
        'UPDATE memories SET content = :content, confidence = :confidence, updated_at = :updated_at WHERE id = :id',
      ).run({ ':content': content, ':confidence': confidence, ':updated_at': now, ':id': id });
    } else {
      adapter.prepare(
        'UPDATE memories SET content = :content, updated_at = :updated_at WHERE id = :id',
      ).run({ ':content': content, ':updated_at': now, ':id': id });
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Reinforce a memory: increment hit_count, update timestamp.
 */
export function reinforceMemory(id: string): boolean {
  if (!isDbAvailable()) return false;
  const adapter = _getAdapter();
  if (!adapter) return false;

  try {
    adapter.prepare(
      'UPDATE memories SET hit_count = hit_count + 1, updated_at = :updated_at WHERE id = :id',
    ).run({ ':updated_at': new Date().toISOString(), ':id': id });
    return true;
  } catch {
    return false;
  }
}

/**
 * Mark a memory as superseded by another.
 */
export function supersedeMemory(oldId: string, newId: string): boolean {
  if (!isDbAvailable()) return false;
  const adapter = _getAdapter();
  if (!adapter) return false;

  try {
    adapter.prepare(
      'UPDATE memories SET superseded_by = :new_id, updated_at = :updated_at WHERE id = :old_id',
    ).run({ ':new_id': newId, ':updated_at': new Date().toISOString(), ':old_id': oldId });
    return true;
  } catch {
    return false;
  }
}

// ─── Processed Unit Tracking ────────────────────────────────────────────────

/**
 * Check if a unit has already been processed for memory extraction.
 */
export function isUnitProcessed(unitKey: string): boolean {
  if (!isDbAvailable()) return false;
  const adapter = _getAdapter();
  if (!adapter) return false;

  try {
    const row = adapter.prepare(
      'SELECT 1 FROM memory_processed_units WHERE unit_key = :key',
    ).get({ ':key': unitKey });
    return row != null;
  } catch {
    return false;
  }
}

/**
 * Record that a unit has been processed for memory extraction.
 */
export function markUnitProcessed(unitKey: string, activityFile: string): boolean {
  if (!isDbAvailable()) return false;
  const adapter = _getAdapter();
  if (!adapter) return false;

  try {
    adapter.prepare(
      `INSERT OR IGNORE INTO memory_processed_units (unit_key, activity_file, processed_at)
       VALUES (:key, :file, :at)`,
    ).run({ ':key': unitKey, ':file': activityFile, ':at': new Date().toISOString() });
    return true;
  } catch {
    return false;
  }
}

// ─── Maintenance ────────────────────────────────────────────────────────────

/**
 * Reduce confidence for memories not updated within the last N processed units.
 * "Stale" = updated_at is older than the Nth most recent processed_at.
 */
export function decayStaleMemories(thresholdUnits = 20): void {
  if (!isDbAvailable()) return;
  const adapter = _getAdapter();
  if (!adapter) return;

  try {
    // Find the timestamp of the Nth most recent processed unit
    const row = adapter.prepare(
      `SELECT processed_at FROM memory_processed_units
       ORDER BY processed_at DESC
       LIMIT 1 OFFSET :offset`,
    ).get({ ':offset': thresholdUnits - 1 });

    if (!row) return; // not enough processed units yet

    const cutoff = row['processed_at'] as string;
    adapter.prepare(
      `UPDATE memories
       SET confidence = MAX(0.1, confidence - 0.1), updated_at = :now
       WHERE superseded_by IS NULL AND updated_at < :cutoff AND confidence > 0.1`,
    ).run({ ':now': new Date().toISOString(), ':cutoff': cutoff });
  } catch {
    // non-fatal
  }
}

/**
 * Supersede lowest-ranked memories when count exceeds cap.
 */
export function enforceMemoryCap(max = 50): void {
  if (!isDbAvailable()) return;
  const adapter = _getAdapter();
  if (!adapter) return;

  try {
    const countRow = adapter.prepare(
      'SELECT count(*) as cnt FROM memories WHERE superseded_by IS NULL',
    ).get();
    const count = (countRow?.['cnt'] as number) ?? 0;
    if (count <= max) return;

    const excess = count - max;
    // Find the IDs of the lowest-ranked active memories
    const rows = adapter.prepare(
      `SELECT id FROM memories
       WHERE superseded_by IS NULL
       ORDER BY (confidence * (1.0 + hit_count * 0.1)) ASC
       LIMIT :limit`,
    ).all({ ':limit': excess });

    const now = new Date().toISOString();
    for (const row of rows) {
      adapter.prepare(
        'UPDATE memories SET superseded_by = :reason, updated_at = :now WHERE id = :id',
      ).run({ ':reason': 'CAP_EXCEEDED', ':now': now, ':id': row['id'] as string });
    }
  } catch {
    // non-fatal
  }
}

// ─── Action Application ─────────────────────────────────────────────────────

/**
 * Process an array of memory actions in a transaction.
 * Calls enforceMemoryCap at the end.
 */
export function applyMemoryActions(
  actions: MemoryAction[],
  unitType?: string,
  unitId?: string,
): void {
  if (!isDbAvailable() || actions.length === 0) return;

  try {
    transaction(() => {
      for (const action of actions) {
        switch (action.action) {
          case 'CREATE':
            createMemory({
              category: action.category,
              content: action.content,
              confidence: action.confidence,
              source_unit_type: unitType,
              source_unit_id: unitId,
            });
            break;
          case 'UPDATE':
            updateMemoryContent(action.id, action.content, action.confidence);
            break;
          case 'REINFORCE':
            reinforceMemory(action.id);
            break;
          case 'SUPERSEDE':
            supersedeMemory(action.id, action.superseded_by);
            break;
        }
      }
      enforceMemoryCap();
    });
  } catch {
    // non-fatal — transaction will have rolled back
  }
}

// ─── Prompt Formatting ──────────────────────────────────────────────────────

/**
 * Format memories as categorized markdown for system prompt injection.
 * Truncates to token budget (~4 chars per token).
 */
export function formatMemoriesForPrompt(memories: Memory[], tokenBudget = 2000): string {
  if (memories.length === 0) return '';

  const charBudget = tokenBudget * 4;
  const header = '## Project Memory (auto-learned)\n';
  let output = header;
  let remaining = charBudget - header.length;

  // Group by category
  const grouped = new Map<string, Memory[]>();
  for (const m of memories) {
    const list = grouped.get(m.category) ?? [];
    list.push(m);
    grouped.set(m.category, list);
  }

  // Sort categories by priority
  const sortedCategories = [...grouped.keys()].sort(
    (a, b) => (CATEGORY_PRIORITY[a] ?? 99) - (CATEGORY_PRIORITY[b] ?? 99),
  );

  for (const category of sortedCategories) {
    const items = grouped.get(category)!;
    const catHeader = `\n### ${category.charAt(0).toUpperCase() + category.slice(1)}\n`;

    if (remaining < catHeader.length + 10) break;
    output += catHeader;
    remaining -= catHeader.length;

    for (const item of items) {
      const bullet = `- ${item.content}\n`;
      if (remaining < bullet.length) break;
      output += bullet;
      remaining -= bullet.length;
    }
  }

  return output.trimEnd();
}
