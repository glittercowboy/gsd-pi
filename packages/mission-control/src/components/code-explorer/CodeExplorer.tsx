/**
 * CodeExplorer — full-screen modal with file tree + CodeMirror editor.
 * Opens from sidebar <> button, scoped to projectRoot.
 * Reads via GET /api/fs/read, saves via POST /api/fs/write.
 */
import { useState, useEffect, useCallback } from "react";
import { X, Copy, Save } from "lucide-react";
import { FileTree } from "./FileTree";
import { FileEditor } from "./FileEditor";
import { useCodeExplorer } from "./useCodeExplorer";

interface CodeExplorerProps {
  isOpen: boolean;
  onClose: () => void;
  projectRoot: string;
}

export function CodeExplorer({ isOpen, onClose, projectRoot }: CodeExplorerProps) {
  const { selectedFile, selectFile } = useCodeExplorer();
  const [fileContent, setFileContent] = useState("");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Load file content when a file is selected
  useEffect(() => {
    if (!selectedFile) return;
    setLoading(true);
    setSaveError(null);
    fetch("/api/fs/read?path=" + encodeURIComponent(selectedFile))
      .then((res) => res.json())
      .then((data) => {
        setFileContent(data.content ?? "");
        setDirty(false);
      })
      .catch(() => {
        setFileContent("(error loading file)");
      })
      .finally(() => setLoading(false));
  }, [selectedFile]);

  const handleChange = useCallback((content: string) => {
    setFileContent(content);
    setDirty(true);
    setSaveError(null);
  }, []);

  const handleSave = useCallback(async () => {
    if (!selectedFile || !dirty) return;
    setSaving(true);
    setSaveError(null);
    try {
      const res = await fetch("/api/fs/write", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: selectedFile, content: fileContent }),
      });
      if (res.ok) {
        setDirty(false);
      } else {
        const data = await res.json().catch(() => ({}));
        setSaveError(data.error ?? "Save failed");
      }
    } catch (err: any) {
      setSaveError(err.message ?? "Save failed");
    } finally {
      setSaving(false);
    }
  }, [selectedFile, dirty, fileContent]);

  const handleClose = useCallback(() => {
    onClose();
  }, [onClose]);

  const handleCopyPath = useCallback(() => {
    if (selectedFile) {
      navigator.clipboard.writeText(selectedFile).catch(() => {});
    }
  }, [selectedFile]);

  // Backdrop click
  const handleBackdropClick = useCallback((e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      handleClose();
    }
  }, [handleClose]);

  if (!isOpen) return null;

  // Derive filename for breadcrumb
  const fileName = selectedFile
    ? selectedFile.replace(/\\/g, "/").split("/").pop() ?? selectedFile
    : null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: "rgba(0,0,0,0.8)" }}
      onClick={handleBackdropClick}
    >
      <div
        className="flex flex-col rounded-lg overflow-hidden"
        style={{
          width: "95vw",
          height: "90vh",
          background: "#131A21",
          border: "1px solid #2D3B4E",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          className="flex items-center gap-2 px-4 shrink-0"
          style={{
            height: "44px",
            borderBottom: "1px solid #2D3B4E",
            background: "#0F1419",
          }}
        >
          <span className="text-sm font-medium text-slate-300">Code Explorer</span>
          {selectedFile && (
            <>
              <span className="text-slate-600 mx-1">/</span>
              <span className="text-xs font-mono text-slate-400 truncate max-w-[400px]" title={selectedFile}>
                {fileName}
              </span>
              {dirty && (
                <span className="text-xs text-status-warning ml-1" title="Unsaved changes">
                  •
                </span>
              )}
            </>
          )}
          <div className="flex-1" />
          {saveError && (
            <span className="text-xs text-status-error mr-2">{saveError}</span>
          )}
          {selectedFile && (
            <button
              type="button"
              onClick={handleCopyPath}
              className="flex items-center gap-1 rounded px-2 py-1 text-xs text-slate-400 transition-colors hover:bg-navy-700 hover:text-slate-300"
              title="Copy file path"
            >
              <Copy className="h-3 w-3" />
            </button>
          )}
          {dirty && (
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              className="flex items-center gap-1 rounded px-2 py-1 text-xs text-cyan-accent transition-colors hover:bg-navy-700 disabled:opacity-50"
              title="Save (Ctrl+S / Cmd+S)"
            >
              <Save className="h-3 w-3" />
              <span>{saving ? "Saving…" : "Save"}</span>
            </button>
          )}
          <button
            type="button"
            onClick={handleClose}
            className="flex items-center justify-center h-7 w-7 rounded text-slate-400 transition-colors hover:bg-navy-700 hover:text-slate-300"
            aria-label="Close Code Explorer"
            title="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body: tree + editor */}
        <div className="flex flex-1 min-h-0 overflow-hidden">
          {/* Left: File tree */}
          <div
            className="shrink-0 overflow-hidden"
            style={{
              width: "256px",
              borderRight: "1px solid #2D3B4E",
            }}
          >
            {projectRoot ? (
              <FileTree
                projectRoot={projectRoot}
                onSelectFile={selectFile}
                selectedFile={selectedFile}
              />
            ) : (
              <div className="p-4 text-xs text-slate-500">No project open</div>
            )}
          </div>

          {/* Right: Editor */}
          <div className="flex-1 min-w-0 overflow-hidden">
            {loading ? (
              <div className="flex h-full items-center justify-center text-xs text-slate-500">
                Loading…
              </div>
            ) : selectedFile ? (
              <FileEditor
                content={fileContent}
                filePath={selectedFile}
                onChange={handleChange}
                onSave={handleSave}
              />
            ) : (
              <div className="flex h-full items-center justify-center text-xs text-slate-500">
                Select a file from the tree
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
