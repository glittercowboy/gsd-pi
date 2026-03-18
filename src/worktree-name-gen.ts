/**
 * Random worktree name generator.
 *
 * Produces names in the pattern: adjective-verbing-noun
 * e.g. "noble-roaming-karp", "swift-whistling-matsumoto"
 */

const ADJECTIVES = [
  'agile', 'bold', 'brave', 'bright', 'calm', 'clear', 'cool', 'crisp',
  'dapper', 'eager', 'fair', 'fast', 'fierce', 'fine', 'fleet', 'fond',
  'gentle', 'glad', 'grand', 'happy', 'keen', 'kind', 'lively', 'lucid',
  'mellow', 'merry', 'mighty', 'neat', 'nimble', 'noble', 'plucky', 'polite',
  'proud', 'quiet', 'rapid', 'ready', 'serene', 'sharp', 'sleek', 'sleepy',
  'smooth', 'snappy', 'steady', 'sturdy', 'sunny', 'sure', 'swift', 'tidy',
  'tough', 'tranquil', 'vivid', 'warm', 'wise', 'witty', 'zesty',
]

const VERBS = [
  'baking', 'bouncing', 'building', 'carving', 'chasing', 'climbing',
  'coding', 'crafting', 'dancing', 'dashing', 'diving', 'drawing',
  'dreaming', 'drifting', 'drumming', 'exploring', 'fishing', 'floating',
  'flying', 'forging', 'gliding', 'growing', 'hiking', 'humming',
  'jumping', 'juggling', 'knitting', 'laughing', 'leaping', 'mapping',
  'mixing', 'painting', 'planting', 'playing', 'racing', 'reading',
  'riding', 'roaming', 'rowing', 'running', 'sailing', 'singing',
  'skating', 'sketching', 'spinning', 'squishing', 'surfing', 'swimming',
  'thinking', 'threading', 'tracing', 'walking', 'weaving', 'whistling',
  'writing',
]

const NOUNS = [
  'atlas', 'aurora', 'balloon', 'beacon', 'bolt', 'brook', 'canyon',
  'cedar', 'comet', 'cook', 'coral', 'cosmos', 'crest', 'dawn', 'delta',
  'echo', 'ember', 'falcon', 'fern', 'flare', 'frost', 'gale', 'glacier',
  'grove', 'harbor', 'hawk', 'horizon', 'iris', 'jade', 'karp', 'lantern',
  'lark', 'luna', 'maple', 'marsh', 'matsumoto', 'mesa', 'nebula', 'oasis',
  'orbit', 'otter', 'pebble', 'phoenix', 'pine', 'prism', 'puppy', 'quartz',
  'raven', 'reef', 'ridge', 'river', 'sage', 'shore', 'sierra', 'spark',
  'sprout', 'stone', 'summit', 'thorn', 'tide', 'topaz', 'trail', 'vale',
  'violet', 'wave', 'willow', 'zenith',
]

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!
}

export function generateWorktreeName(): string {
  return `${pick(ADJECTIVES)}-${pick(VERBS)}-${pick(NOUNS)}`
}
