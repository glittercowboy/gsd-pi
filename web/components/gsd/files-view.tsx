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
  X,
  FilePlus,
  FolderPlus,
  Pencil,
  Trash2,
  Copy,
  ClipboardCopy,
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

/* ── Context menu ── */

interface ContextMenuState {
  x: number
  y: number
  path: string
  type: "file" | "directory"
  /** parent directory path (empty string = root) */
  parentPath: string
}

interface ContextMenuProps {
  menu: ContextMenuState
  onClose: () => void
  onNewFile: (parentDir: string) => void
  onNewFolder: (parentDir: string) => void
  onRename: (path: string) => void
  onDelete: (path: string, type: "file" | "directory") => void
  onCopyPath: (path: string) => void
  onDuplicate: (path: string) => void
}

function TreeContextMenu({ menu, onClose, onNewFile, onNewFolder, onRename, onDelete, onCopyPath, onDuplicate }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null)

  // Close on click outside or escape
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose()
      }
    }
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    }
    document.addEventListener("mousedown", handleClick)
    document.addEventListener("keydown", handleKey)
    return () => {
      document.removeEventListener("mousedown", handleClick)
      document.removeEventListener("keydown", handleKey)
    }
  }, [onClose])

  // Keep menu within viewport
  const [pos, setPos] = useState({ x: menu.x, y: menu.y })
  useEffect(() => {
    if (!menuRef.current) return
    const rect = menuRef.current.getBoundingClientRect()
    let { x, y } = menu
    if (x + rect.width > window.innerWidth) x = window.innerWidth - rect.width - 8
    if (y + rect.height > window.innerHeight) y = window.innerHeight - rect.height - 8
    if (x < 0) x = 8
    if (y < 0) y = 8
    setPos({ x, y })
  }, [menu])

  const parentDir = menu.type === "directory" ? menu.path : menu.parentPath

  const items: { label: string; icon: React.ReactNode; action: () => void; destructive?: boolean; separator?: boolean }[] = [
    {
      label: "New File",
      icon: <FilePlus className="h-3.5 w-3.5" />,
      action: () => { onNewFile(parentDir); onClose() },
    },
    {
      label: "New Folder",
      icon: <FolderPlus className="h-3.5 w-3.5" />,
      action: () => { onNewFolder(parentDir); onClose() },
    },
    {
      label: "Rename",
      icon: <Pencil className="h-3.5 w-3.5" />,
      action: () => { onRename(menu.path); onClose() },
      separator: true,
    },
    {
      label: "Duplicate",
      icon: <Copy className="h-3.5 w-3.5" />,
      action: () => { onDuplicate(menu.path); onClose() },
    },
    {
      label: "Copy Path",
      icon: <ClipboardCopy className="h-3.5 w-3.5" />,
      action: () => { onCopyPath(menu.path); onClose() },
      separator: true,
    },
    {
      label: "Delete",
      icon: <Trash2 className="h-3.5 w-3.5" />,
      action: () => { onDelete(menu.path, menu.type); onClose() },
      destructive: true,
    },
  ]

  return (
    <div
      ref={menuRef}
      className="fixed z-50 min-w-[160px] rounded-md border border-border bg-popover py-1 shadow-lg animate-in fade-in-0 zoom-in-95"
      style={{ left: pos.x, top: pos.y }}
    >
      {items.map((item, i) => (
        <div key={i}>
          {item.separator && i > 0 && <div className="my-1 h-px bg-border" />}
          <button
            onClick={item.action}
            className={cn(
              "flex w-full items-center gap-2 px-3 py-1.5 text-xs transition-colors",
              item.destructive
                ? "text-destructive hover:bg-destructive/10"
                : "text-popover-foreground hover:bg-accent",
            )}
          >
            {item.icon}
            {item.label}
          </button>
        </div>
      ))}
    </div>
  )
}

/* ── Inline input (for rename / new file / new folder) ── */

function InlineInput({
  defaultValue,
  onCommit,
  onCancel,
  depth,
  icon,
}: {
  defaultValue: string
  onCommit: (value: string) => void
  onCancel: () => void
  depth: number
  icon: React.ReactNode
}) {
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    // Focus and select just the filename (not extension) on mount
    const input = inputRef.current
    if (!input) return
    input.focus()
    const dotIndex = defaultValue.lastIndexOf(".")
    if (dotIndex > 0) {
      input.setSelectionRange(0, dotIndex)
    } else {
      input.select()
    }
  }, [defaultValue])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault()
      const val = inputRef.current?.value.trim()
      if (val && val.length > 0) onCommit(val)
      else onCancel()
    }
    if (e.key === "Escape") {
      e.preventDefault()
      onCancel()
    }
  }

  return (
    <div
      className="flex items-center gap-1.5 px-2 py-0.5"
      style={{ paddingLeft: `${depth * 12 + 8}px` }}
    >
      {icon}
      <input
        ref={inputRef}
        defaultValue={defaultValue}
        onKeyDown={handleKeyDown}
        onBlur={() => {
          const val = inputRef.current?.value.trim()
          if (val && val.length > 0) onCommit(val)
          else onCancel()
        }}
        className="flex-1 bg-transparent text-sm outline-none border border-ring rounded px-1 py-0.5 text-foreground"
        spellCheck={false}
      />
    </div>
  )
}

/* ── Tree item ── */

interface FileTreeItemProps {
  node: FileNode
  depth: number
  parentPath: string
  selectedPath: string | null
  expandedPaths: Set<string>
  renamingPath: string | null
  creatingIn: { parentDir: string; type: "file" | "directory" } | null
  onToggleDir: (path: string) => void
  onSelectFile: (path: string) => void
  onMoveFile: (fromPath: string, toDir: string) => void
  onContextMenu: (e: React.MouseEvent, path: string, type: "file" | "directory", parentPath: string) => void
  onRenameCommit: (oldPath: string, newName: string) => void
  onRenameCancel: () => void
  onCreateCommit: (parentDir: string, name: string, type: "file" | "directory") => void
  onCreateCancel: () => void
}

function FileTreeItem({
  node, depth, parentPath, selectedPath, expandedPaths,
  renamingPath, creatingIn,
  onToggleDir, onSelectFile, onMoveFile,
  onContextMenu, onRenameCommit, onRenameCancel,
  onCreateCommit, onCreateCancel,
}: FileTreeItemProps) {
  const fullPath = parentPath ? `${parentPath}/${node.name}` : node.name
  const isOpen = node.type === "directory" && expandedPaths.has(fullPath)
  const [dragOver, setDragOver] = useState(false)
  const isRenaming = renamingPath === fullPath

  // Should we show the "create new" input inside this directory?
  const showCreateInput = creatingIn && creatingIn.parentDir === fullPath && node.type === "directory" && isOpen

  const handleClick = () => {
    if (node.type === "directory") {
      onToggleDir(fullPath)
    } else {
      onSelectFile(fullPath)
    }
  }

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    onContextMenu(e, fullPath, node.type, parentPath)
  }

  // ── Drag source ──
  const handleDragStart = (e: React.DragEvent) => {
    e.dataTransfer.setData("text/x-tree-path", fullPath)
    e.dataTransfer.effectAllowed = "move"
  }

  // ── Drop target (directories only) ──
  const handleDragOver = (e: React.DragEvent) => {
    if (node.type !== "directory") return
    const srcPath = e.dataTransfer.types.includes("text/x-tree-path") ? "pending" : null
    if (!srcPath) return
    e.preventDefault()
    e.dataTransfer.dropEffect = "move"
    setDragOver(true)
  }

  const handleDragLeave = () => {
    setDragOver(false)
  }

  const handleDrop = (e: React.DragEvent) => {
    setDragOver(false)
    if (node.type !== "directory") return
    e.preventDefault()
    const srcPath = e.dataTransfer.getData("text/x-tree-path")
    if (!srcPath || srcPath === fullPath) return
    if (fullPath.startsWith(srcPath + "/")) return
    const srcParent = srcPath.includes("/") ? srcPath.substring(0, srcPath.lastIndexOf("/")) : ""
    if (srcParent === fullPath) return
    onMoveFile(srcPath, fullPath)
  }

  // Inline rename mode
  if (isRenaming) {
    return (
      <div data-tree-item>
        <InlineInput
          defaultValue={node.name}
          onCommit={(newName) => onRenameCommit(fullPath, newName)}
          onCancel={onRenameCancel}
          depth={depth}
          icon={<FileIcon name={node.name} isFolder={node.type === "directory"} isOpen={isOpen} />}
        />
      </div>
    )
  }

  return (
    <div data-tree-item>
      <button
        onClick={handleClick}
        onContextMenu={handleContextMenu}
        draggable
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={cn(
          "flex w-full items-center gap-1.5 px-2 py-1 text-sm hover:bg-accent/50 transition-colors",
          selectedPath === fullPath && node.type === "file" && "bg-accent",
          dragOver && "bg-accent/70 outline outline-1 outline-ring",
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
          {/* Create new item input at the top of the directory */}
          {showCreateInput && (
            <InlineInput
              defaultValue={creatingIn!.type === "directory" ? "new-folder" : "new-file"}
              onCommit={(name) => onCreateCommit(fullPath, name, creatingIn!.type)}
              onCancel={onCreateCancel}
              depth={depth + 1}
              icon={creatingIn!.type === "directory"
                ? <Folder className="h-4 w-4 text-muted-foreground" />
                : <File className="h-4 w-4 text-muted-foreground" />
              }
            />
          )}
          {node.children.map((child, i) => (
            <FileTreeItem
              key={i}
              node={child}
              depth={depth + 1}
              parentPath={fullPath}
              selectedPath={selectedPath}
              expandedPaths={expandedPaths}
              renamingPath={renamingPath}
              creatingIn={creatingIn}
              onToggleDir={onToggleDir}
              onSelectFile={onSelectFile}
              onMoveFile={onMoveFile}
              onContextMenu={onContextMenu}
              onRenameCommit={onRenameCommit}
              onRenameCancel={onRenameCancel}
              onCreateCommit={onCreateCommit}
              onCreateCancel={onCreateCancel}
            />
          ))}
        </div>
      )}
    </div>
  )
}

/* ── Open tab model ── */

interface OpenTab {
  /** Unique key: "root:path" */
  key: string
  root: RootMode
  path: string
  content: string | null
  loading: boolean
  error: string | null
}

function tabKey(root: RootMode, path: string): string {
  return `${root}:${path}`
}

function tabDisplayPath(tab: OpenTab): string {
  return tab.root === "gsd" ? `.gsd/${tab.path}` : tab.path
}

function tabLabel(tab: OpenTab): string {
  return tab.path.split("/").pop() ?? tab.path
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

  // ── Multi-tab state ──
  const [openTabs, setOpenTabs] = useState<OpenTab[]>([])
  const [activeTabKey, setActiveTabKey] = useState<string | null>(null)
  const [treeRootDragOver, setTreeRootDragOver] = useState(false)

  // ── Context menu state ──
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const [renamingPath, setRenamingPath] = useState<string | null>(null)
  const [creatingIn, setCreatingIn] = useState<{ parentDir: string; type: "file" | "directory" } | null>(null)
  const [deleteConfirm, setDeleteConfirm] = useState<{ path: string; type: "file" | "directory" } | null>(null)

  const activeTab = openTabs.find((t) => t.key === activeTabKey) ?? null

  // The selected path in the tree corresponds to the active tab
  const selectedPath = activeTab?.path ?? null

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

  // ── Open or focus a file tab and fetch its content ──
  const openFileTab = useCallback(async (root: RootMode, path: string) => {
    const key = tabKey(root, path)

    // If already open, just focus it
    setOpenTabs((prev) => {
      const existing = prev.find((t) => t.key === key)
      if (existing) return prev
      // Add new tab
      return [...prev, { key, root, path, content: null, loading: true, error: null }]
    })
    setActiveTabKey(key)

    // Switch tree root to match
    setActiveRoot(root)

    // Auto-expand parent dirs
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

    // Check if we already have the content cached
    setOpenTabs((prev) => {
      const existing = prev.find((t) => t.key === key)
      if (existing && existing.content !== null) return prev // already loaded
      return prev // will fetch below
    })

    // Fetch content
    try {
      const res = await fetch(`/api/files?root=${root}&path=${encodeURIComponent(path)}`)
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        const errMsg = data.error || `Failed to fetch file (${res.status})`
        setOpenTabs((prev) =>
          prev.map((t) => (t.key === key ? { ...t, loading: false, error: errMsg } : t)),
        )
        return
      }
      const data = await res.json()
      setOpenTabs((prev) =>
        prev.map((t) =>
          t.key === key ? { ...t, content: data.content ?? null, loading: false, error: null } : t,
        ),
      )
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : "Failed to fetch file content"
      setOpenTabs((prev) =>
        prev.map((t) => (t.key === key ? { ...t, loading: false, error: errMsg } : t)),
      )
    }
  }, [projectCwd])

  // ── Close a tab ──
  const closeTab = useCallback((key: string, e?: React.MouseEvent) => {
    e?.stopPropagation()
    setOpenTabs((prev) => {
      const idx = prev.findIndex((t) => t.key === key)
      const next = prev.filter((t) => t.key !== key)

      // If we're closing the active tab, switch to an adjacent one
      if (key === activeTabKey) {
        if (next.length === 0) {
          setActiveTabKey(null)
        } else {
          // Prefer the tab to the right, then left
          const newIdx = Math.min(idx, next.length - 1)
          setActiveTabKey(next[newIdx].key)
        }
      }

      return next
    })
  }, [activeTabKey])

  // Process a file open request (used both on mount and on event)
  const processFileOpen = useCallback(async (root: RootMode, path: string) => {
    // Ensure tree is loaded for this root
    if (root === "gsd" && !gsdTree) {
      fetchTree("gsd")
    } else if (root === "project" && !projectTree) {
      fetchTree("project")
    }

    await openFileTab(root, path)
  }, [gsdTree, projectTree, fetchTree, openFileTab])

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

  const handleTreeRootChange = (root: RootMode) => {
    setActiveRoot(root)
  }

  const handleSelectFile = useCallback(async (path: string) => {
    await openFileTab(activeRoot, path)
  }, [activeRoot, openFileTab])

  // ── Move file/directory via drag-and-drop ──
  const handleMoveFile = useCallback(async (fromPath: string, toDir: string) => {
    const fileName = fromPath.split("/").pop() ?? fromPath
    const toPath = toDir ? `${toDir}/${fileName}` : fileName

    try {
      const res = await fetch("/api/files", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from: fromPath, to: toPath, root: activeRoot }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        console.error("Move failed:", data.error || res.statusText)
        return
      }

      // Update any open tabs that referenced the moved path
      const oldKey = tabKey(activeRoot, fromPath)
      setOpenTabs((prev) =>
        prev.map((t) => {
          if (t.key === oldKey) {
            const newKey = tabKey(activeRoot, toPath)
            return { ...t, key: newKey, path: toPath }
          }
          // Also update tabs for files inside a moved directory
          if (t.root === activeRoot && t.path.startsWith(fromPath + "/")) {
            const newTabPath = toPath + t.path.slice(fromPath.length)
            return { ...t, key: tabKey(activeRoot, newTabPath), path: newTabPath }
          }
          return t
        }),
      )
      if (activeTabKey?.startsWith(`${activeRoot}:${fromPath}`)) {
        if (activeTabKey === `${activeRoot}:${fromPath}`) {
          setActiveTabKey(tabKey(activeRoot, toPath))
        } else {
          const suffix = activeTabKey.slice(`${activeRoot}:${fromPath}`.length)
          setActiveTabKey(tabKey(activeRoot, toPath + suffix))
        }
      }

      // Refresh tree
      await fetchTree(activeRoot)
    } catch (err) {
      console.error("Move failed:", err)
    }
  }, [activeRoot, activeTabKey, fetchTree])

  // ── Context menu handlers ──

  const handleContextMenu = useCallback((e: React.MouseEvent, path: string, type: "file" | "directory", parentPath: string) => {
    setContextMenu({ x: e.clientX, y: e.clientY, path, type, parentPath })
  }, [])

  const handleContextMenuClose = useCallback(() => {
    setContextMenu(null)
  }, [])

  const handleNewFile = useCallback((parentDir: string) => {
    // Ensure parent directory is expanded
    if (parentDir) {
      const setExpanded = activeRoot === "gsd" ? setGsdExpanded : setProjectExpanded
      setExpanded((prev) => {
        const next = new Set(prev)
        const parts = parentDir.split("/")
        for (let i = 1; i <= parts.length; i++) {
          next.add(parts.slice(0, i).join("/"))
        }
        saveExpanded(projectCwd, activeRoot, next)
        return next
      })
    }
    setCreatingIn({ parentDir, type: "file" })
  }, [activeRoot, projectCwd])

  const handleNewFolder = useCallback((parentDir: string) => {
    if (parentDir) {
      const setExpanded = activeRoot === "gsd" ? setGsdExpanded : setProjectExpanded
      setExpanded((prev) => {
        const next = new Set(prev)
        const parts = parentDir.split("/")
        for (let i = 1; i <= parts.length; i++) {
          next.add(parts.slice(0, i).join("/"))
        }
        saveExpanded(projectCwd, activeRoot, next)
        return next
      })
    }
    setCreatingIn({ parentDir, type: "directory" })
  }, [activeRoot, projectCwd])

  const handleCreateCommit = useCallback(async (parentDir: string, name: string, type: "file" | "directory") => {
    const newPath = parentDir ? `${parentDir}/${name}` : name
    try {
      const res = await fetch("/api/files", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: newPath, type, root: activeRoot }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        console.error("Create failed:", data.error || res.statusText)
        return
      }
      await fetchTree(activeRoot)
      // Open the file if it's a file
      if (type === "file") {
        await openFileTab(activeRoot, newPath)
      }
    } catch (err) {
      console.error("Create failed:", err)
    } finally {
      setCreatingIn(null)
    }
  }, [activeRoot, fetchTree, openFileTab])

  const handleCreateCancel = useCallback(() => {
    setCreatingIn(null)
  }, [])

  const handleRenameStart = useCallback((path: string) => {
    setRenamingPath(path)
  }, [])

  const handleRenameCommit = useCallback(async (oldPath: string, newName: string) => {
    const parentDir = oldPath.includes("/") ? oldPath.substring(0, oldPath.lastIndexOf("/")) : ""
    const newPath = parentDir ? `${parentDir}/${newName}` : newName

    if (newPath === oldPath) {
      setRenamingPath(null)
      return
    }

    try {
      const res = await fetch("/api/files", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from: oldPath, to: newPath, root: activeRoot }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        console.error("Rename failed:", data.error || res.statusText)
        return
      }

      // Update open tabs
      const oldKey = tabKey(activeRoot, oldPath)
      setOpenTabs((prev) =>
        prev.map((t) => {
          if (t.key === oldKey) {
            return { ...t, key: tabKey(activeRoot, newPath), path: newPath }
          }
          if (t.root === activeRoot && t.path.startsWith(oldPath + "/")) {
            const newTabPath = newPath + t.path.slice(oldPath.length)
            return { ...t, key: tabKey(activeRoot, newTabPath), path: newTabPath }
          }
          return t
        }),
      )
      if (activeTabKey === `${activeRoot}:${oldPath}`) {
        setActiveTabKey(tabKey(activeRoot, newPath))
      } else if (activeTabKey?.startsWith(`${activeRoot}:${oldPath}/`)) {
        const suffix = activeTabKey.slice(`${activeRoot}:${oldPath}`.length)
        setActiveTabKey(tabKey(activeRoot, newPath + suffix))
      }

      await fetchTree(activeRoot)
    } catch (err) {
      console.error("Rename failed:", err)
    } finally {
      setRenamingPath(null)
    }
  }, [activeRoot, activeTabKey, fetchTree])

  const handleRenameCancel = useCallback(() => {
    setRenamingPath(null)
  }, [])

  const handleDelete = useCallback((path: string, type: "file" | "directory") => {
    setDeleteConfirm({ path, type })
  }, [])

  const handleDeleteConfirm = useCallback(async () => {
    if (!deleteConfirm) return
    const { path, type } = deleteConfirm
    try {
      const res = await fetch(
        `/api/files?root=${activeRoot}&path=${encodeURIComponent(path)}`,
        { method: "DELETE" },
      )
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        console.error("Delete failed:", data.error || res.statusText)
        return
      }

      // Close any tabs for the deleted path
      setOpenTabs((prev) => {
        const next = prev.filter((t) => {
          if (t.root !== activeRoot) return true
          if (t.path === path) return false
          if (t.path.startsWith(path + "/")) return false
          return true
        })
        // If active tab was removed, switch to adjacent
        if (activeTabKey) {
          const wasRemoved = !next.some((t) => t.key === activeTabKey)
          if (wasRemoved) {
            setActiveTabKey(next.length > 0 ? next[next.length - 1].key : null)
          }
        }
        return next
      })

      await fetchTree(activeRoot)
    } catch (err) {
      console.error("Delete failed:", err)
    } finally {
      setDeleteConfirm(null)
    }
  }, [deleteConfirm, activeRoot, activeTabKey, fetchTree])

  const handleDeleteCancel = useCallback(() => {
    setDeleteConfirm(null)
  }, [])

  const handleCopyPath = useCallback((path: string) => {
    const displayPath = activeRoot === "gsd" ? `.gsd/${path}` : path
    void navigator.clipboard.writeText(displayPath)
  }, [activeRoot])

  const handleDuplicate = useCallback(async (path: string) => {
    // Read original content
    try {
      const res = await fetch(`/api/files?root=${activeRoot}&path=${encodeURIComponent(path)}`)
      if (!res.ok) return
      const data = await res.json()
      if (typeof data.content !== "string") return

      // Compute duplicate name: file.ts -> file-copy.ts, folder -> folder-copy
      const fileName = path.split("/").pop() ?? path
      const parentDir = path.includes("/") ? path.substring(0, path.lastIndexOf("/")) : ""
      const dotIndex = fileName.lastIndexOf(".")
      let newName: string
      if (dotIndex > 0) {
        newName = `${fileName.substring(0, dotIndex)}-copy${fileName.substring(dotIndex)}`
      } else {
        newName = `${fileName}-copy`
      }
      const newPath = parentDir ? `${parentDir}/${newName}` : newName

      // Create with content
      const createRes = await fetch("/api/files", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: newPath, content: data.content, root: activeRoot }),
      })
      if (!createRes.ok) {
        const errData = await createRes.json().catch(() => ({}))
        console.error("Duplicate failed:", errData.error || createRes.statusText)
        return
      }
      await fetchTree(activeRoot)
      await openFileTab(activeRoot, newPath)
    } catch (err) {
      console.error("Duplicate failed:", err)
    }
  }, [activeRoot, fetchTree, openFileTab])

  // Save handler: POST to /api/files, then re-fetch content
  const handleSave = useCallback(async (newContent: string) => {
    if (!activeTab) return
    const { root, path, key } = activeTab
    const res = await fetch("/api/files", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, content: newContent, root }),
    })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      throw new Error(data.error || `Save failed (${res.status})`)
    }
    // Re-fetch to sync the view tab
    const refetch = await fetch(`/api/files?root=${root}&path=${encodeURIComponent(path)}`)
    if (refetch.ok) {
      const data = await refetch.json()
      setOpenTabs((prev) =>
        prev.map((t) =>
          t.key === key ? { ...t, content: data.content ?? null } : t,
        ),
      )
    }
  }, [activeTab])

  // Auto-select STATE.md on initial load if no tabs are open
  const autoSelectedRef = useRef(false)
  useEffect(() => {
    if (autoSelectedRef.current) return
    if (!gsdTree || openTabs.length > 0 || consumedPendingRef.current) return
    const hasStateMd = gsdTree.some((n) => n.name === "STATE.md" && n.type === "file")
    if (hasStateMd) {
      autoSelectedRef.current = true
      void openFileTab("gsd", "STATE.md")
    }
  }, [gsdTree, openTabs.length, openFileTab])

  return (
    <div className="flex h-full">
      {/* File tree panel */}
      <div className="w-64 flex-shrink-0 border-r border-border overflow-y-auto flex flex-col">
        {/* Tab bar */}
        <div className="flex border-b border-border flex-shrink-0">
          <button
            onClick={() => handleTreeRootChange("gsd")}
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
            onClick={() => handleTreeRootChange("project")}
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
        <div
          className={cn("flex-1 overflow-y-auto py-2", treeRootDragOver && "bg-accent/30")}
          onDragOver={(e) => {
            // Only highlight if dragging directly over the root area, not a folder
            if ((e.target as HTMLElement).closest("[data-tree-item]")) return
            if (!e.dataTransfer.types.includes("text/x-tree-path")) return
            e.preventDefault()
            e.dataTransfer.dropEffect = "move"
            setTreeRootDragOver(true)
          }}
          onDragLeave={(e) => {
            // Only clear if leaving the root container entirely
            if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) {
              setTreeRootDragOver(false)
            }
          }}
          onDrop={(e) => {
            setTreeRootDragOver(false)
            if ((e.target as HTMLElement).closest("[data-tree-item]")) return
            e.preventDefault()
            const srcPath = e.dataTransfer.getData("text/x-tree-path")
            if (!srcPath) return
            // Already at root level?
            if (!srcPath.includes("/")) return
            handleMoveFile(srcPath, "")
          }}
          onContextMenu={(e) => {
            // Right-click on empty space in tree — offer New File/Folder at root
            if ((e.target as HTMLElement).closest("[data-tree-item]")) return
            e.preventDefault()
            setContextMenu({ x: e.clientX, y: e.clientY, path: "", type: "directory", parentPath: "" })
          }}
        >
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
            <>
              {/* Root-level create input */}
              {creatingIn && creatingIn.parentDir === "" && (
                <InlineInput
                  defaultValue={creatingIn.type === "directory" ? "new-folder" : "new-file"}
                  onCommit={(name) => handleCreateCommit("", name, creatingIn.type)}
                  onCancel={handleCreateCancel}
                  depth={0}
                  icon={creatingIn.type === "directory"
                    ? <Folder className="h-4 w-4 text-muted-foreground" />
                    : <File className="h-4 w-4 text-muted-foreground" />
                  }
                />
              )}
              {tree.map((node, i) => (
                <FileTreeItem
                  key={`${activeRoot}-${i}`}
                  node={node}
                  depth={0}
                  parentPath=""
                  selectedPath={selectedPath}
                  expandedPaths={expandedPaths}
                  renamingPath={renamingPath}
                  creatingIn={creatingIn}
                  onToggleDir={handleToggleDir}
                  onSelectFile={handleSelectFile}
                  onMoveFile={handleMoveFile}
                  onContextMenu={handleContextMenu}
                  onRenameCommit={handleRenameCommit}
                  onRenameCancel={handleRenameCancel}
                  onCreateCommit={handleCreateCommit}
                  onCreateCancel={handleCreateCancel}
                />
              ))}
            </>
          ) : null}
        </div>
      </div>

      {/* File content panel */}
      <div className="flex-1 overflow-hidden flex flex-col min-h-0">
        {/* Open file tabs */}
        {openTabs.length > 0 && (
          <div className="flex border-b border-border flex-shrink-0 overflow-x-auto bg-background">
            {openTabs.map((tab) => (
              <button
                key={tab.key}
                onClick={() => {
                  setActiveTabKey(tab.key)
                  setActiveRoot(tab.root)
                }}
                className={cn(
                  "group flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border-r border-border transition-colors shrink-0 max-w-[180px]",
                  tab.key === activeTabKey
                    ? "bg-accent/50 text-foreground"
                    : "text-muted-foreground hover:text-foreground hover:bg-accent/20",
                )}
              >
                <span className="truncate" title={tabDisplayPath(tab)}>
                  {tabLabel(tab)}
                </span>
                <span
                  role="button"
                  tabIndex={0}
                  onClick={(e) => closeTab(tab.key, e)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault()
                      closeTab(tab.key)
                    }
                  }}
                  className="ml-0.5 rounded p-0.5 opacity-0 group-hover:opacity-100 hover:bg-accent transition-opacity"
                >
                  <X className="h-3 w-3" />
                </span>
              </button>
            ))}
          </div>
        )}

        {/* Active tab content */}
        {activeTab ? (
          <>
            <div className="flex h-9 items-center border-b border-border px-4">
              <span className="text-sm font-medium font-mono">{tabDisplayPath(activeTab)}</span>
            </div>
            {activeTab.loading ? (
              <div className="flex flex-1 items-center justify-center text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
                Loading…
              </div>
            ) : activeTab.error ? (
              <div className="flex flex-1 items-center justify-center text-destructive">
                <AlertCircle className="h-4 w-4 mr-2" />
                {activeTab.error}
              </div>
            ) : activeTab.content !== null ? (
              <FileContentViewer
                content={activeTab.content}
                filepath={tabDisplayPath(activeTab)}
                root={activeTab.root}
                path={activeTab.path}
                onSave={handleSave}
              />
            ) : (
              <div className="flex flex-1 items-center justify-center text-muted-foreground italic">
                No preview available
              </div>
            )}
          </>
        ) : (
          <div className="flex h-full items-center justify-center text-muted-foreground">
            Select a file to view
          </div>
        )}
      </div>

      {/* Context menu */}
      {contextMenu && (
        <TreeContextMenu
          menu={contextMenu}
          onClose={handleContextMenuClose}
          onNewFile={handleNewFile}
          onNewFolder={handleNewFolder}
          onRename={handleRenameStart}
          onDelete={handleDelete}
          onCopyPath={handleCopyPath}
          onDuplicate={handleDuplicate}
        />
      )}

      {/* Delete confirmation dialog */}
      {deleteConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 animate-in fade-in-0">
          <div className="w-full max-w-sm rounded-lg border border-border bg-popover p-4 shadow-lg animate-in zoom-in-95">
            <h3 className="text-sm font-medium text-popover-foreground">
              Delete {deleteConfirm.type === "directory" ? "folder" : "file"}?
            </h3>
            <p className="mt-2 text-xs text-muted-foreground">
              Are you sure you want to delete{" "}
              <span className="font-mono font-medium text-popover-foreground">
                {deleteConfirm.path.split("/").pop()}
              </span>
              ?{deleteConfirm.type === "directory" && " This will delete all contents."}
              {" "}This cannot be undone.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={handleDeleteCancel}
                className="rounded-md px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-accent transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleDeleteConfirm}
                className="rounded-md bg-destructive px-3 py-1.5 text-xs font-medium text-destructive-foreground hover:bg-destructive/90 transition-colors"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
