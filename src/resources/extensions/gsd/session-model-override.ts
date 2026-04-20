export interface SessionModelOverride {
  provider: string;
  id: string;
}

const sessionOverrides = new Map<string, SessionModelOverride>();

function normalizeSessionId(sessionId: string): string {
  return typeof sessionId === "string" ? sessionId.trim() : "";
}

export function setSessionModelOverride(
  sessionId: string,
  override: SessionModelOverride,
): void {
  const key = normalizeSessionId(sessionId);
  if (!key) return;
  sessionOverrides.set(key, {
    provider: override.provider,
    id: override.id,
  });
}

export function getSessionModelOverride(
  sessionId: string,
): SessionModelOverride | undefined {
  const key = normalizeSessionId(sessionId);
  if (!key) return undefined;
  return sessionOverrides.get(key);
}

export function clearSessionModelOverride(sessionId: string): void {
  const key = normalizeSessionId(sessionId);
  if (!key) return;
  sessionOverrides.delete(key);
}
