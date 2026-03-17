/**
 * FileTree — recursive file tree component for Code Explorer.
 * Loads directory contents via /api/fs/list and lazily expands directories.
 */
import { useState, useEffect, useCallback } from "react";
import { Folder, FolderOpen, File } from "lucide-react";
import type { FileSystemEntry } from "@/server/fs-types";

interface FileTreeProps {
  projectRoot: string;
  onSelectFile: (path: string) => void;
  selectedFile: string | null;
}

export function FileTree({ projectRoot, onSelectFile, selectedFile }: FileTreeProps) {
  const [entries, setEntries] = useState<Map<string, FileSystemEntry[]>>(new Map());
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState<Set<string>>(new Set());

  const loadDir = useCallback(async (dirPath: string) => {
    if (entries.has(dirPath)) return;
    setLoading((prev) => new Set(prev).add(dirPath));
    try {
      const res = await fetch("/api/fs/list?path=" + encodeURIComponent(dirPath));
      if (res.ok) {
        const data: FileSystemEntry[] = await res.json();
        setEntries((prev) => new Map(prev).set(dirPath, data));
      }
    } catch {
      // ignore network errors
    } finally {
      setLoading((prev) => {
        const next = new Set(prev);
        next.delete(dirPath);
        return next;
      });
    }
  }, [entries]);

  // Load root on mount
  useEffect(() => {
    if (projectRoot) {
      loadDir(projectRoot);
      setExpandedDirs(new Set([projectRoot]));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectRoot]);

  const toggleDir = useCallback((dirPath: string) => {
    setExpandedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(dirPath)) {
        next.delete(dirPath);
      } else {
        next.add(dirPath);
        loadDir(dirPath);
      }
      return next;
    });
  }, [loadDir]);

  const renderEntries = (dirPath: string, depth: number): React.ReactNode => {
    const dirEntries = entries.get(dirPath);
    if (!dirEntries) {
      if (loading.has(dirPath)) {
        return (
          <div style={{ paddingLeft: `${(depth + 1) * 16}px` }} className="py-0.5 text-xs text-slate-500">
            Loading…
          </div>
        );
      }
      return null;
    }

    return dirEntries.map((entry) => {
      const isSelected = entry.path === selectedFile;
      const isExpanded = expandedDirs.has(entry.path);

      if (entry.isDirectory) {
        return (
          <div key={entry.path}>
            <button
              type="button"
              onClick={() => toggleDir(entry.path)}
              className="flex w-full items-center gap-1 py-0.5 text-xs text-slate-400 transition-colors hover:bg-navy-700 hover:text-slate-300 rounded"
              style={{ paddingLeft: `${(depth + 1) * 16}px` }}
              title={entry.path}
            >
              {isExpanded
                ? <FolderOpen className="h-3 w-3 shrink-0 text-status-warning" />
                : <Folder className="h-3 w-3 shrink-0 text-slate-500" />
              }
              <span className="truncate">{entry.name}</span>
            </button>
            {isExpanded && renderEntries(entry.path, depth + 1)}
          </div>
        );
      }

      return (
        <button
          key={entry.path}
          type="button"
          onClick={() => onSelectFile(entry.path)}
          className={`flex w-full items-center gap-1 py-0.5 text-xs rounded transition-colors ${
            isSelected
              ? "bg-navy-700 text-cyan-accent"
              : "text-slate-400 hover:bg-navy-700 hover:text-slate-300"
          }`}
          style={{ paddingLeft: `${(depth + 1) * 16}px` }}
          title={entry.path}
        >
          <File className="h-3 w-3 shrink-0" />
          <span className="truncate">{entry.name}</span>
        </button>
      );
    });
  };

  return (
    <div className="h-full overflow-auto scrollbar-thin py-1">
      {renderEntries(projectRoot, 0)}
    </div>
  );
}
