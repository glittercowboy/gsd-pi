"use client"

import { useCallback, useEffect, useState } from "react"
import { motion, AnimatePresence } from "motion/react"
import {
  ArrowRight,
  ChevronRight,
  CornerLeftUp,
  Folder,
  FolderOpen,
  FolderRoot,
  Loader2,
  SkipForward,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"
import { authFetch } from "@/lib/auth"

interface StepDevRootProps {
  onNext: () => void
  onBack: () => void
}

const SUGGESTED_PATHS = ["~/Projects", "~/Developer", "~/Code", "~/dev"]

// ─── Inline folder browser ──────────────────────────────────────────

interface BrowseEntry {
  name: string
  path: string
}

function InlineFolderBrowser({
  onSelect,
  onCancel,
}: {
  onSelect: (path: string) => void
  onCancel: () => void
}) {
  const [currentPath, setCurrentPath] = useState("")
  const [parentPath, setParentPath] = useState<string | null>(null)
  const [entries, setEntries] = useState<BrowseEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const browse = useCallback(async (targetPath?: string) => {
    setLoading(true)
    setError(null)
    try {
      const param = targetPath ? `?path=${encodeURIComponent(targetPath)}` : ""
      const res = await authFetch(`/api/browse-directories${param}`)
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error((body as { error?: string }).error ?? `${res.status}`)
      }
      const data = (await res.json()) as { current: string; parent: string | null; entries: BrowseEntry[] }
      setCurrentPath(data.current)
      setParentPath(data.parent)
      setEntries(data.entries)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to browse")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void browse()
  }, [browse])

  return (
    <div className="rounded-xl border border-border/50 bg-card/50 overflow-hidden">
      {/* Current path */}
      <div className="flex items-center justify-between gap-2 border-b border-border/50 px-4 py-2.5">
        <p className="min-w-0 truncate font-mono text-xs text-muted-foreground" title={currentPath}>
          {currentPath}
        </p>
        <Button
          type="button"
          size="sm"
          onClick={() => onSelect(currentPath)}
          className="shrink-0 h-7 gap-1.5 text-xs transition-transform active:scale-[0.96]"
        >
          Select this folder
        </Button>
      </div>

      {/* Directory listing */}
      <ScrollArea className="h-[240px]">
        <div className="px-1.5 py-1">
          {loading && (
            <div className="flex items-center justify-center py-10">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            </div>
          )}

          {error && (
            <div className="px-3 py-4 text-center text-xs text-destructive">{error}</div>
          )}

          {!loading && !error && (
            <>
              {parentPath && (
                <button
                  type="button"
                  onClick={() => void browse(parentPath)}
                  className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm transition-colors hover:bg-accent/50"
                >
                  <CornerLeftUp className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="text-muted-foreground">..</span>
                </button>
              )}

              {entries.map((entry) => (
                <button
                  key={entry.path}
                  type="button"
                  onClick={() => void browse(entry.path)}
                  className="group flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm transition-colors hover:bg-accent/50"
                >
                  <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate text-foreground">{entry.name}</span>
                  <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground/50 opacity-0 transition-opacity group-hover:opacity-100" />
                </button>
              ))}

              {entries.length === 0 && !parentPath && (
                <div className="px-3 py-8 text-center text-xs text-muted-foreground">
                  No subdirectories
                </div>
              )}
            </>
          )}
        </div>
      </ScrollArea>

      {/* Cancel */}
      <div className="border-t border-border/50 px-4 py-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onCancel}
          className="h-7 text-xs text-muted-foreground"
        >
          Cancel
        </Button>
      </div>
    </div>
  )
}

// ─── Main step ──────────────────────────────────────────────────────

export function StepDevRoot({ onNext, onBack }: StepDevRootProps) {
  const [path, setPath] = useState("")
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [browsing, setBrowsing] = useState(false)

  const handleSuggestionClick = useCallback((suggestion: string) => {
    setPath(suggestion)
    setError(null)
  }, [])

  const handleContinue = useCallback(async () => {
    const trimmed = path.trim()
    if (!trimmed) {
      setError("Enter a path or skip this step")
      return
    }

    setSaving(true)
    setError(null)

    try {
      const res = await authFetch("/api/preferences", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ devRoot: trimmed }),
      })

      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(
          (body as { error?: string }).error ?? `Request failed (${res.status})`,
        )
      }

      onNext()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save preference")
    } finally {
      setSaving(false)
    }
  }, [path, onNext])

  return (
    <div className="flex flex-col items-center text-center">
      {/* Icon */}
      <motion.div
        initial={{ opacity: 0, scale: 0.85 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ type: "spring", duration: 0.5, bounce: 0 }}
        className="mb-8"
      >
        <div className="flex h-14 w-14 items-center justify-center rounded-xl border border-border/50 bg-card/50">
          <FolderRoot className="h-7 w-7 text-foreground/80" strokeWidth={1.5} />
        </div>
      </motion.div>

      <motion.h2
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.06, duration: 0.4 }}
        className="text-2xl font-bold tracking-tight text-foreground sm:text-3xl"
      >
        Dev root
      </motion.h2>

      <motion.p
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.12, duration: 0.4 }}
        className="mt-2 max-w-sm text-sm leading-relaxed text-muted-foreground"
      >
        The folder that contains your projects. GSD discovers and manages workspaces inside it.
      </motion.p>

      {/* Input + browse */}
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.18, duration: 0.45 }}
        className="mt-8 w-full max-w-md space-y-4"
      >
        <AnimatePresence mode="wait">
          {browsing ? (
            <motion.div
              key="browser"
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.2 }}
            >
              <InlineFolderBrowser
                onSelect={(selected) => {
                  setPath(selected)
                  setBrowsing(false)
                  setError(null)
                }}
                onCancel={() => setBrowsing(false)}
              />
            </motion.div>
          ) : (
            <motion.div key="input" className="space-y-4">
              <div className="flex gap-2">
                <Input
                  value={path}
                  onChange={(e) => {
                    setPath(e.target.value)
                    if (error) setError(null)
                  }}
                  placeholder="/Users/you/Projects"
                  className={cn(
                    "h-11 flex-1 font-mono text-sm",
                    error && "border-destructive/50 focus-visible:ring-destructive/30",
                  )}
                  data-testid="onboarding-devroot-input"
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && path.trim()) {
                      void handleContinue()
                    }
                  }}
                />
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setBrowsing(true)}
                  className="h-11 gap-2 shrink-0 transition-transform active:scale-[0.96]"
                >
                  <FolderOpen className="h-4 w-4" />
                  Browse
                </Button>
              </div>

              {error && (
                <p className="text-sm text-destructive" role="alert">
                  {error}
                </p>
              )}

              {/* Suggestions */}
              <div className="flex flex-wrap items-center justify-center gap-2">
                {SUGGESTED_PATHS.map((suggestion) => (
                  <button
                    key={suggestion}
                    type="button"
                    onClick={() => handleSuggestionClick(suggestion)}
                    className={cn(
                      "rounded-full border px-3 py-1 font-mono text-xs transition-all duration-150",
                      "active:scale-[0.96]",
                      path === suggestion
                        ? "border-foreground/25 bg-foreground/10 text-foreground"
                        : "border-border/50 text-muted-foreground hover:border-foreground/15 hover:text-foreground",
                    )}
                  >
                    {suggestion}
                  </button>
                ))}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>

      {/* Navigation */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.25, duration: 0.3 }}
        className="mt-8 flex w-full max-w-md items-center justify-between"
      >
        <Button
          variant="ghost"
          onClick={onBack}
          className="text-muted-foreground transition-transform active:scale-[0.96]"
        >
          Back
        </Button>

        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            onClick={onNext}
            className="gap-1.5 text-muted-foreground transition-transform active:scale-[0.96]"
            data-testid="onboarding-devroot-skip"
          >
            Skip
            <SkipForward className="h-3.5 w-3.5" />
          </Button>

          <Button
            onClick={() => void handleContinue()}
            className="group gap-2 transition-transform active:scale-[0.96]"
            disabled={saving || browsing}
            data-testid="onboarding-devroot-continue"
          >
            {saving ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Saving…
              </>
            ) : (
              <>
                Continue
                <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
              </>
            )}
          </Button>
        </div>
      </motion.div>
    </div>
  )
}
