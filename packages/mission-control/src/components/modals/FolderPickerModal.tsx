/**
 * FolderPickerModal — custom branded file browser modal.
 * Replaces native OS folder dialog with our own styled picker
 * that uses the existing FS API for directory browsing.
 */
import { useState, useCallback, useEffect } from "react";
import { X, ArrowLeft, Folder, ChevronRight, ChevronDown, RefreshCw, FolderOpen, Check, AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import type { FileSystemEntry } from "@/server/fs-types";

interface FolderPickerModalProps {
  open: boolean;
  onClose: () => void;
  onSelect: (path: string) => void;
}

type SwitchStatus = null | "switching" | "success" | "error";

export function FolderPickerModal({ open, onClose, onSelect }: FolderPickerModalProps) {
  const [currentPath, setCurrentPath] = useState<string | null>(null);
  const [entries, setEntries] = useState<FileSystemEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [selectedIsGsd, setSelectedIsGsd] = useState(false);
  const [expandedDirs, setExpandedDirs] = useState<Record<string, FileSystemEntry[]>>({});
  const [currentDirIsGsd, setCurrentDirIsGsd] = useState(false);
  const [switchStatus, setSwitchStatus] = useState<SwitchStatus>(null);
  const [switchError, setSwitchError] = useState<string | null>(null);

  const browse = useCallback(async (path: string) => {
    setLoading(true);
    setError(null);
    setSelectedPath(null);
    setSelectedIsGsd(false);
    try {
      // Fetch directory listing and GSD detection in parallel
      const [listRes, detectRes] = await Promise.all([
        fetch(`/api/fs/list?path=${encodeURIComponent(path)}`),
        path ? fetch(`/api/fs/detect-project?path=${encodeURIComponent(path)}`) : null,
      ]);
      if (!listRes.ok) {
        const body = await listRes.json().catch(() => ({ error: "Request failed" }));
        throw new Error(body.error || `HTTP ${listRes.status}`);
      }
      const data: FileSystemEntry[] = await listRes.json();
      // Only show directories
      setEntries(data.filter((e) => e.isDirectory));
      setCurrentPath(path);
      setExpandedDirs({});
      // Check if current directory itself is a GSD project (via detect-project API)
      if (detectRes?.ok) {
        const detect = await detectRes.json();
        setCurrentDirIsGsd(detect.isGsdProject === true);
      } else {
        setCurrentDirIsGsd(false);
      }
    } catch (err: any) {
      setError(err.message || "Failed to browse directory");
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, []);

  const goUp = useCallback(() => {
    if (!currentPath) return;
    const segments = currentPath.replace(/\\/g, "/").split("/").filter(Boolean);
    if (segments.length <= 1) return;
    segments.pop();
    const parentPath = segments.join("/");
    const parent = currentPath.match(/^[A-Z]:/i) ? parentPath : "/" + parentPath;
    browse(parent);
  }, [currentPath, browse]);

  // Start browsing from home on open
  useEffect(() => {
    if (open && !currentPath) {
      browse("");
    }
  }, [open, currentPath, browse]);

  const handleOpen = useCallback(async () => {
    // Use selectedPath if a child is selected, otherwise use currentPath
    const pathToOpen = selectedPath || currentPath;
    if (!pathToOpen) return;

    setSwitchStatus("switching");
    setSwitchError(null);
    try {
      const res = await fetch("/api/project/switch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: pathToOpen }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: "Switch failed" }));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      setSwitchStatus("success");
      onSelect(pathToOpen);

      // Auto-close after success feedback
      setTimeout(() => {
        onClose();
        setCurrentPath(null);
        setSelectedPath(null);
        setExpandedDirs({});
        setSwitchStatus(null);
      }, 800);
    } catch (err: any) {
      setSwitchStatus("error");
      setSwitchError(err.message || "Failed to switch project");
    }
  }, [selectedPath, currentPath, onSelect, onClose]);

  const handleClose = useCallback(() => {
    onClose();
    setCurrentPath(null);
    setSelectedPath(null);
    setExpandedDirs({});
    setSwitchStatus(null);
    setSwitchError(null);
  }, [onClose]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") handleClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, handleClose]);

  if (!open) return null;

  const breadcrumbs = currentPath
    ? currentPath.replace(/\\/g, "/").split("/").filter(Boolean)
    : [];

  const effectivePath = selectedPath || currentPath;
  const effectiveIsGsd = selectedPath ? selectedIsGsd : currentDirIsGsd;
  const currentFolderName = currentPath
    ? currentPath.replace(/\\/g, "/").split("/").filter(Boolean).pop() || currentPath
    : "";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) handleClose(); }}
    >
      <div className="flex flex-col w-[560px] max-h-[80vh] rounded-lg border border-navy-600 bg-navy-900 shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center gap-3 border-b border-navy-600 px-4 py-3">
          <FolderOpen className="h-5 w-5 text-cyan-accent" />
          <h2 className="flex-1 font-display text-sm font-bold uppercase tracking-wider text-slate-300">
            Open Project
          </h2>
          <button
            type="button"
            onClick={handleClose}
            className="rounded p-1 text-slate-500 hover:bg-navy-700 hover:text-slate-300 transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Breadcrumb */}
        {currentPath && (
          <div className="flex items-center gap-1 overflow-x-auto px-4 py-2 border-b border-navy-700 bg-navy-800/50">
            <button
              type="button"
              onClick={goUp}
              className="shrink-0 rounded p-1 text-slate-500 hover:text-slate-300 transition-colors"
              title="Go up"
            >
              <ArrowLeft className="h-3 w-3" />
            </button>
            {breadcrumbs.map((segment, i) => {
              const segmentPath = breadcrumbs.slice(0, i + 1).join("/");
              const fullPath = currentPath.match(/^[A-Z]:/i) ? segmentPath : "/" + segmentPath;
              return (
                <span key={i} className="flex items-center gap-1">
                  {i > 0 && <span className="text-slate-600 text-xs">/</span>}
                  <button
                    type="button"
                    onClick={() => browse(fullPath)}
                    className="text-xs font-mono text-slate-400 hover:text-cyan-accent transition-colors truncate max-w-[100px]"
                    title={fullPath}
                  >
                    {segment}
                  </button>
                </span>
              );
            })}
            {currentDirIsGsd && (
              <span className="ml-2 shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold text-cyan-accent bg-cyan-accent/10 uppercase tracking-wider">
                GSD
              </span>
            )}
          </div>
        )}

        {/* File list */}
        <div className="flex-1 overflow-auto min-h-[300px]">
          {loading && (
            <div className="flex items-center justify-center p-8">
              <RefreshCw className="h-4 w-4 animate-spin text-slate-500" />
              <span className="ml-2 text-xs text-slate-400">Loading...</span>
            </div>
          )}

          {error && (
            <div className="p-4">
              <p className="text-xs text-red-400 mb-2">{error}</p>
              <button
                type="button"
                onClick={() => currentPath && browse(currentPath)}
                className="text-xs text-cyan-accent hover:underline"
              >
                Retry
              </button>
            </div>
          )}

          {!loading && !error && entries.length === 0 && (
            <p className="p-6 text-xs text-slate-500 text-center">No subdirectories</p>
          )}

          {!loading && !error && entries.map((entry) => (
            <FolderRow
              key={entry.path}
              entry={entry}
              depth={0}
              selectedPath={selectedPath}
              expandedDirs={expandedDirs}
              onExpandDir={(path, children) =>
                setExpandedDirs((prev) => ({ ...prev, [path]: children }))
              }
              onCollapseDir={(path) =>
                setExpandedDirs((prev) => {
                  const next = { ...prev };
                  delete next[path];
                  return next;
                })
              }
              onSelect={(path, isGsd) => {
                setSelectedPath(path);
                setSelectedIsGsd(isGsd);
              }}
              onDoubleClick={(path) => browse(path)}
            />
          ))}
        </div>

        {/* Status toast */}
        {switchStatus === "success" && (
          <div className="flex items-center gap-2 px-4 py-2 bg-green-900/30 border-t border-green-800/50">
            <Check className="h-4 w-4 text-green-400" />
            <span className="text-xs text-green-300">
              Switched to {effectivePath?.split("/").pop()}
            </span>
          </div>
        )}
        {switchStatus === "error" && (
          <div className="flex items-center gap-2 px-4 py-2 bg-red-900/30 border-t border-red-800/50">
            <AlertCircle className="h-4 w-4 text-red-400" />
            <span className="text-xs text-red-300">{switchError}</span>
          </div>
        )}

        {/* Footer */}
        <div className="flex items-center gap-3 border-t border-navy-600 px-4 py-3 bg-navy-800/50">
          <div className="flex-1 min-w-0">
            {selectedPath ? (
              <span className="block truncate text-xs font-mono text-slate-300" title={selectedPath}>
                {selectedPath}
              </span>
            ) : currentPath ? (
              <span className="block truncate text-xs font-mono text-slate-400" title={currentPath}>
                {currentPath}
                <span className="text-slate-500 ml-1">(current folder)</span>
              </span>
            ) : (
              <span className="text-xs text-slate-500">Select a folder</span>
            )}
          </div>
          <button
            type="button"
            onClick={handleClose}
            className="shrink-0 rounded px-4 py-1.5 text-xs text-slate-400 hover:bg-navy-700 transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleOpen}
            disabled={!effectivePath || switchStatus === "switching" || switchStatus === "success"}
            className={cn(
              "shrink-0 rounded px-4 py-1.5 text-xs font-display transition-colors",
              !effectivePath || switchStatus === "switching" || switchStatus === "success"
                ? "bg-navy-700 text-slate-500 cursor-not-allowed"
                : "bg-cyan-accent text-navy-900 hover:bg-cyan-accent/80",
            )}
          >
            {switchStatus === "switching" ? (
              <span className="flex items-center gap-1">
                <RefreshCw className="h-3 w-3 animate-spin" />
                Switching...
              </span>
            ) : effectiveIsGsd ? (
              "Open Project"
            ) : (
              "Open Project"
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Single folder row with expand/collapse */
function FolderRow({
  entry,
  depth,
  selectedPath,
  expandedDirs,
  onExpandDir,
  onCollapseDir,
  onSelect,
  onDoubleClick,
}: {
  entry: FileSystemEntry;
  depth: number;
  selectedPath: string | null;
  expandedDirs: Record<string, FileSystemEntry[]>;
  onExpandDir: (path: string, children: FileSystemEntry[]) => void;
  onCollapseDir: (path: string) => void;
  onSelect: (path: string, isGsd: boolean) => void;
  onDoubleClick: (path: string) => void;
}) {
  const selected = entry.path === selectedPath;
  const isExpanded = entry.path in expandedDirs;
  const children = expandedDirs[entry.path];
  const [loadingChildren, setLoadingChildren] = useState(false);

  const handleToggleExpand = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isExpanded) {
      onCollapseDir(entry.path);
      return;
    }
    setLoadingChildren(true);
    try {
      const res = await fetch(`/api/fs/list?path=${encodeURIComponent(entry.path)}`);
      if (res.ok) {
        const data: FileSystemEntry[] = await res.json();
        onExpandDir(entry.path, data.filter((e) => e.isDirectory));
      }
    } catch {
      // silent
    } finally {
      setLoadingChildren(false);
    }
  }, [entry.path, isExpanded, onExpandDir, onCollapseDir]);

  return (
    <>
      <button
        type="button"
        onClick={() => onSelect(entry.path, entry.isGsdProject)}
        onDoubleClick={() => onDoubleClick(entry.path)}
        className={cn(
          "flex w-full items-center gap-2 py-1.5 text-left text-xs transition-colors border-l-2",
          selected
            ? "border-cyan-accent bg-cyan-accent/10 text-cyan-accent"
            : "border-transparent text-slate-300 hover:bg-navy-700 hover:border-navy-500",
        )}
        style={{ paddingLeft: depth * 16 + 10 }}
      >
        {/* Expand chevron */}
        <span
          role="button"
          onClick={handleToggleExpand}
          className="shrink-0 p-0.5 text-slate-500 hover:text-slate-300"
        >
          {loadingChildren ? (
            <RefreshCw className="h-3 w-3 animate-spin" />
          ) : isExpanded ? (
            <ChevronDown className="h-3 w-3" />
          ) : (
            <ChevronRight className="h-3 w-3" />
          )}
        </span>

        <Folder className={cn("h-3.5 w-3.5 shrink-0", selected ? "text-cyan-accent" : "text-slate-400")} />
        <span className="truncate font-mono">{entry.name}</span>

        {entry.isGsdProject && (
          <span className="ml-auto shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold text-cyan-accent bg-cyan-accent/10 uppercase tracking-wider">
            GSD
          </span>
        )}
      </button>

      {isExpanded && children && children.map((child) => (
        <FolderRow
          key={child.path}
          entry={child}
          depth={depth + 1}
          selectedPath={selectedPath}
          expandedDirs={expandedDirs}
          onExpandDir={onExpandDir}
          onCollapseDir={onCollapseDir}
          onSelect={onSelect}
          onDoubleClick={onDoubleClick}
        />
      ))}
    </>
  );
}
