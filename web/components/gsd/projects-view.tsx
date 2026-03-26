"use client"

import Image from "next/image"
import { useEffect, useState, useCallback, useRef, useSyncExternalStore } from "react"
import {
  FolderOpen,
  Loader2,
  AlertCircle,
  Layers,
  Sparkles,
  ArrowUpCircle,
  GitBranch,
  CheckCircle2,
  FolderRoot,
  Plus,
  ArrowRight,
  X,
  ChevronRight,
  Folder,
  CornerLeftUp,
  Search,
  Clock,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { useProjectStoreManager } from "@/lib/project-store-manager"
import {
  useGSDWorkspaceState,
  getLiveWorkspaceIndex,
  getLiveAutoDashboard,
  formatCost,
  getCurrentSlice,
} from "@/lib/gsd-workspace-store"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { ScrollArea } from "@/components/ui/scroll-area"
import { authFetch } from "@/lib/auth"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

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

interface ProjectProgressInfo {
  activeMilestone: string | null
  activeSlice: string | null
  phase: string | null
  milestonesCompleted: number
  milestonesTotal: number
}

interface ProjectMetadata {
  name: string
  path: string
  kind: ProjectDetectionKind
  signals: ProjectDetectionSignals
  lastModified: number
  progress?: ProjectProgressInfo | null
}

// ─── Kind style config ─────────────────────────────────────────────────

const KIND_STYLE: Record<ProjectDetectionKind, { label: string; color: string; bgClass: string; icon: typeof Layers }> = {
  "active-gsd": {
    label: "Active",
    color: "text-success",
    bgClass: "bg-success/10",
    icon: Layers,
  },
  "empty-gsd": {
    label: "Initialized",
    color: "text-info",
    bgClass: "bg-info/10",
    icon: FolderOpen,
  },
  brownfield: {
    label: "Existing",
    color: "text-warning",
    bgClass: "bg-warning/10",
    icon: GitBranch,
  },
  "v1-legacy": {
    label: "Legacy",
    color: "text-warning",
    bgClass: "bg-warning/10",
    icon: ArrowUpCircle,
  },
  blank: {
    label: "New",
    color: "text-muted-foreground",
    bgClass: "bg-foreground/[0.04]",
    icon: Sparkles,
  },
}

function techStack(signals: ProjectDetectionSignals): string[] {
  const tags: string[] = []
  if (signals.hasGitRepo) tags.push("Git")
  if (signals.hasPackageJson) tags.push("Node.js")
  if (signals.hasCargo) tags.push("Rust")
  if (signals.hasGoMod) tags.push("Go")
  if (signals.hasPyproject) tags.push("Python")
  return tags
}

function progressLabel(p: ProjectProgressInfo): string | null {
  if (p.milestonesTotal === 0) return null
  const parts: string[] = []
  if (p.activeMilestone) parts.push(p.activeMilestone)
  if (p.activeSlice) parts.push(p.activeSlice)
  if (p.phase) parts.push(p.phase)
  return parts.join(" · ") || null
}

function relativeTime(timestamp: number): string {
  const now = Date.now()
  const diffMs = now - timestamp
  if (diffMs < 60_000) return "just now"
  const minutes = Math.floor(diffMs / 60_000)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  return new Date(timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric" })
}

// ─── Shared project card component ─────────────────────────────────────

function ProjectCard({
  project,
  isActive = false,
  onClick,
  disabled = false,
}: {
  project: ProjectMetadata
  isActive?: boolean
  onClick: () => void
  disabled?: boolean
}) {
  const style = KIND_STYLE[project.kind]
  const KindIcon = style.icon
  const stack = techStack(project.signals)
  const progress = project.progress ? progressLabel(project.progress) : null
  const milestoneCount = project.progress
    ? `${project.progress.milestonesCompleted}/${project.progress.milestonesTotal}`
    : null

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "group flex w-full items-start gap-3.5 rounded-xl border px-4 py-3.5 text-left transition-all duration-200",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        "active:scale-[0.98]",
        isActive
          ? "border-primary/30 bg-primary/[0.08]"
          : "border-border/50 bg-card/50 hover:border-foreground/15 hover:bg-card/50",
        disabled && "opacity-40 pointer-events-none",
      )}
    >
      {/* Icon */}
      <div
        className={cn(
          "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg mt-0.5",
          isActive ? "bg-primary/15" : style.bgClass,
        )}
      >
        {isActive ? (
          <CheckCircle2 className="h-4 w-4 text-primary" />
        ) : (
          <KindIcon className={cn("h-4 w-4", style.color)} />
        )}
      </div>

      {/* Content */}
      <div className="min-w-0 flex-1">
        {/* Row 1: name + kind badge */}
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-foreground truncate">{project.name}</span>
          <span className={cn("text-[10px] font-medium shrink-0", isActive ? "text-primary" : style.color)}>
            {isActive ? "Current" : style.label}
          </span>
        </div>

        {/* Row 2: tech stack tags */}
        {stack.length > 0 && (
          <div className="mt-1 flex items-center gap-1.5">
            {stack.map((tag) => (
              <span
                key={tag}
                className="rounded bg-foreground/[0.06] px-1.5 py-0.5 text-[10px] text-muted-foreground"
              >
                {tag}
              </span>
            ))}
          </div>
        )}

        {/* Row 3: progress info */}
        {progress && (
          <div className="mt-1.5 text-[11px] text-muted-foreground">{progress}</div>
        )}

        {/* Row 4: milestone progress bar */}
        {project.progress && project.progress.milestonesTotal > 0 && (
          <div className="mt-2 flex items-center gap-2">
            <div className="h-1 flex-1 overflow-hidden rounded-full bg-foreground/[0.08]">
              <div
                className="h-full rounded-full bg-success/70 transition-all"
                style={{
                  width: `${Math.round(
                    (project.progress.milestonesCompleted / project.progress.milestonesTotal) * 100,
                  )}%`,
                }}
              />
            </div>
            <span className="text-[10px] tabular-nums text-muted-foreground">{milestoneCount}</span>
          </div>
        )}
      </div>

      {/* Arrow */}
      <ArrowRight className="mt-1 h-4 w-4 shrink-0 text-muted-foreground/50 transition-all group-hover:text-muted-foreground group-hover:translate-x-0.5" />
    </button>
  )
}

// ─── ProjectsPanel (slide-out sheet from sidebar) ──────────────────────

export function ProjectsPanel({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const manager = useProjectStoreManager()
  const activeProjectCwd = useSyncExternalStore(manager.subscribe, manager.getSnapshot, manager.getSnapshot)

  const [projects, setProjects] = useState<ProjectMetadata[]>([])
  const [devRoot, setDevRoot] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const loadProjects = useCallback(async (root: string) => {
    const projRes = await authFetch(`/api/projects?root=${encodeURIComponent(root)}&detail=true`)
    if (!projRes.ok) throw new Error(`Failed to discover projects: ${projRes.status}`)
    return (await projRes.json()) as ProjectMetadata[]
  }, [])

  // Load projects when panel opens
  useEffect(() => {
    if (!open) return
    let cancelled = false

    async function load() {
      setLoading(true)
      setError(null)
      try {
        const prefsRes = await authFetch("/api/preferences")
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
    return () => {
      cancelled = true
    }
  }, [open, loadProjects])

  const handleDevRootSaved = useCallback(
    async (newRoot: string) => {
      setLoading(true)
      setError(null)
      try {
        // Validate path and persist in a single call
        const res = await authFetch("/api/switch-root", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ devRoot: newRoot }),
        })

        if (!res.ok) {
          const body = await res.json().catch(() => ({}))
          throw new Error((body as { error?: string }).error ?? `Request failed (${res.status})`)
        }

        const data = await res.json() as { devRoot: string; projects: ProjectMetadata[] }
        setDevRoot(data.devRoot)
        setProjects(data.projects)
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to switch project root")
      } finally {
        setLoading(false)
      }
    },
    [],
  )

  const [newProjectOpen, setNewProjectOpen] = useState(false)
  const [changeRootOpen, setChangeRootOpen] = useState(false)
  const workspaceState = useGSDWorkspaceState()

  const handleProjectCreated = useCallback(
    (newProject: ProjectMetadata) => {
      setProjects((prev) => [...prev, newProject].sort((a, b) => a.name.localeCompare(b.name)))
      setNewProjectOpen(false)
      handleSelectProject(newProject)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )

  function handleSelectProject(project: ProjectMetadata) {
    // Already active — just close the panel
    if (activeProjectCwd === project.path) {
      onOpenChange(false)
      return
    }

    // Close panel immediately — boot happens in the background with a
    // loading toast managed by WorkspaceChrome
    onOpenChange(false)
    manager.switchProject(project.path)
    window.dispatchEvent(new CustomEvent("gsd:navigate-view", { detail: { view: "dashboard" } }))
  }

  // Sort: active-gsd first, then by name
  const sortedProjects = [...projects].sort((a, b) => {
    const kindOrder: Record<ProjectDetectionKind, number> = {
      "active-gsd": 0,
      "empty-gsd": 1,
      brownfield: 2,
      "v1-legacy": 3,
      blank: 4,
    }
    const ka = kindOrder[a.kind] ?? 5
    const kb = kindOrder[b.kind] ?? 5
    if (ka !== kb) return ka - kb
    return a.name.localeCompare(b.name)
  })

  // ─── Content for the various states ──────────────────────────────

  let content: React.ReactNode

  if (loading) {
    content = (
      <div className="flex items-center justify-center gap-2 py-16 text-xs text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Discovering projects…
      </div>
    )
  } else if (error) {
    content = (
      <div className="flex flex-col items-center gap-3 px-5 py-16 text-center">
        <AlertCircle className="h-8 w-8 text-destructive" />
        <p className="text-sm text-destructive">{error}</p>
      </div>
    )
  } else if (!devRoot) {
    content = <DevRootSetup onSaved={handleDevRootSaved} />
  } else if (sortedProjects.length === 0) {
    content = (
      <div className="flex flex-col items-center gap-4 px-5 py-16 text-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-muted">
          <FolderOpen className="h-7 w-7 text-muted-foreground" />
        </div>
        <div className="space-y-2">
          <h3 className="text-base font-semibold text-foreground">No projects found</h3>
          <p className="text-sm text-muted-foreground leading-relaxed">
            No project directories discovered in{" "}
            <code className="rounded bg-muted px-1.5 py-0.5 text-xs font-mono text-foreground">
              {devRoot}
            </code>
          </p>
        </div>
      </div>
    )
  } else {
    content = (
      <div className="space-y-2">
        {/* Project cards */}
        {sortedProjects.map((project) => (
          <ProjectCard
            key={project.path}
            project={project}
            isActive={activeProjectCwd === project.path}
            onClick={() => handleSelectProject(project)}
          />
        ))}

        {/* Create new project button */}
        <button
          type="button"
          onClick={() => setNewProjectOpen(true)}
          className={cn(
            "flex w-full items-center gap-3.5 rounded-xl border border-dashed px-4 py-3.5 text-left transition-all duration-200",
            "border-border/50 text-muted-foreground hover:border-foreground/15 hover:text-foreground",
            "active:scale-[0.98]",
          )}
        >
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-foreground/[0.04]">
            <Plus className="h-4 w-4" />
          </div>
          <div>
            <span className="text-sm font-medium">Create new project</span>
            <p className="mt-0.5 text-[11px] text-muted-foreground">Initialize a new directory with Git</p>
          </div>
        </button>

        {/* New project dialog */}
        <NewProjectDialog
          open={newProjectOpen}
          onOpenChange={setNewProjectOpen}
          devRoot={devRoot}
          existingNames={projects.map((p) => p.name)}
          onCreated={handleProjectCreated}
        />
      </div>
    )
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="left" className="flex h-full w-full flex-col p-0 sm:max-w-[420px]" data-testid="projects-panel">
        <SheetHeader className="sr-only">
          <SheetTitle>Projects</SheetTitle>
          <SheetDescription>Switch between projects or create a new one</SheetDescription>
        </SheetHeader>

        {/* Visible header */}
        <div className="flex items-center justify-between border-b border-border/50 px-5 py-4">
          <div>
            <h2 className="text-base font-semibold text-foreground">Projects</h2>
            {devRoot && !loading && (
              <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                <code className="rounded bg-muted px-1 py-0.5 font-mono text-[10px] truncate max-w-[200px]">{devRoot}</code>
                <button
                  type="button"
                  onClick={() => setChangeRootOpen(true)}
                  className="shrink-0 text-[10px] text-primary hover:text-primary/80 transition-colors font-medium"
                  data-testid="projects-panel-change-root"
                >
                  Change
                </button>
                <span className="text-muted-foreground">·</span>
                <span>{projects.length} project{projects.length !== 1 ? "s" : ""}</span>
              </div>
            )}
          </div>
          <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={() => onOpenChange(false)}>
            <X className="h-4 w-4" />
          </Button>
        </div>

        {/* Scrollable project list */}
        <ScrollArea className="min-h-0 flex-1">
          <div className="px-5 py-4">{content}</div>
        </ScrollArea>

        {/* Folder picker for changing dev root */}
        <FolderPickerDialog
          open={changeRootOpen}
          onOpenChange={setChangeRootOpen}
          onSelect={(path) => void handleDevRootSaved(path)}
          initialPath={devRoot}
        />
      </SheetContent>
    </Sheet>
  )
}

// ─── Active project inline summary (compact for panel card) ────────────

function ActiveProjectSummary({ workspaceState }: { workspaceState: ReturnType<typeof useGSDWorkspaceState> }) {
  const workspace = getLiveWorkspaceIndex(workspaceState)
  const dashboard = getLiveAutoDashboard(workspaceState)
  const currentSlice = getCurrentSlice(workspace)

  if (!workspace) return null

  const activeMilestone = workspace.milestones.find((m) => m.id === workspace.active.milestoneId)
  const cost = dashboard?.totalCost ?? 0

  const parts: string[] = []
  if (activeMilestone) parts.push(activeMilestone.id)
  if (currentSlice) parts.push(currentSlice.id)
  if (cost > 0) parts.push(formatCost(cost))

  if (parts.length === 0) return null

  return <div className="mt-1.5 text-[11px] text-muted-foreground">{parts.join(" · ")}</div>
}

// ─── New Project Dialog ────────────────────────────────────────────────

function NewProjectDialog({
  open,
  onOpenChange,
  devRoot,
  existingNames,
  onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  devRoot: string
  existingNames: string[]
  onCreated: (project: ProjectMetadata) => void
}) {
  const [name, setName] = useState("")
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) {
      setName("")
      setError(null)
      setCreating(false)
      const t = setTimeout(() => inputRef.current?.focus(), 100)
      return () => clearTimeout(t)
    }
  }, [open])

  const nameValid = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name)
  const nameConflict = existingNames.includes(name)
  const canSubmit = name.length > 0 && nameValid && !nameConflict && !creating

  const validationHint = (() => {
    if (!name) return null
    if (nameConflict) return "A project with this name already exists"
    if (!nameValid) return "Use letters, numbers, hyphens, underscores, dots. Must start with a letter or number."
    return null
  })()

  async function handleCreate() {
    if (!canSubmit) return
    setCreating(true)
    setError(null)
    try {
      const res = await authFetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ devRoot, name }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error((body as { error?: string }).error ?? `Failed (${res.status})`)
      }
      const project = (await res.json()) as ProjectMetadata
      onCreated(project)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create project")
      setCreating(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New Project</DialogTitle>
          <DialogDescription>
            Create a new project directory in{" "}
            <code className="rounded bg-muted px-1 py-0.5 text-xs font-mono">{devRoot}</code>
          </DialogDescription>
        </DialogHeader>

        <form
          onSubmit={(e) => {
            e.preventDefault()
            void handleCreate()
          }}
          className="space-y-4 py-2"
        >
          <div className="space-y-2">
            <Label htmlFor="project-name">Project name</Label>
            <Input
              ref={inputRef}
              id="project-name"
              placeholder="my-project"
              value={name}
              onChange={(e) => {
                setName(e.target.value)
                setError(null)
              }}
              autoComplete="off"
              aria-invalid={!!validationHint}
            />
            {validationHint && <p className="text-xs text-destructive">{validationHint}</p>}
            {error && <p className="text-xs text-destructive">{error}</p>}
            {name && nameValid && !nameConflict && (
              <p className="text-xs text-muted-foreground font-mono">
                {devRoot}/{name}
              </p>
            )}
          </div>
        </form>

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)} disabled={creating}>
            Cancel
          </Button>
          <Button size="sm" onClick={() => void handleCreate()} disabled={!canSubmit} className="gap-1.5">
            {creating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ─── Folder Picker Dialog ───────────────────────────────────────────────

interface BrowseEntry {
  name: string
  path: string
}

interface BrowseResult {
  current: string
  parent: string | null
  entries: BrowseEntry[]
}

function FolderPickerDialog({
  open,
  onOpenChange,
  onSelect,
  initialPath,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSelect: (path: string) => void
  initialPath?: string | null
}) {
  const [currentPath, setCurrentPath] = useState<string>("")
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
      const data: BrowseResult = await res.json()
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
    if (open) {
      void browse(initialPath ?? undefined)
    }
  }, [open, initialPath, browse])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg gap-0 p-0 overflow-hidden">
        <DialogHeader className="px-5 pt-5 pb-3">
          <DialogTitle className="text-base">Choose Folder</DialogTitle>
          <DialogDescription className="text-xs">
            Navigate to the folder that contains your project directories.
          </DialogDescription>
        </DialogHeader>

        <div className="border-y border-border/50 bg-muted/50 px-5 py-2">
          <p className="font-mono text-xs text-muted-foreground truncate" title={currentPath}>
            {currentPath}
          </p>
        </div>

        <ScrollArea className="h-[320px]">
          <div className="px-2 py-1">
            {loading && (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            )}

            {error && <div className="px-3 py-4 text-center text-xs text-destructive">{error}</div>}

            {!loading && !error && (
              <>
                {parentPath && (
                  <button
                    onClick={() => void browse(parentPath)}
                    className="flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-sm transition-colors hover:bg-accent/50"
                  >
                    <CornerLeftUp className="h-4 w-4 text-muted-foreground shrink-0" />
                    <span className="text-muted-foreground">..</span>
                  </button>
                )}

                {entries.map((entry) => (
                  <button
                    key={entry.path}
                    onClick={() => void browse(entry.path)}
                    className="flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-sm transition-colors hover:bg-accent/50 group"
                  >
                    <Folder className="h-4 w-4 text-muted-foreground shrink-0" />
                    <span className="text-foreground truncate flex-1">{entry.name}</span>
                    <ChevronRight className="h-3.5 w-3.5 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
                  </button>
                ))}

                {!parentPath && entries.length === 0 && (
                  <div className="px-3 py-8 text-center text-xs text-muted-foreground">No subdirectories</div>
                )}
              </>
            )}
          </div>
        </ScrollArea>

        <DialogFooter className="border-t border-border/50 px-5 py-3">
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={() => {
              onSelect(currentPath)
              onOpenChange(false)
            }}
            disabled={!currentPath}
            className="gap-1.5"
          >
            <FolderOpen className="h-3.5 w-3.5" />
            Select This Folder
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ─── Dev Root Setup Component ───────────────────────────────────────────

function DevRootSetup({
  onSaved,
  currentRoot,
}: {
  onSaved: (root: string) => void
  currentRoot?: string | null
}) {
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)

  const handleSave = useCallback(
    async (selectedPath: string) => {
      setSaving(true)
      setError(null)
      setSuccess(false)

      try {
        const res = await authFetch("/api/preferences", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ devRoot: selectedPath }),
        })

        if (!res.ok) {
          const body = await res.json().catch(() => ({}))
          throw new Error((body as { error?: string }).error ?? `Request failed (${res.status})`)
        }

        setSuccess(true)
        onSaved(selectedPath)
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to save preference")
      } finally {
        setSaving(false)
      }
    },
    [onSaved],
  )

  const isCompact = !!currentRoot

  if (isCompact) {
    return (
      <div className="space-y-3" data-testid="devroot-settings">
        <div className="flex items-center gap-2">
          <code className="flex-1 truncate rounded border border-border/50 bg-muted/50 px-3 py-2 font-mono text-xs text-foreground">
            {currentRoot}
          </code>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setPickerOpen(true)}
            disabled={saving}
            className="h-9 gap-1.5 shrink-0"
          >
            {saving ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : success ? (
              <CheckCircle2 className="h-3.5 w-3.5 text-success" />
            ) : (
              <>
                <FolderOpen className="h-3.5 w-3.5" />
                Change
              </>
            )}
          </Button>
        </div>

        {error && <p className="text-xs text-destructive">{error}</p>}
        {success && <p className="text-xs text-success">Dev root updated</p>}

        <FolderPickerDialog
          open={pickerOpen}
          onOpenChange={setPickerOpen}
          onSelect={(path) => void handleSave(path)}
          initialPath={currentRoot}
        />
      </div>
    )
  }

  // Inline setup for first-time configuration
  return (
    <div className="rounded-md border border-border bg-card p-6">
      <div className="flex items-start gap-4">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-border bg-accent">
          <FolderRoot className="h-5 w-5 text-muted-foreground" />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-foreground">Set your development root</h3>
          <p className="mt-1 text-xs text-muted-foreground leading-relaxed">
            Point GSD at the folder that contains your project directories. It scans one level deep.
          </p>
          <Button
            onClick={() => setPickerOpen(true)}
            disabled={saving}
            size="sm"
            className="mt-3 gap-2"
            data-testid="projects-devroot-browse"
          >
            {saving ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <>
                <FolderOpen className="h-3.5 w-3.5" />
                Browse
              </>
            )}
          </Button>
          {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
        </div>
      </div>

      <FolderPickerDialog open={pickerOpen} onOpenChange={setPickerOpen} onSelect={(path) => void handleSave(path)} />
    </div>
  )
}

// ─── Exported Dev Root Section for Settings ──────────────────────────────

export function DevRootSettingsSection() {
  const [devRoot, setDevRoot] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    authFetch("/api/preferences")
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
        <h3 className="text-[13px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
          Development Root
        </h3>
      </div>
      <p className="text-xs text-muted-foreground leading-relaxed">
        The parent folder containing your project directories. GSD scans one level deep for projects.
      </p>
      <DevRootSetup currentRoot={devRoot ?? ""} onSaved={(root) => setDevRoot(root)} />
    </div>
  )
}

// ─── Project Selection Gate ─────────────────────────────────────────────
//
// Full-screen IDE-style welcome shown before any project is opened.
// Designed to feel like opening the app — not a wizard or onboarding flow.
// Mirrors the app shell layout: header bar, sidebar-width left column,
// project list as the main content area.

export function ProjectSelectionGate() {
  const manager = useProjectStoreManager()

  const [projects, setProjects] = useState<ProjectMetadata[]>([])
  const [devRoot, setDevRoot] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [newProjectOpen, setNewProjectOpen] = useState(false)
  const [changeRootOpen, setChangeRootOpen] = useState(false)
  const [filter, setFilter] = useState("")

  const loadProjects = useCallback(async (root: string) => {
    const projRes = await authFetch(`/api/projects?root=${encodeURIComponent(root)}&detail=true`)
    if (!projRes.ok) throw new Error(`Failed to discover projects: ${projRes.status}`)
    return (await projRes.json()) as ProjectMetadata[]
  }, [])

  useEffect(() => {
    let cancelled = false

    async function load() {
      setLoading(true)
      setError(null)
      try {
        const prefsRes = await authFetch("/api/preferences")
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
    return () => {
      cancelled = true
    }
  }, [loadProjects])

  const handleDevRootSaved = useCallback(
    async (newRoot: string) => {
      setLoading(true)
      setError(null)
      try {
        const res = await authFetch("/api/switch-root", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ devRoot: newRoot }),
        })

        if (!res.ok) {
          const body = await res.json().catch(() => ({}))
          throw new Error((body as { error?: string }).error ?? `Request failed (${res.status})`)
        }

        const data = await res.json() as { devRoot: string; projects: ProjectMetadata[] }
        setDevRoot(data.devRoot)
        setProjects(data.projects)
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to switch project root")
      } finally {
        setLoading(false)
      }
    },
    [],
  )

  const handleProjectCreated = useCallback(
    (newProject: ProjectMetadata) => {
      setProjects((prev) => [...prev, newProject].sort((a, b) => a.name.localeCompare(b.name)))
      setNewProjectOpen(false)
      manager.switchProject(newProject.path)
    },
    [manager],
  )

  function handleSelectProject(project: ProjectMetadata) {
    manager.switchProject(project.path)
  }

  // Sort: active-gsd first, then by name
  const sortedProjects = [...projects].sort((a, b) => {
    const kindOrder: Record<ProjectDetectionKind, number> = {
      "active-gsd": 0,
      "empty-gsd": 1,
      brownfield: 2,
      "v1-legacy": 3,
      blank: 4,
    }
    const ka = kindOrder[a.kind] ?? 5
    const kb = kindOrder[b.kind] ?? 5
    if (ka !== kb) return ka - kb
    return a.name.localeCompare(b.name)
  })

  // Filter projects by name
  const filteredProjects = filter.trim()
    ? sortedProjects.filter((p) => p.name.toLowerCase().includes(filter.toLowerCase()))
    : sortedProjects

  const hasProjects = !loading && sortedProjects.length > 0
  const showFilter = sortedProjects.length > 5

  return (
    <div className="flex h-screen flex-col bg-background text-foreground" data-testid="project-selection-gate">
      {/* ─── Main content ─── */}
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-2xl px-6 pt-16 pb-10 md:px-10 lg:pt-24">

          {/* ─── Logo + subtitle ─── */}
          <div className="flex flex-col items-center text-center mb-10">
            <Image
              src="/logo-black.svg"
              alt="GSD"
              width={100}
              height={28}
              className="h-7 w-auto dark:hidden"
            />
            <Image
              src="/logo-white.svg"
              alt="GSD"
              width={100}
              height={28}
              className="h-7 w-auto hidden dark:block"
            />
            <p className="mt-3 text-sm text-muted-foreground">
              Select a project to get started
            </p>
          </div>

            {/* Loading */}
            {loading && (
              <div className="flex items-center gap-3 py-20 justify-center text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Scanning for projects…
              </div>
            )}

            {/* Error */}
            {error && !loading && (
              <div className="rounded-md border border-destructive/20 bg-destructive/[0.06] px-4 py-3 text-sm text-destructive">
                {error}
              </div>
            )}

            {/* No dev root — show setup */}
            {!devRoot && !loading && !error && (
              <div className="space-y-6">
                <div>
                  <h2 className="text-lg font-semibold tracking-tight text-foreground">
                    Welcome to GSD
                  </h2>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Set a development root to get started. GSD will discover projects inside it.
                  </p>
                </div>
                <DevRootSetup onSaved={handleDevRootSaved} />
              </div>
            )}

            {/* No projects found */}
            {devRoot && !loading && sortedProjects.length === 0 && !error && (
              <div className="space-y-6">
                <div>
                  <h2 className="text-lg font-semibold tracking-tight text-foreground">No projects found</h2>
                  <p className="mt-1 text-sm text-muted-foreground">
                    No project directories were discovered. Create one to get started.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setNewProjectOpen(true)}
                  className="flex items-center gap-3 rounded-md border border-dashed border-border px-4 py-3 text-sm text-muted-foreground transition-colors hover:border-foreground/20 hover:text-foreground"
                >
                  <Plus className="h-4 w-4" />
                  Create a new project
                </button>
              </div>
            )}

            {/* ─── Project list ─── */}
            {hasProjects && (
              <div className="space-y-5">
                {/* Dev root + change button */}
                {devRoot && (
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <FolderRoot className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground truncate">{devRoot}</code>
                    <button
                      type="button"
                      onClick={() => setChangeRootOpen(true)}
                      className="shrink-0 text-[11px] text-primary hover:text-primary/80 transition-colors font-medium"
                      data-testid="gate-change-root"
                    >
                      Change
                    </button>
                  </div>
                )}

                {/* Filter + count */}
                <div className="flex items-center justify-between gap-4">
                  <p className="text-xs text-muted-foreground tabular-nums">
                    {sortedProjects.length} project{sortedProjects.length !== 1 ? "s" : ""}
                  </p>
                  {showFilter && (
                    <div className="relative w-48">
                      <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                      <input
                        type="text"
                        placeholder="Filter…"
                        value={filter}
                        onChange={(e) => setFilter(e.target.value)}
                        className="h-8 w-full rounded-md border border-border bg-background pl-8 pr-3 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                      />
                    </div>
                  )}
                </div>

                {/* Project rows — table-like, dense */}
                <div className="rounded-md border border-border bg-card overflow-hidden divide-y divide-border">
                  {filteredProjects.map((project) => {
                    const style = KIND_STYLE[project.kind]
                    const KindIcon = style.icon
                    const stack = techStack(project.signals)
                    const progress = project.progress ? progressLabel(project.progress) : null
                    const hasBar = project.progress && project.progress.milestonesTotal > 0
                    const pct = hasBar
                      ? Math.round((project.progress!.milestonesCompleted / project.progress!.milestonesTotal) * 100)
                      : 0

                    return (
                      <button
                        key={project.path}
                        type="button"
                        onClick={() => handleSelectProject(project)}
                        className="group flex w-full items-center gap-4 px-4 py-3 text-left transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:bg-accent/50"
                      >
                        {/* Icon */}
                        <div className={cn("flex h-8 w-8 shrink-0 items-center justify-center rounded-md", style.bgClass)}>
                          <KindIcon className={cn("h-3.5 w-3.5", style.color)} />
                        </div>

                        {/* Name + metadata */}
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-medium text-foreground truncate">{project.name}</span>
                            <span className={cn("text-[10px] font-medium shrink-0", style.color)}>{style.label}</span>
                          </div>
                          {/* Stack tags + progress on one line */}
                          <div className="mt-0.5 flex items-center gap-2 text-[11px] text-muted-foreground">
                            {stack.length > 0 && (
                              <span>{stack.join(" · ")}</span>
                            )}
                            {stack.length > 0 && progress && (
                              <span className="text-muted-foreground/50">—</span>
                            )}
                            {progress && (
                              <span className="truncate">{progress}</span>
                            )}
                          </div>
                        </div>

                        {/* Progress bar (compact) */}
                        {hasBar && (
                          <div className="hidden sm:flex items-center gap-2 shrink-0 w-24">
                            <div className="h-1 flex-1 overflow-hidden rounded-full bg-foreground/[0.08]">
                              <div
                                className="h-full rounded-full bg-success/70 transition-all"
                                style={{ width: `${pct}%` }}
                              />
                            </div>
                            <span className="text-[10px] tabular-nums text-muted-foreground w-6 text-right">
                              {project.progress!.milestonesCompleted}/{project.progress!.milestonesTotal}
                            </span>
                          </div>
                        )}

                        {/* Modified time */}
                        {project.lastModified > 0 && (
                          <span className="hidden lg:inline text-[10px] text-muted-foreground shrink-0 w-16 text-right tabular-nums">
                            {relativeTime(project.lastModified)}
                          </span>
                        )}

                        {/* Arrow */}
                        <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground/50 transition-colors group-hover:text-muted-foreground" />
                      </button>
                    )
                  })}

                  {/* Empty filter state */}
                  {filteredProjects.length === 0 && filter.trim() && (
                    <div className="px-4 py-8 text-center text-xs text-muted-foreground">
                      No projects matching "{filter}"
                    </div>
                  )}
                </div>

                {/* Create new row */}
                <button
                  type="button"
                  onClick={() => setNewProjectOpen(true)}
                  className="flex items-center gap-3 rounded-md border border-dashed border-border px-4 py-2.5 text-sm text-muted-foreground transition-colors hover:border-foreground/20 hover:text-foreground w-full"
                >
                  <Plus className="h-3.5 w-3.5" />
                  New project
                </button>

                {devRoot && (
                  <NewProjectDialog
                    open={newProjectOpen}
                    onOpenChange={setNewProjectOpen}
                    devRoot={devRoot}
                    existingNames={projects.map((p) => p.name)}
                    onCreated={handleProjectCreated}
                  />
                )}
              </div>
            )}

            {/* Change root for "no projects" and "no devRoot" states */}
            {devRoot && !loading && sortedProjects.length === 0 && !error && (
              <div className="mt-4">
                <button
                  type="button"
                  onClick={() => setChangeRootOpen(true)}
                  className="flex items-center gap-2 text-xs text-primary hover:text-primary/80 transition-colors font-medium"
                  data-testid="gate-change-root-empty"
                >
                  <FolderOpen className="h-3.5 w-3.5" />
                  Change project root
                </button>
              </div>
            )}
        </div>
      </div>

      {/* Folder picker for changing dev root */}
      <FolderPickerDialog
        open={changeRootOpen}
        onOpenChange={setChangeRootOpen}
        onSelect={(path) => void handleDevRootSaved(path)}
        initialPath={devRoot}
      />
    </div>
  )
}
