"use client"

import { useState, useEffect, useCallback, useRef } from "react"
import {
  FileText,
  ChevronRight,
  ChevronDown,
  Folder,
  FolderOpen,
  FileCode,
  File,
  Loader2,
  AlertCircle,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { useGSDWorkspaceState } from "@/lib/gsd-workspace-store"
import { FileContentViewer } from "@/components/gsd/file-content-viewer"

type RootMode = "gsd" | "project"

// Global pending file request — survives across component mount/unmount cycles.
// Set by the custom event, consumed by FilesView on mount or when already mounted.
let pendingFileRequest: { root: RootMode; path: string } | null = null

// Set up the global event listener once (module-level, not component-level)
if (typeof window !== "undefined") {
  window.addEventListener("gsd:open-file", (e: Event) => {
    const detail = (e as CustomEvent<{ root: RootMode; path: string }>).detail
    if (detail?.root && detail?.path) {
      pendingFileRequest = { root: detail.root, path: detail.path }
    }
  })
}

interface FileNode {
  name: string
  type: "file" | "directory"
  children?: FileNode[]
}

/* ── Persistence helpers ── */

function storageKey(projectCwd: string, root: RootMode): string {
  return `gsd-files-expanded:${root}:${projectCwd}`
}

function loadExpanded(projectCwd: string | undefined, root: RootMode): Set<string> {
  if (!projectCwd) return new Set()
  try {
    const raw = sessionStorage.getItem(storageKey(projectCwd, root))
    if (raw) return new Set(JSON.parse(raw) as string[])
  } catch { /* ignore */ }
  return new Set()
}

function saveExpanded(projectCwd: string | undefined, root: RootMode, expanded: Set<string>): void {
  if (!projectCwd) return
  try {
    sessionStorage.setItem(storageKey(projectCwd, root), JSON.stringify([...expanded]))
  } catch { /* ignore */ }
}

/* ── Icons ── */

function FileIcon({ name, isFolder, isOpen }: { name: string; isFolder: boolean; isOpen?: boolean }) {
  if (isFolder) {
    return isOpen ? (
      <FolderOpen className="h-4 w-4 text-muted-foreground" />
    ) : (
      <Folder className="h-4 w-4 text-muted-foreground" />
    )
  }
  if (name.endsWith(".md")) {
    return <FileText className="h-4 w-4 text-muted-foreground" />
  }
  if (name.endsWith(".json") || name.endsWith(".ts") || name.endsWith(".tsx") || name.endsWith(".js") || name.endsWith(".jsx")) {
    return <FileCode className="h-4 w-4 text-muted-foreground" />
  }
  return <File className="h-4 w-4 text-muted-foreground" />
}

/* ── Tree item ── */

interface FileTreeItemProps {
  node: FileNode
  depth: number
  parentPath: string
  selectedPath: string | null
  expandedPaths: Set<string>
  onToggleDir: (path: string) => void
  onSelectFile: (path: string) => void
}

function FileTreeItem({ node, depth, parentPath, selectedPath, expandedPaths, onToggleDir, onSelectFile }: FileTreeItemProps) {
  const fullPath = parentPath ? `${parentPath}/${node.name}` : node.name
  const isOpen = node.type === "directory" && expandedPaths.has(fullPath)

  const handleClick = () => {
    if (node.type === "directory") {
      onToggleDir(fullPath)
    } else {
      onSelectFile(fullPath)
    }
  }

  return (
    <div>
      <button
        onClick={handleClick}
        className={cn(
          "flex w-full items-center gap-1.5 px-2 py-1 text-sm hover:bg-accent/50 transition-colors",
          selectedPath === fullPath && node.type === "file" && "bg-accent",
        )}
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
      >
        {node.type === "directory" && (
          isOpen ? (
            <ChevronDown className="h-3 w-3 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-3 w-3 text-muted-foreground" />
          )
        )}
        <FileIcon name={node.name} isFolder={node.type === "directory"} isOpen={isOpen} />
        <span className="truncate">{node.name}</span>
      </button>
      {isOpen && node.children && (
        <div>
          {node.children.map((child, i) => (
            <FileTreeItem
              key={i}
              node={child}
              depth={depth + 1}
              parentPath={fullPath}
              selectedPath={selectedPath}
              expandedPaths={expandedPaths}
              onToggleDir={onToggleDir}
              onSelectFile={onSelectFile}
            />
          ))}
        </div>
      )}
    </div>
  )
}

/* ── Main view ── */

export function FilesView() {
  const workspace = useGSDWorkspaceState()
  const projectCwd = workspace.boot?.project.cwd

  const [activeRoot, setActiveRoot] = useState<RootMode>("gsd")
  const [gsdTree, setGsdTree] = useState<FileNode[] | null>(null)
  const [projectTree, setProjectTree] = useState<FileNode[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Expanded paths per root, restored from sessionStorage
  const [gsdExpanded, setGsdExpanded] = useState<Set<string>>(() => loadExpanded(projectCwd, "gsd"))
  const [projectExpanded, setProjectExpanded] = useState<Set<string>>(() => loadExpanded(projectCwd, "project"))

  // Re-hydrate from storage once projectCwd is available (boot may arrive after first render)
  const hydratedRef = useRef(false)
  useEffect(() => {
    if (!projectCwd || hydratedRef.current) return
    hydratedRef.current = true
    setGsdExpanded(loadExpanded(projectCwd, "gsd"))
    setProjectExpanded(loadExpanded(projectCwd, "project"))
  }, [projectCwd])

  const expandedPaths = activeRoot === "gsd" ? gsdExpanded : projectExpanded
  const setExpandedPaths = activeRoot === "gsd" ? setGsdExpanded : setProjectExpanded

  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [fileContent, setFileContent] = useState<string | null>(null)
  const [contentLoading, setContentLoading] = useState(false)
  const [contentError, setContentError] = useState<string | null>(null)

  const tree = activeRoot === "gsd" ? gsdTree : projectTree
  const treeLoaded = activeRoot === "gsd" ? gsdTree !== null : projectTree !== null

  const fetchTree = useCallback(async (root: RootMode) => {
    try {
      setLoading(true)
      setError(null)
      const res = await fetch(`/api/files?root=${root}`)
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || `Failed to fetch files (${res.status})`)
      }
      const data = await res.json()
      const nodes = data.tree ?? []
      if (root === "gsd") {
        setGsdTree(nodes)
      } else {
        setProjectTree(nodes)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch files")
    } finally {
      setLoading(false)
    }
  }, [])

  // Fetch tree when tab changes and data isn't cached
  useEffect(() => {
    if (!treeLoaded) {
      fetchTree(activeRoot)
    }
  }, [activeRoot, treeLoaded, fetchTree])

  // Initial load
  useEffect(() => {
    fetchTree("gsd")
  }, [fetchTree])

  // Process a file open request (used both on mount and on event)
  const processFileOpen = useCallback(async (root: RootMode, path: string) => {
    // Switch to the correct root tab
    setActiveRoot(root)

    // Ensure tree is loaded for this root
    if (root === "gsd" && !gsdTree) {
      fetchTree("gsd")
    } else if (root === "project" && !projectTree) {
      fetchTree("project")
    }

    // Auto-expand all parent directories
    const parts = path.split("/")
    const setExpanded = root === "gsd" ? setGsdExpanded : setProjectExpanded
    setExpanded((prev) => {
      const next = new Set(prev)
      for (let i = 1; i < parts.length; i++) {
        next.add(parts.slice(0, i).join("/"))
      }
      saveExpanded(projectCwd, root, next)
      return next
    })

    // Select and load the file
    setSelectedPath(path)
    setFileContent(null)
    setContentError(null)
    setContentLoading(true)
    try {
      const res = await fetch(`/api/files?root=${root}&path=${encodeURIComponent(path)}`)
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || `Failed to fetch file (${res.status})`)
      }
      const data = await res.json()
      setFileContent(data.content ?? null)
    } catch (err) {
      setContentError(err instanceof Error ? err.message : "Failed to fetch file content")
    } finally {
      setContentLoading(false)
    }
  }, [gsdTree, projectTree, fetchTree, projectCwd])

  // On mount: consume any pending file request that arrived before this component mounted
  const consumedPendingRef = useRef(false)
  useEffect(() => {
    if (consumedPendingRef.current) return
    if (pendingFileRequest) {
      consumedPendingRef.current = true
      const { root, path } = pendingFileRequest
      pendingFileRequest = null
      void processFileOpen(root, path)
    }
  }, [processFileOpen])

  // Listen for file open events while mounted
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ root: RootMode; path: string }>).detail
      if (!detail?.root || !detail?.path) return
      pendingFileRequest = null // clear since we're handling it directly
      void processFileOpen(detail.root, detail.path)
    }
    window.addEventListener("gsd:open-file", handler)
    return () => window.removeEventListener("gsd:open-file", handler)
  }, [processFileOpen])

  const handleToggleDir = useCallback((path: string) => {
    setExpandedPaths((prev) => {
      const next = new Set(prev)
      if (next.has(path)) {
        next.delete(path)
      } else {
        next.add(path)
      }
      saveExpanded(projectCwd, activeRoot, next)
      return next
    })
  }, [setExpandedPaths, projectCwd, activeRoot])

  const handleTabChange = (root: RootMode) => {
    setActiveRoot(root)
    setSelectedPath(null)
    setFileContent(null)
    setContentError(null)
  }

  const handleSelectFile = useCallback(async (path: string) => {
    setSelectedPath(path)
    setFileContent(null)
    setContentError(null)
    setContentLoading(true)

    try {
      const res = await fetch(`/api/files?root=${activeRoot}&path=${encodeURIComponent(path)}`)
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || `Failed to fetch file (${res.status})`)
      }
      const data = await res.json()
      setFileContent(data.content ?? null)
    } catch (err) {
      setContentError(err instanceof Error ? err.message : "Failed to fetch file content")
    } finally {
      setContentLoading(false)
    }
  }, [activeRoot])

  // Save handler: POST to /api/files, then re-fetch content
  const handleSave = useCallback(async (newContent: string) => {
    if (!selectedPath) return
    const res = await fetch("/api/files", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: selectedPath, content: newContent, root: activeRoot }),
    })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      throw new Error(data.error || `Save failed (${res.status})`)
    }
    // Re-fetch to sync the view tab
    await handleSelectFile(selectedPath)
  }, [activeRoot, selectedPath, handleSelectFile])

  // Auto-select STATE.md on initial load if no file is selected
  const autoSelectedRef = useRef(false)
  useEffect(() => {
    if (autoSelectedRef.current) return
    if (!gsdTree || selectedPath || consumedPendingRef.current) return
    const hasStateMd = gsdTree.some((n) => n.name === "STATE.md" && n.type === "file")
    if (hasStateMd) {
      autoSelectedRef.current = true
      void handleSelectFile("STATE.md")
    }
  }, [gsdTree, selectedPath, handleSelectFile])

  const displayPath = selectedPath
    ? activeRoot === "gsd"
      ? `.gsd/${selectedPath}`
      : selectedPath
    : null

  return (
    <div className="flex h-full">
      {/* File tree panel */}
      <div className="w-64 flex-shrink-0 border-r border-border overflow-y-auto flex flex-col">
        {/* Tab bar */}
        <div className="flex border-b border-border flex-shrink-0">
          <button
            onClick={() => handleTabChange("gsd")}
            className={cn(
              "flex-1 px-3 py-2 text-xs font-medium transition-colors",
              activeRoot === "gsd"
                ? "border-b-2 border-foreground text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            GSD
          </button>
          <button
            onClick={() => handleTabChange("project")}
            className={cn(
              "flex-1 px-3 py-2 text-xs font-medium transition-colors",
              activeRoot === "project"
                ? "border-b-2 border-foreground text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            Project
          </button>
        </div>

        {/* Tree content */}
        <div className="flex-1 overflow-y-auto py-2">
          {loading && !treeLoaded ? (
            <div className="flex items-center justify-center py-8 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin mr-2" />
              Loading…
            </div>
          ) : error && !treeLoaded ? (
            <div className="flex items-center justify-center py-8 text-destructive text-xs px-3">
              <AlertCircle className="h-4 w-4 mr-2 shrink-0" />
              {error}
            </div>
          ) : tree && tree.length === 0 ? (
            <div className="flex items-center justify-center py-8 text-muted-foreground text-xs">
              {activeRoot === "gsd" ? "No .gsd/ files found" : "No files found"}
            </div>
          ) : tree ? (
            tree.map((node, i) => (
              <FileTreeItem
                key={`${activeRoot}-${i}`}
                node={node}
                depth={0}
                parentPath=""
                selectedPath={selectedPath}
                expandedPaths={expandedPaths}
                onToggleDir={handleToggleDir}
                onSelectFile={handleSelectFile}
              />
            ))
          ) : null}
        </div>
      </div>

      {/* File content panel */}
      <div className="flex-1 overflow-hidden flex flex-col">
        {displayPath && (
          <>
            <div className="flex h-9 items-center border-b border-border px-4">
              <span className="text-sm font-medium font-mono">{displayPath}</span>
            </div>
            {contentLoading ? (
              <div className="flex flex-1 items-center justify-center text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
                Loading…
              </div>
            ) : contentError ? (
              <div className="flex flex-1 items-center justify-center text-destructive">
                <AlertCircle className="h-4 w-4 mr-2" />
                {contentError}
              </div>
            ) : fileContent !== null ? (
              <FileContentViewer
                content={fileContent}
                filepath={displayPath}
                root={activeRoot}
                path={selectedPath ?? undefined}
                onSave={handleSave}
              />
            ) : (
              <div className="flex flex-1 items-center justify-center text-muted-foreground italic">
                No preview available
              </div>
            )}
          </>
        )}
        {!displayPath && (
          <div className="flex h-full items-center justify-center text-muted-foreground">
            Select a file to view
          </div>
        )}
      </div>
    </div>
  )
}
