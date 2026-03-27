"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { motion } from "motion/react"
import {
  ArrowRight,
  FolderOpen,
  GitBranch,
  Layers,
  Loader2,
  Plus,
  Sparkles,
  Zap,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useProjectStoreManager } from "@/lib/project-store-manager"
import { cn } from "@/lib/utils"
import { authFetch } from "@/lib/auth"

// ─── Types ──────────────────────────────────────────────────────────

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
  isMonorepo?: boolean
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

// ─── Helpers ────────────────────────────────────────────────────────

const KIND_STYLE: Record<ProjectDetectionKind, { label: string; color: string; icon: typeof Layers }> = {
  "active-gsd": { label: "Active", color: "text-success", icon: Layers },
  "empty-gsd": { label: "Initialized", color: "text-info", icon: FolderOpen },
  brownfield: { label: "Existing", color: "text-warning", icon: GitBranch },
  "v1-legacy": { label: "Legacy", color: "text-warning", icon: GitBranch },
  blank: { label: "New", color: "text-muted-foreground", icon: Sparkles },
}

function techStack(signals: ProjectDetectionSignals): string[] {
  const tags: string[] = []
  if (signals.isMonorepo) tags.push("Monorepo")
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

function shortenPath(p: string): string {
  const home = typeof window !== "undefined" ? "" : ""
  // Show last 2-3 segments
  const parts = p.split("/").filter(Boolean)
  if (parts.length <= 3) return p
  return "…/" + parts.slice(-2).join("/")
}

// ─── Component ──────────────────────────────────────────────────────

interface StepProjectProps {
  onFinish: (projectPath: string) => void
  onBack: () => void
  /** Called immediately before a project switch starts — use to disarm gates. */
  onBeforeSwitch?: () => void
}

export function StepProject({ onFinish, onBack, onBeforeSwitch }: StepProjectProps) {
  const manager = useProjectStoreManager()

  const [devRoot, setDevRoot] = useState<string | null>(null)
  const [projects, setProjects] = useState<ProjectMetadata[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [showCreate, setShowCreate] = useState(false)
  const [newName, setNewName] = useState("")
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const createInputRef = useRef<HTMLInputElement>(null)

  const [switchingTo, setSwitchingTo] = useState<string | null>(null)
  const switchPollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      setError(null)
      try {
        const prefsRes = await authFetch("/api/preferences")
        if (!prefsRes.ok) throw new Error("Failed to load preferences")
        const prefs = await prefsRes.json()
        if (!prefs.devRoot) { setDevRoot(null); setProjects([]); setLoading(false); return }
        setDevRoot(prefs.devRoot)
        const projRes = await authFetch(`/api/projects?root=${encodeURIComponent(prefs.devRoot)}&detail=true`)
        if (!projRes.ok) throw new Error("Failed to discover projects")
        const discovered = (await projRes.json()) as ProjectMetadata[]
        if (!cancelled) setProjects(discovered)
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Unknown error")
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    return () => { if (switchPollRef.current) clearInterval(switchPollRef.current) }
  }, [])

  useEffect(() => {
    if (showCreate) {
      const t = setTimeout(() => createInputRef.current?.focus(), 50)
      return () => clearTimeout(t)
    }
  }, [showCreate])

  const existingNames = projects.map((p) => p.name)
  const nameValid = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(newName)
  const nameConflict = existingNames.includes(newName)
  const canCreate = newName.length > 0 && nameValid && !nameConflict && !creating

  const handleSelectProject = useCallback((project: ProjectMetadata) => {
    onBeforeSwitch?.()
    setSwitchingTo(project.path)
    const store = manager.switchProject(project.path)
    if (switchPollRef.current) clearInterval(switchPollRef.current)
    const startTime = Date.now()
    switchPollRef.current = setInterval(() => {
      const state = store.getSnapshot()
      const elapsed = Date.now() - startTime
      if (state.bootStatus === "ready" || state.bootStatus === "error" || elapsed > 30000) {
        if (switchPollRef.current) clearInterval(switchPollRef.current)
        switchPollRef.current = null
        setSwitchingTo(null)
        onFinish(project.path)
      }
    }, 150)
  }, [manager, onFinish, onBeforeSwitch])

  const handleCreate = useCallback(async () => {
    if (!canCreate || !devRoot) return
    setCreating(true)
    setCreateError(null)
    try {
      const res = await authFetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ devRoot, name: newName }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error((body as { error?: string }).error ?? `Failed (${res.status})`)
      }
      const project = (await res.json()) as ProjectMetadata
      setProjects((prev) => [...prev, project].sort((a, b) => a.name.localeCompare(b.name)))
      setNewName("")
      setShowCreate(false)
      handleSelectProject(project)
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Failed to create project")
      setCreating(false)
    }
  }, [canCreate, devRoot, newName, handleSelectProject])

  const noDevRoot = !loading && !devRoot

  // Sort: active-gsd first, then by name
  const sortedProjects = [...projects].sort((a, b) => {
    const kindOrder: Record<ProjectDetectionKind, number> = { "active-gsd": 0, "empty-gsd": 1, brownfield: 2, "v1-legacy": 3, blank: 4 }
    const ka = kindOrder[a.kind] ?? 5
    const kb = kindOrder[b.kind] ?? 5
    if (ka !== kb) return ka - kb
    return a.name.localeCompare(b.name)
  })

  return (
    <div className="flex flex-col items-center">
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
        className="text-center"
      >
        <h2 className="text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
          Open a project
        </h2>
        <p className="mt-2 max-w-sm text-sm leading-relaxed text-muted-foreground">
          {noDevRoot
            ? "Set a dev root first to discover your projects."
            : "Pick a project to start working in, or create a new one."}
        </p>
      </motion.div>

      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.08, duration: 0.45 }}
        className="mt-8 w-full max-w-lg space-y-2"
      >
        {loading && (
          <div className="flex items-center justify-center gap-2 py-10 text-xs text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Discovering projects…
          </div>
        )}

        {error && (
          <div className="rounded-xl border border-destructive/20 bg-destructive/[0.06] px-4 py-3 text-sm text-destructive">
            {error}
          </div>
        )}

        {noDevRoot && (
          <div className="rounded-xl border border-border/50 bg-card/50 px-4 py-6 text-center text-sm text-muted-foreground">
            No dev root configured. Go back and set one, or finish setup to configure later.
          </div>
        )}

        {/* Project cards */}
        {!loading && sortedProjects.length > 0 && (
          <div className="space-y-2">
            {sortedProjects.map((project) => {
              const isSwitching = switchingTo === project.path
              const style = KIND_STYLE[project.kind]
              const KindIcon = style.icon
              const stack = techStack(project.signals)
              const progress = project.progress ? progressLabel(project.progress) : null
              const milestoneCount = project.progress
                ? `${project.progress.milestonesCompleted}/${project.progress.milestonesTotal}`
                : null

              return (
                <button
                  key={project.path}
                  type="button"
                  onClick={() => handleSelectProject(project)}
                  disabled={!!switchingTo}
                  className={cn(
                    "group flex w-full items-start gap-3.5 rounded-xl border px-4 py-3.5 text-left transition-all duration-200",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    "active:scale-[0.98]",
                    isSwitching
                      ? "border-foreground/30 bg-foreground/[0.06]"
                      : "border-border/50 bg-card/50 hover:border-foreground/15 hover:bg-card/50",
                    switchingTo && !isSwitching && "opacity-40 pointer-events-none",
                  )}
                >
                  {/* Icon */}
                  <div className={cn(
                    "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg mt-0.5",
                    project.kind === "active-gsd" ? "bg-success/10" : "bg-foreground/[0.04]",
                  )}>
                    {isSwitching ? (
                      <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                    ) : (
                      <KindIcon className={cn("h-4 w-4", style.color)} />
                    )}
                  </div>

                  {/* Content */}
                  <div className="min-w-0 flex-1">
                    {/* Row 1: name + kind badge */}
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold text-foreground truncate">{project.name}</span>
                      <span className={cn("text-[10px] font-medium shrink-0", style.color)}>
                        {style.label}
                      </span>
                    </div>

                    {/* Row 2: tech stack tags */}
                    {stack.length > 0 && (
                      <div className="mt-1 flex items-center gap-1.5">
                        {stack.map((tag) => (
                          <span
                            key={tag}
                            className="rounded bg-foreground/[0.04] px-1.5 py-0.5 text-[10px] text-muted-foreground"
                          >
                            {tag}
                          </span>
                        ))}
                      </div>
                    )}

                    {/* Row 3: progress info (for active-gsd projects) */}
                    {progress && (
                      <div className="mt-1.5 text-[11px] text-muted-foreground">
                        {progress}
                      </div>
                    )}

                    {/* Row 4: milestone bar (for active-gsd with milestones) */}
                    {project.progress && project.progress.milestonesTotal > 0 && (
                      <div className="mt-2 flex items-center gap-2">
                        <div className="h-1 flex-1 overflow-hidden rounded-full bg-foreground/[0.06]">
                          <div
                            className="h-full rounded-full bg-success/60 transition-all"
                            style={{
                              width: `${Math.round((project.progress.milestonesCompleted / project.progress.milestonesTotal) * 100)}%`,
                            }}
                          />
                        </div>
                        <span className="text-[10px] tabular-nums text-muted-foreground">
                          {milestoneCount}
                        </span>
                      </div>
                    )}
                  </div>

                  {/* Arrow */}
                  <ArrowRight className="mt-1 h-4 w-4 shrink-0 text-muted-foreground/50 transition-all group-hover:text-muted-foreground group-hover:translate-x-0.5" />
                </button>
              )
            })}
          </div>
        )}

        {!loading && devRoot && projects.length === 0 && !error && (
          <div className="rounded-xl border border-border/50 bg-card/50 px-4 py-6 text-center text-sm text-muted-foreground">
            No projects found in {devRoot}
          </div>
        )}

        {/* Create new project */}
        {!loading && devRoot && (
          <>
            {!showCreate ? (
              <button
                type="button"
                onClick={() => setShowCreate(true)}
                disabled={!!switchingTo}
                className={cn(
                  "flex w-full items-center gap-3.5 rounded-xl border border-dashed px-4 py-3.5 text-left transition-all duration-200",
                  "border-border/50 text-muted-foreground hover:border-foreground/15 hover:text-foreground",
                  "active:scale-[0.98]",
                  switchingTo && "opacity-40 pointer-events-none",
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
            ) : (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                transition={{ duration: 0.2 }}
                className="rounded-xl border border-border/50 bg-card/50 p-4 space-y-3"
              >
                <div className="text-sm font-medium text-foreground">New project</div>
                <form
                  onSubmit={(e) => { e.preventDefault(); void handleCreate() }}
                  className="space-y-2"
                >
                  <Input
                    ref={createInputRef}
                    value={newName}
                    onChange={(e) => { setNewName(e.target.value); setCreateError(null) }}
                    placeholder="my-project"
                    autoComplete="off"
                    className="text-sm"
                    disabled={creating}
                  />
                  {newName && !nameValid && (
                    <p className="text-xs text-destructive">Letters, numbers, hyphens, underscores, dots. Must start with a letter or number.</p>
                  )}
                  {nameConflict && (
                    <p className="text-xs text-destructive">A project with this name already exists</p>
                  )}
                  {createError && (
                    <p className="text-xs text-destructive">{createError}</p>
                  )}
                  {newName && nameValid && !nameConflict && (
                    <p className="font-mono text-xs text-muted-foreground">{devRoot}/{newName}</p>
                  )}
                  <div className="flex items-center gap-2 pt-1">
                    <Button
                      type="submit"
                      size="sm"
                      disabled={!canCreate}
                      className="gap-1.5 transition-transform active:scale-[0.96]"
                    >
                      {creating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
                      Create & open
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => { setShowCreate(false); setNewName(""); setCreateError(null) }}
                      disabled={creating}
                      className="text-muted-foreground"
                    >
                      Cancel
                    </Button>
                  </div>
                </form>
              </motion.div>
            )}
          </>
        )}
      </motion.div>

      {/* Navigation */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.15, duration: 0.3 }}
        className="mt-8 flex w-full max-w-lg items-center justify-between"
      >
        <Button
          variant="ghost"
          onClick={onBack}
          className="text-muted-foreground transition-transform active:scale-[0.96]"
        >
          Back
        </Button>
        <Button
          onClick={() => { onBeforeSwitch?.(); onFinish("") }}
          className="group gap-2 transition-transform active:scale-[0.96]"
        >
          Finish setup
          <Zap className="h-4 w-4 transition-transform group-hover:scale-110" />
        </Button>
      </motion.div>
    </div>
  )
}
