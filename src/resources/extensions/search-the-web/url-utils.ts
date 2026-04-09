/**
 * URL normalization, query utilities, and SSRF protection.
 */

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "metadata.google.internal",
  "instance-data",
]);

const PRIVATE_IP_PATTERNS = [
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^169\.254\./,
  /^0\./,
  /^::1$/,
  /^fc00:/i,
  /^fd/i,
  /^fe80:/i,
];

/**
 * Hostnames exempted from SSRF blocking. Set via setFetchAllowedUrls()
 * from global settings.json or GSD_FETCH_ALLOWED_URLS env var.
 */
let fetchAllowedHostnames: Set<string> = new Set();

/**
 * Replace the fetch URL allowlist (hostnames exempted from SSRF checks).
 */
export function setFetchAllowedUrls(hostnames: string[]): void {
  fetchAllowedHostnames = new Set(hostnames.map((h) => h.toLowerCase()));
}

/** Get the currently active fetch URL allowlist. */
export function getFetchAllowedUrls(): readonly string[] {
  return [...fetchAllowedHostnames];
}

export function isBlockedUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return true;
    const hostname = parsed.hostname.toLowerCase();
    if (fetchAllowedHostnames.has(hostname)) return false;
    if (BLOCKED_HOSTNAMES.has(hostname)) return true;
    for (const pattern of PRIVATE_IP_PATTERNS) {
      if (pattern.test(hostname)) return true;
    }
    return false;
  } catch {
    return true;
  }
}

/** Normalize a search query into a stable cache key. */
export function normalizeQuery(query: string): string {
  return query.trim().toLowerCase().replace(/\s+/g, " ").normalize("NFC");
}

/**
 * Canonical URL for deduplication.
 * Strips fragment, tracking params, lowercases hostname, sorts query params,
 * strips trailing "/" on root paths.
 */
export function toDedupeKey(url: string): string | null {
  try {
    const parsed = new URL(url);
    parsed.hostname = parsed.hostname.toLowerCase();
    parsed.hash = "";

    const TRACKING_PARAMS = new Set(["fbclid", "gclid"]);
    const toDelete: string[] = [];
    for (const key of parsed.searchParams.keys()) {
      if (key.startsWith("utm_") || TRACKING_PARAMS.has(key)) {
        toDelete.push(key);
      }
    }
    for (const key of toDelete) parsed.searchParams.delete(key);
    parsed.searchParams.sort();

    let canonical = parsed.toString();
    if (parsed.pathname === "/" && !parsed.search) {
      canonical = canonical.replace(/\/$/, "");
    }
    return canonical;
  } catch {
    return null;
  }
}

/**
 * Extract a clean domain from a URL for display.
 * "https://docs.python.org/3/library/asyncio.html" → "docs.python.org"
 */
export function extractDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/**
 * Detect if a query likely wants fresh/recent results.
 * Returns a suggested Brave freshness parameter or null.
 */
export function detectFreshness(query: string): string | null {
  const q = query.toLowerCase();

  // Explicit year references for current/recent years
  const currentYear = new Date().getFullYear();
  for (let y = currentYear; y >= currentYear - 1; y--) {
    if (q.includes(String(y))) return "py"; // past year
  }

  // Recency keywords
  const recentPatterns = [
    /\b(latest|newest|recent|new|just released|just launched)\b/,
    /\b(today|yesterday|this week|this month)\b/,
    /\b(breaking|update|announcement|release notes?)\b/,
    /\b(what('?s| is) new)\b/,
  ];
  for (const pattern of recentPatterns) {
    if (pattern.test(q)) return "pm"; // past month
  }

  return null;
}

/**
 * Detect if a query targets specific domains.
 * Returns extracted domains or null.
 */
export function detectDomainHints(query: string): string[] | null {
  // Match "site:example.com" patterns
  const siteMatches = query.match(/site:(\S+)/gi);
  if (siteMatches) {
    return siteMatches.map((m) => m.replace(/^site:/i, ""));
  }
  return null;
}
