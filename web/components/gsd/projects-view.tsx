"use client"

import { useEffect, useState, useCallback, useSyncExternalStore } from "react"
import { FolderOpen, Loader2, AlertCircle, Layers, Sparkles, ArrowUpCircle, GitBranch, FolderKanban, ArrowRight, CheckCircle2, FolderRoot } from "lucide-react"
import { cn } from "@/lib/utils"
import { useProjectStoreManager } from "@/lib/project-store-manager"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

// ─── Types (mirroring server-side ProjectMetadata) ─────────────────────────

type ProjectDetectionKind = "active-gsd" | "empty-gsd" | "v1-legacy" | "brownfield" | "blank"

interface ProjectDetectionSignals {
  hasGsdFolder: boolean
  hasPlanningFolder: boolean
  hasGitRepo: boolean
  hasPackageJson: boolean
  fileCount: number
  hasMilestones?: boolean
  hasCargo?: boolean
  hasGoMod?: boolean
  hasPyproject?: boolean
}

interface ProjectMetadata {
  name: string
  path: string
  kind: ProjectDetectionKind
  signals: ProjectDetectionSignals
  lastModified: number
}

// ─── Kind badge config ─────────────────────────────────────────────────────

const KIND_CONFIG: Record<ProjectDetectionKind, { label: string; className: string; icon: typeof FolderOpen }> = {
  "active-gsd": {
    label: "Active",
    className: "bg-emerald-500/15 text-emerald-400 border-emerald-500/25",
    icon: Layers,
  },
  "empty-gsd": {
    label: "Initialized",
    className: "bg-sky-500/15 text-sky-400 border-sky-500/25",
    icon: FolderOpen,
  },
  brownfield: {
    label: "Existing",
    className: "bg-amber-500/15 text-amber-400 border-amber-500/25",
    icon: GitBranch,
  },
  "v1-legacy": {
    label: "Legacy v1",
    className: "bg-orange-500/15 text-orange-400 border-orange-500/25",
    icon: ArrowUpCircle,
  },
  blank: {
    label: "Blank",
    className: "bg-zinc-500/15 text-zinc-400 border-zinc-500/25",
    icon: Sparkles,
  },
}

function describeSignals(signals: ProjectDetectionSignals): string {
  const parts: string[] = []
  if (signals.hasGitRepo) parts.push("Git")
  if (signals.hasPackageJson) parts.push("Node.js")
  if (signals.hasCargo) parts.push("Rust")
  if (signals.hasGoMod) parts.push("Go")
  if (signals.hasPyproject) parts.push("Python")
  if (parts.length === 0 && signals.fileCount > 0) parts.push(`${signals.fileCount} files`)
  return parts.join(" · ")
}

// ─── ProjectsView ──────────────────────────────────────────────────────────

export function ProjectsView() {
  const manager = useProjectStoreManager()
  const activeProjectCwd = useSyncExternalStore(manager.subscribe, manager.getSnapshot, manager.getSnapshot)

  const [projects, setProjects] = useState<ProjectMetadata[]>([])
  const [devRoot, setDevRoot] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const loadProjects = useCallback(async (root: string) => {
    const projRes = await fetch(`/api/projects?root=${encodeURIComponent(root)}`)
    if (!projRes.ok) throw new Error(`Failed to discover projects: ${projRes.status}`)
    return await projRes.json() as ProjectMetadata[]
  }, [])

  useEffect(() => {
    let cancelled = false

    async function load() {
      setLoading(true)
      setError(null)
      try {
        const prefsRes = await fetch("/api/preferences")
        if (!prefsRes.ok) throw new Error(`Failed to load preferences: ${prefsRes.status}`)
        const prefs = await prefsRes.json()

        if (!prefs.devRoot) {
          setDevRoot(null)
          setProjects([])
          setLoading(false)
          return
        }

        setDevRoot(prefs.devRoot)
        const discovered = await loadProjects(prefs.devRoot)
        if (!cancelled) setProjects(discovered)
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Unknown error")
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    load()
    return () => { cancelled = true }
  }, [loadProjects])

  /** Called after dev root is saved — refreshes the view with discovered projects */
  const handleDevRootSaved = useCallback(async (newRoot: string) => {
    setDevRoot(newRoot)
    setLoading(true)
    setError(null)
    try {
      const discovered = await loadProjects(newRoot)
      setProjects(discovered)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load projects")
    } finally {
      setLoading(false)
    }
  }, [loadProjects])

  function handleSelectProject(project: ProjectMetadata) {
    manager.switchProject(project.path)
    // Navigate to dashboard for the switched project
    window.dispatchEvent(
      new CustomEvent("gsd:navigate-view", { detail: { view: "dashboard" } })
    )
  }

  // ─── Loading state ─────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  // ─── Error state ───────────────────────────────────────────────────────

  if (error) {
    return (
      <div className="flex h-full items-center justify-center px-6">
        <div className="flex max-w-md flex-col items-center gap-3 text-center">
          <AlertCircle className="h-8 w-8 text-destructive" />
          <p className="text-sm text-destructive">{error}</p>
        </div>
      </div>
    )
  }

  // ─── No dev root configured ────────────────────────────────────────────

  if (!devRoot) {
    return <DevRootSetup onSaved={handleDevRootSaved} />
  }

  // ─── Dev root set, no projects found ───────────────────────────────────

  if (projects.length === 0) {
    return (
      <div className="flex h-full items-center justify-center px-6">
        <div className="flex max-w-md flex-col items-center gap-4 text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-muted">
            <FolderOpen className="h-7 w-7 text-muted-foreground" />
          </div>
          <div className="space-y-2">
            <h2 className="text-lg font-semibold text-foreground">No projects found</h2>
            <p className="text-sm text-muted-foreground leading-relaxed">
              No project directories were discovered in{" "}
              <code className="rounded bg-muted px-1.5 py-0.5 text-xs font-mono text-foreground">{devRoot}</code>
            </p>
          </div>
        </div>
      </div>
    )
  }

  // ─── Project grid ──────────────────────────────────────────────────────

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl px-6 py-6 space-y-6">
        {/* Header */}
        <div className="space-y-1">
          <h1 className="text-xl font-semibold text-foreground tracking-tight">Projects</h1>
          <p className="text-sm text-muted-foreground">
            <code className="rounded bg-muted px-1.5 py-0.5 text-xs font-mono">{devRoot}</code>
            <span className="ml-2 text-muted-foreground/60">·</span>
            <span className="ml-2">{projects.length} project{projects.length !== 1 ? "s" : ""}</span>
          </p>
        </div>

        {/* Grid */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {projects.map((project) => {
            const isActive = activeProjectCwd === project.path
            const config = KIND_CONFIG[project.kind]
            const BadgeIcon = config.icon
            const signalText = describeSignals(project.signals)

            return (
              <button
                key={project.path}
                onClick={() => handleSelectProject(project)}
                className={cn(
                  "group relative flex flex-col gap-3 rounded-lg border p-4 text-left transition-all",
                  "hover:bg-accent/50",
                  isActive
                    ? "border-primary/40 bg-primary/5 ring-1 ring-primary/20"
                    : "border-border bg-card",
                )}
              >
                {/* Active indicator dot */}
                {isActive && (
                  <div className="absolute right-3 top-3 h-2 w-2 rounded-full bg-primary animate-pulse" />
                )}

                {/* Name */}
                <div className="space-y-1 pr-4">
                  <h3 className="text-sm font-semibold text-foreground truncate">{project.name}</h3>
                  <p className="text-[11px] text-muted-foreground/60 font-mono truncate">{project.path}</p>
                </div>

                {/* Kind badge + signal chips */}
                <div className="flex items-center gap-2 flex-wrap">
                  <span
                    className={cn(
                      "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium",
                      config.className,
                    )}
                  >
                    <BadgeIcon className="h-3 w-3" />
                    {config.label}
                  </span>
                  {signalText && (
                    <span className="text-[10px] text-muted-foreground/50">{signalText}</span>
                  )}
                </div>
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}

// ─── Shared Dev Root Setup Component ────────────────────────────────────

const SUGGESTED_PATHS = ["~/Projects", "~/Developer", "~/Code", "~/dev"]

function DevRootSetup({ onSaved, currentRoot }: { onSaved: (root: string) => void; currentRoot?: string | null }) {
  const [path, setPath] = useState(currentRoot ?? "")
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)

  const handleSave = useCallback(async () => {
    const trimmed = path.trim()
    if (!trimmed) {
      setError("Enter a path to your projects folder")
      return
    }

    setSaving(true)
    setError(null)
    setSuccess(false)

    try {
      const res = await fetch("/api/preferences", {
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

      setSuccess(true)
      onSaved(trimmed)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save preference")
    } finally {
      setSaving(false)
    }
  }, [path, onSaved])

  const isCompact = !!currentRoot

  if (isCompact) {
    // Compact inline form for settings panel and project header
    return (
      <div className="space-y-3" data-testid="devroot-settings">
        <div className="flex gap-2">
          <Input
            value={path}
            onChange={(e) => {
              setPath(e.target.value)
              if (error) setError(null)
              if (success) setSuccess(false)
            }}
            placeholder="/Users/you/Projects"
            className={cn(
              "h-9 font-mono text-sm flex-1",
              error && "border-red-500/50 focus-visible:ring-red-500/30",
            )}
            onKeyDown={(e) => {
              if (e.key === "Enter" && path.trim()) void handleSave()
            }}
          />
          <Button
            size="sm"
            onClick={() => void handleSave()}
            disabled={saving || !path.trim() || (path.trim() === currentRoot)}
            className="h-9 gap-1.5 shrink-0"
          >
            {saving ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : success ? (
              <CheckCircle2 className="h-3.5 w-3.5" />
            ) : (
              "Save"
            )}
          </Button>
        </div>

        <div className="flex flex-wrap gap-1.5">
          {SUGGESTED_PATHS.map((suggestion) => (
            <button
              key={suggestion}
              type="button"
              onClick={() => { setPath(suggestion); setError(null); setSuccess(false) }}
              className={cn(
                "rounded-full border px-2.5 py-0.5 font-mono text-[11px] transition-colors",
                path === suggestion
                  ? "border-foreground/30 bg-foreground/10 text-foreground"
                  : "border-border/60 bg-card/40 text-muted-foreground hover:border-foreground/20 hover:text-foreground",
              )}
            >
              {suggestion}
            </button>
          ))}
        </div>

        {error && <p className="text-xs text-red-400">{error}</p>}
        {success && <p className="text-xs text-emerald-400">Dev root updated</p>}
      </div>
    )
  }

  // Full-page centered setup for first-time configuration
  return (
    <div className="flex h-full items-center justify-center px-6">
      <div className="flex max-w-md flex-col items-center gap-6 text-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-muted">
          <FolderRoot className="h-7 w-7 text-muted-foreground" />
        </div>
        <div className="space-y-2">
          <h2 className="text-lg font-semibold text-foreground">Set your development root</h2>
          <p className="text-sm text-muted-foreground leading-relaxed">
            The folder that contains your projects. GSD will scan it for project directories.
          </p>
        </div>

        <div className="w-full space-y-3">
          <div className="flex gap-2">
            <Input
              value={path}
              onChange={(e) => {
                setPath(e.target.value)
                if (error) setError(null)
              }}
              placeholder="/Users/you/Projects"
              className={cn(
                "h-10 font-mono text-sm flex-1",
                error && "border-red-500/50 focus-visible:ring-red-500/30",
              )}
              data-testid="projects-devroot-input"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter" && path.trim()) void handleSave()
              }}
            />
            <Button
              onClick={() => void handleSave()}
              disabled={saving || !path.trim()}
              className="h-10 gap-2 shrink-0"
              data-testid="projects-devroot-save"
            >
              {saving ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <>
                  Set Root
                  <ArrowRight className="h-4 w-4" />
                </>
              )}
            </Button>
          </div>

          <div className="flex flex-wrap items-center justify-center gap-2">
            <span className="text-[11px] text-muted-foreground">Suggestions:</span>
            {SUGGESTED_PATHS.map((suggestion) => (
              <button
                key={suggestion}
                type="button"
                onClick={() => { setPath(suggestion); setError(null) }}
                className={cn(
                  "rounded-full border px-2.5 py-0.5 font-mono text-[11px] transition-colors",
                  path === suggestion
                    ? "border-foreground/30 bg-foreground/10 text-foreground"
                    : "border-border/60 bg-card/40 text-muted-foreground hover:border-foreground/20 hover:text-foreground",
                )}
              >
                {suggestion}
              </button>
            ))}
          </div>

          {error && <p className="text-sm text-red-400">{error}</p>}
        </div>
      </div>
    </div>
  )
}

// ─── Exported Dev Root Section for Settings ──────────────────────────────

export function DevRootSettingsSection() {
  const [devRoot, setDevRoot] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch("/api/preferences")
      .then((r) => r.json())
      .then((prefs) => setDevRoot(prefs.devRoot ?? null))
      .catch(() => setDevRoot(null))
      .finally(() => setLoading(false))
  }, [])

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-4 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Loading preferences…
      </div>
    )
  }

  return (
    <div className="space-y-3" data-testid="settings-devroot">
      <div className="flex items-center gap-2.5">
        <FolderRoot className="h-3.5 w-3.5 text-muted-foreground" />
        <h3 className="text-[13px] font-semibold uppercase tracking-[0.08em] text-foreground/70">
          Development Root
        </h3>
      </div>
      <p className="text-xs text-muted-foreground leading-relaxed">
        The parent folder containing your project directories. GSD scans one level deep for projects.
      </p>
      <DevRootSetup
        currentRoot={devRoot ?? ""}
        onSaved={(root) => setDevRoot(root)}
      />
    </div>
  )
}
