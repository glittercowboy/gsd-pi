/**
 * Lightweight .gsd/ filesystem readers for read-only MCP tools.
 *
 * These parse the on-disk markdown/JSON artifacts directly — no DB
 * dependency, no extension imports. The .gsd/ file format is the
 * stable contract.
 */

export { readProgress } from './progress.js';
export { readRoadmap } from './roadmap.js';
export { readHistory } from './history.js';
export { readDoctor } from './doctor.js';
export { readCaptures } from './captures.js';
export { readKnowledge } from './knowledge.js';
