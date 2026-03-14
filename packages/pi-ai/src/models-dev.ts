import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { ModelsDevData } from "./models-dev-types.js";

const MODELS_DEV_URL = "https://models.dev/api.json";
const DEFAULT_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours
const FETCH_TIMEOUT_MS = 10000; // 10 seconds

interface CacheEntry {
  version: string;
  fetchedAt: number;
  data: ModelsDevData;
}

export type { CacheEntry };

/**
 * Get the default cache file path.
 * Lazily resolves to avoid requiring pi-coding-agent at import time.
 */
function getDefaultCachePath(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getAgentDir } = require("@gsd/pi-coding-agent/dist/config.js");
    return join(getAgentDir(), "cache", "models-dev.json");
  } catch {
    // Fallback for tests or when package not built
    return join(homedir(), ".gsd", "agent", "cache", "models-dev.json");
  }
}

/**
 * Get the current version.
 * Lazily resolves to avoid requiring pi-coding-agent at import time.
 */
function getCurrentVersion(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { VERSION } = require("@gsd/pi-coding-agent/dist/config.js");
    return VERSION;
  } catch {
    // Fallback for tests or when package not built
    return "unknown";
  }
}

/**
 * Read and validate cache file. Returns null if cache doesn't exist or is invalid.
 */
export function getCachedModelsDev(cachePath?: string): CacheEntry | null {
  const path = cachePath ?? getDefaultCachePath();
  try {
    if (!existsSync(path)) {
      return null;
    }
    const content = readFileSync(path, "utf-8");
    const cache = JSON.parse(content) as CacheEntry;
    
    // Validate cache structure
    if (!cache.version || !cache.fetchedAt || !cache.data) {
      return null;
    }
    
    return cache;
  } catch {
    return null;
  }
}

/**
 * Check if cache is valid (exists, not expired, version matches).
 */
export function isCacheValid(
  cache: CacheEntry | null,
  ttlMs: number = DEFAULT_TTL_MS,
  currentVersion?: string
): boolean {
  if (!cache) {
    return false;
  }
  
  const version = currentVersion ?? getCurrentVersion();
  
  // Check version match
  if (cache.version !== version) {
    return false;
  }
  
  // Check TTL
  const now = Date.now();
  const age = now - cache.fetchedAt;
  if (age > ttlMs) {
    return false;
  }
  
  return true;
}

/**
 * Write data to cache file.
 */
export function writeCache(
  data: ModelsDevData,
  version?: string,
  cachePath?: string
): boolean {
  const path = cachePath ?? getDefaultCachePath();
  const ver = version ?? getCurrentVersion();
  
  try {
    const cache: CacheEntry = {
      version: ver,
      fetchedAt: Date.now(),
      data,
    };
    
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(cache, null, 2));
    return true;
  } catch {
    return false;
  }
}

/**
 * Fetch models from models.dev API with timeout.
 * Returns null on network error.
 */
export async function fetchModelsDev(
  url: string = MODELS_DEV_URL,
  timeoutMs: number = FETCH_TIMEOUT_MS
): Promise<ModelsDevData | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  
  try {
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    
    if (!response.ok) {
      return null;
    }
    
    const data = await response.json();
    return ModelsDevData.parse(data);
  } catch {
    clearTimeout(timeout);
    return null;
  }
}

/**
 * Main entry point: orchestrate cache → fetch → fallback chain.
 * 
 * 1. Try cache first (if valid and not expired)
 * 2. If cache invalid/expired, try network fetch
 * 3. If network fails, fall back to stale cache
 * 4. Never throw on network errors
 */
export async function getModelsDev(options?: {
  ttlMs?: number;
  cachePath?: string;
  url?: string;
  forceRefresh?: boolean;
  version?: string;
}): Promise<ModelsDevData | null> {
  const ttlMs = options?.ttlMs ?? DEFAULT_TTL_MS;
  const cachePath = options?.cachePath ?? getDefaultCachePath();
  const url = options?.url ?? MODELS_DEV_URL;
  const forceRefresh = options?.forceRefresh ?? false;
  const version = options?.version ?? getCurrentVersion();
  
  // Try cache first
  const cache = getCachedModelsDev(cachePath);
  
  if (!forceRefresh && isCacheValid(cache, ttlMs, version)) {
    // Cache hit - return cached data
    // Safe to use non-null assertion: isCacheValid guarantees cache is non-null
    return cache!.data;
  }
  
  // Cache miss or expired - try fetch
  const fetchedData = await fetchModelsDev(url);
  
  if (fetchedData) {
    // Fetch succeeded - update cache
    writeCache(fetchedData, version, cachePath);
    return fetchedData;
  }
  
  // Fetch failed - fall back to stale cache if available
  if (cache) {
    // Use stale cache even if version or TTL doesn't match
    return cache.data;
  }
  
  // No cache available and fetch failed
  return null;
}

/**
 * Force refresh from network, ignoring cache.
 * Falls back to cache only if network fails.
 */
export async function refreshModelsDev(options?: {
  cachePath?: string;
  url?: string;
  version?: string;
}): Promise<ModelsDevData | null> {
  return getModelsDev({ ...options, forceRefresh: true });
}
