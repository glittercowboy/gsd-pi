/**
 * useSettings — hook for fetching, editing, and saving settings.
 *
 * Tracks pending changes separately from server state.
 * Changes require explicit save() call (not live).
 * Also exposes discovered Claude Code configuration.
 */
import { useState, useEffect, useCallback, useRef } from "react";

export interface ClaudeConfig {
  skills: string[];
  commands: string[];
  agents: string[];
  plugins: Array<{ name: string; scope: string; enabled?: boolean }>;
  claudeSettings: Record<string, unknown>;
}

export interface SettingsData {
  global: Record<string, unknown>;
  project: Record<string, unknown>;
  merged: Record<string, unknown>;
  claude: ClaudeConfig;
}

export interface UseSettingsResult {
  settings: SettingsData | null;
  loading: boolean;
  error: string | null;
  dirty: boolean;
  update: (key: string, value: unknown) => void;
  save: (tier: "global" | "project") => Promise<void>;
  reload: () => Promise<void>;
}

export function useSettings(apiBase = "http://127.0.0.1:4200"): UseSettingsResult {
  const [settings, setSettings] = useState<SettingsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const pendingRef = useRef<Record<string, unknown>>({});
  const [dirty, setDirty] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${apiBase}/api/settings`);
      if (!res.ok) throw new Error(`Settings fetch failed: ${res.status}`);
      const data: SettingsData = await res.json();
      setSettings(data);
      pendingRef.current = {};
      setDirty(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, [apiBase]);

  useEffect(() => {
    reload();
  }, [reload]);

  const update = useCallback((key: string, value: unknown) => {
    pendingRef.current = { ...pendingRef.current, [key]: value };
    setDirty(true);
  }, []);

  const save = useCallback(
    async (tier: "global" | "project") => {
      setError(null);
      try {
        const res = await fetch(`${apiBase}/api/settings`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tier, settings: pendingRef.current }),
        });
        if (!res.ok) throw new Error(`Settings save failed: ${res.status}`);
        await reload();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unknown error");
      }
    },
    [apiBase, reload],
  );

  return { settings, loading, error, dirty, update, save, reload };
}
