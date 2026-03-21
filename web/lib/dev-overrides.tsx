"use client"

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react"

// ─── Dev mode detection ─────────────────────────────────────────────

/**
 * Build-time hint — may be `false` even in source-dev if the build happened
 * without the env var. The runtime check via `/api/dev-mode` is authoritative.
 */
const BUILD_TIME_HINT = process.env.NEXT_PUBLIC_GSD_DEV === "1"

/**
 * Exported for static guards that run before the runtime check resolves.
 * Defaults to the build-time hint, then gets upgraded by the API response.
 * Components that need the authoritative value should use `useDevOverrides().isDevMode`.
 */
export let IS_DEV_MODE = BUILD_TIME_HINT

// ─── Override keys ──────────────────────────────────────────────────

/**
 * Each override is a named boolean toggle.
 * Add new overrides here — they automatically appear in the Admin panel.
 */
export interface DevOverrideMap {
  /** Force the onboarding wizard to render regardless of auth state. */
  forceOnboarding: boolean
}

export type DevOverrideKey = keyof DevOverrideMap

export interface DevOverrideEntry {
  key: DevOverrideKey
  label: string
  description: string
  /** Keyboard shortcut label shown in the UI, e.g. "Ctrl+Shift+1" */
  shortcutLabel: string
}

/** Registry of all available overrides, their labels, and shortcuts. */
export const DEV_OVERRIDE_REGISTRY: DevOverrideEntry[] = [
  {
    key: "forceOnboarding",
    label: "Onboarding wizard",
    description: "Force the onboarding gate to render even when credentials are valid",
    shortcutLabel: "Ctrl+Shift+1",
  },
]

// ─── Default state ──────────────────────────────────────────────────

const DEFAULT_OVERRIDES: DevOverrideMap = {
  forceOnboarding: false,
}

// ─── Context ────────────────────────────────────────────────────────

interface DevOverridesContextValue {
  /** Whether the host is source-dev (runtime-checked via /api/dev-mode). */
  isDevMode: boolean
  /** Whether dev-mode overrides are globally enabled (the master toggle). */
  enabled: boolean
  setEnabled: (enabled: boolean) => void
  /** Individual override values. Only effective when `enabled` is true. */
  overrides: DevOverrideMap
  /** Toggle an individual override. */
  toggle: (key: DevOverrideKey) => void
  /** Resolve an override: returns true only when master + individual are both on. */
  isActive: (key: DevOverrideKey) => boolean
}

const DevOverridesContext = createContext<DevOverridesContextValue | null>(null)

// ─── Provider ───────────────────────────────────────────────────────

export function DevOverridesProvider({ children }: { children: ReactNode }) {
  const [enabled, setEnabled] = useState(false)
  const [overrides, setOverrides] = useState<DevOverrideMap>(DEFAULT_OVERRIDES)
  const [isDevMode, setIsDevMode] = useState(BUILD_TIME_HINT)

  // Fetch authoritative dev-mode flag from the server at mount
  useEffect(() => {
    fetch("/api/dev-mode", { cache: "no-store" })
      .then((res) => res.json())
      .then((data: { isDevMode?: boolean }) => {
        if (data.isDevMode) {
          setIsDevMode(true)
          IS_DEV_MODE = true
        }
      })
      .catch(() => {
        // Non-critical — fall back to build-time hint
      })
  }, [])

  const toggle = useCallback((key: DevOverrideKey) => {
    setOverrides((prev) => ({ ...prev, [key]: !prev[key] }))
  }, [])

  const isActive = useCallback(
    (key: DevOverrideKey) => enabled && overrides[key],
    [enabled, overrides],
  )

  // ─── Global keyboard shortcuts ──────────────────────────────────
  useEffect(() => {
    if (!isDevMode) return

    function handleKeyDown(e: KeyboardEvent) {
      // Only fire when master toggle is on
      if (!enabled) return

      // Ctrl+Shift+1 → toggle forceOnboarding
      if (e.ctrlKey && e.shiftKey && e.key === "1") {
        e.preventDefault()
        setOverrides((prev) => ({ ...prev, forceOnboarding: !prev.forceOnboarding }))
      }
    }

    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [enabled, isDevMode])

  const value = useMemo<DevOverridesContextValue>(
    () => isDevMode
      ? { isDevMode, enabled, setEnabled, overrides, toggle, isActive }
      : {
          isDevMode: false,
          enabled: false,
          setEnabled: () => {},
          overrides: DEFAULT_OVERRIDES,
          toggle: () => {},
          isActive: () => false,
        },
    [isDevMode, enabled, setEnabled, overrides, toggle, isActive],
  )

  return (
    <DevOverridesContext.Provider value={value}>
      {children}
    </DevOverridesContext.Provider>
  )
}

// ─── Hook ───────────────────────────────────────────────────────────

export function useDevOverrides(): DevOverridesContextValue {
  const ctx = useContext(DevOverridesContext)
  if (!ctx) {
    throw new Error("useDevOverrides must be used within <DevOverridesProvider>")
  }
  return ctx
}
