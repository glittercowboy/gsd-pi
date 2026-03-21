"use client"

import { useCallback, useSyncExternalStore } from "react"

// ─── Types ──────────────────────────────────────────────────────────

export type UserMode = "expert" | "vibe-coder"

// ─── Storage ────────────────────────────────────────────────────────

const STORAGE_KEY = "gsd-user-mode"
const DEFAULT_MODE: UserMode = "expert"

const listeners = new Set<() => void>()

function notify(): void {
  listeners.forEach((cb) => cb())
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

function getSnapshot(): UserMode {
  if (typeof window === "undefined") return DEFAULT_MODE
  const stored = localStorage.getItem(STORAGE_KEY)
  if (stored === "expert" || stored === "vibe-coder") return stored
  return DEFAULT_MODE
}

function getServerSnapshot(): UserMode {
  return DEFAULT_MODE
}

// ─── Imperative API (for use outside React) ─────────────────────────

/** Read current mode without a hook. Safe to call from event handlers. */
export function getUserMode(): UserMode {
  return getSnapshot()
}

/** Write mode to localStorage and notify React subscribers. */
export function setUserMode(mode: UserMode): void {
  localStorage.setItem(STORAGE_KEY, mode)
  notify()
}

/** Clear stored mode (reverts to default). */
export function clearUserMode(): void {
  localStorage.removeItem(STORAGE_KEY)
  notify()
}

// ─── React Hook ─────────────────────────────────────────────────────

export function useUserMode(): [UserMode, (mode: UserMode) => void] {
  const mode = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
  const set = useCallback((m: UserMode) => setUserMode(m), [])
  return [mode, set]
}
