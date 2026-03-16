/**
 * AssetsView — thumbnail grid gallery for project assets.
 *
 * Supports grid/list toggle, type filter, drag-drop upload, and delete.
 * Uses useAssets hook for all data operations.
 */
import { useState, useCallback, useRef } from "react";
import {
  Upload,
  Grid,
  List,
  Trash2,
  FileText,
  FileCode,
  X,
  Image as ImageIcon,
  FolderOpen,
  File,
  ArrowLeft,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useAssets, type AssetItem } from "@/hooks/useAssets";

const IMAGE_EXTS = ["png", "jpg", "jpeg", "gif", "svg", "webp"];
const VIDEO_EXTS = ["mp4", "webm", "mov"];

function getExtCategory(name: string): "image" | "video" | "document" {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (IMAGE_EXTS.includes(ext)) return "image";
  if (VIDEO_EXTS.includes(ext)) return "video";
  return "document";
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString();
}

/** Custom branded file picker modal for asset uploads with category selection. */
function AssetFilePickerModal({
  isOpen,
  onClose,
  onFilesSelected,
  categories,
}: {
  isOpen: boolean;
  onClose: () => void;
  onFilesSelected: (files: File[], category: string) => void;
  categories: string[];
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState<"file" | "category">("file");
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [selectedCategory, setSelectedCategory] = useState<string>("");
  const [newCategory, setNewCategory] = useState<string>("");
  const [useNewCategory, setUseNewCategory] = useState(false);

  const handleClose = () => {
    setStep("file");
    setPendingFiles([]);
    setSelectedCategory("");
    setNewCategory("");
    setUseNewCategory(false);
    onClose();
  };

  if (!isOpen) return null;

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (files.length > 0) {
      setPendingFiles(files);
      setStep("category");
    }
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) handleClose();
      }}
    >
      <div className="w-[440px] rounded-lg border border-navy-600 bg-navy-900 shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center gap-3 border-b border-navy-600 px-4 py-3">
          <Upload className="h-5 w-5 text-cyan-accent" />
          <h2 className="flex-1 font-display text-sm font-bold uppercase tracking-wider text-slate-300">
            Upload Assets
          </h2>
          <button
            type="button"
            onClick={handleClose}
            className="rounded p-1 text-slate-500 hover:bg-navy-700 hover:text-slate-300 transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {step === "file" && (
          <>
            {/* Upload area */}
            <div className="p-6">
              <div
                onClick={() => fileInputRef.current?.click()}
                className="flex flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed border-navy-600 bg-navy-800/50 p-8 cursor-pointer transition-colors hover:border-cyan-accent/50 hover:bg-navy-800"
              >
                <div className="rounded-full bg-navy-700 p-4">
                  <FolderOpen className="h-8 w-8 text-cyan-accent" />
                </div>
                <div className="text-center">
                  <p className="text-sm font-medium text-slate-200">
                    Click to browse files
                  </p>
                  <p className="text-xs text-slate-500 mt-1">
                    Images, videos, documents — up to 10MB each
                  </p>
                </div>
              </div>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                onChange={handleFileChange}
                className="hidden"
              />
            </div>

            {/* Supported formats */}
            <div className="border-t border-navy-600 px-4 py-3">
              <div className="flex flex-wrap gap-2">
                {["PNG", "JPG", "GIF", "SVG", "WebP", "MP4", "PDF", "MD"].map((fmt) => (
                  <span
                    key={fmt}
                    className="text-[10px] font-mono text-slate-500 bg-navy-800 px-2 py-0.5 rounded"
                  >
                    .{fmt.toLowerCase()}
                  </span>
                ))}
              </div>
            </div>
          </>
        )}

        {step === "category" && (
          <div className="p-6 flex flex-col gap-4">
            <div>
              <p className="text-sm text-slate-300 mb-1">
                {pendingFiles.length} file{pendingFiles.length !== 1 ? "s" : ""} selected
              </p>
              <p className="text-xs text-slate-500">Select or create a category</p>
            </div>

            {/* Existing categories */}
            {categories.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {categories.map((cat) => (
                  <button
                    key={cat}
                    type="button"
                    onClick={() => { setSelectedCategory(cat); setUseNewCategory(false); }}
                    className={cn(
                      "rounded px-3 py-1.5 text-xs font-mono transition-colors",
                      selectedCategory === cat && !useNewCategory
                        ? "bg-cyan-accent text-navy-900"
                        : "bg-navy-700 text-slate-300 hover:bg-navy-600"
                    )}
                  >
                    {cat}
                  </button>
                ))}
              </div>
            )}

            {/* New category input */}
            <div className="flex gap-2">
              <input
                type="text"
                placeholder="New category name..."
                value={newCategory}
                onChange={(e) => { setNewCategory(e.target.value); setUseNewCategory(true); setSelectedCategory(""); }}
                className="flex-1 rounded bg-navy-800 border border-navy-600 px-3 py-1.5 text-xs text-slate-300 font-mono placeholder:text-slate-600 focus:outline-none focus:border-cyan-accent"
              />
            </div>

            {/* Action buttons */}
            <div className="flex gap-2 justify-end">
              <button type="button" onClick={() => setStep("file")} className="px-3 py-1.5 text-xs text-slate-400 hover:text-slate-300 rounded hover:bg-navy-700">
                Back
              </button>
              <button
                type="button"
                disabled={!selectedCategory && !newCategory.trim()}
                onClick={() => {
                  const cat = useNewCategory ? newCategory.trim() : selectedCategory;
                  if (!cat) return;
                  onFilesSelected(pendingFiles, cat);
                  handleClose();
                }}
                className={cn(
                  "rounded px-4 py-1.5 text-xs font-display transition-colors",
                  !selectedCategory && !newCategory.trim()
                    ? "bg-navy-700 text-slate-500 cursor-not-allowed"
                    : "bg-cyan-accent text-navy-900 hover:bg-cyan-accent/80"
                )}
              >
                Upload
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export function AssetsView() {
  const {
    filteredAssets,
    loading,
    error,
    upload,
    remove,
    filter,
    setFilter,
    viewMode,
    setViewMode,
    categories,
  } = useAssets();

  const [isDragging, setIsDragging] = useState(false);
  const [preview, setPreview] = useState<AssetItem | null>(null);
  const [showFilePicker, setShowFilePicker] = useState(false);
  const dragCounterRef = useRef(0);

  const handleUploadClick = useCallback(() => {
    setShowFilePicker(true);
  }, []);

  const handleFilesSelected = useCallback(
    async (files: File[], category: string) => {
      for (const file of files) {
        await upload(file, category);
      }
    },
    [upload],
  );

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCounterRef.current += 1;
    if (e.dataTransfer.types.includes("Files")) setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCounterRef.current -= 1;
    if (dragCounterRef.current <= 0) {
      setIsDragging(false);
      dragCounterRef.current = 0;
    }
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
  }, []);

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      dragCounterRef.current = 0;
      const files = Array.from(e.dataTransfer.files);
      for (const file of files) {
        await upload(file);
      }
    },
    [upload],
  );

  const handleDelete = useCallback(
    async (name: string, e: React.MouseEvent) => {
      e.stopPropagation();
      await remove(name);
    },
    [remove],
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-slate-500 text-sm font-mono">Loading assets...</p>
      </div>
    );
  }

  return (
    <div
      className="flex flex-col h-full bg-navy-900 relative"
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {/* Header */}
      <div className="border-b border-navy-600 p-4 flex items-center gap-2">
        <h1 className="text-lg font-display text-slate-200 flex-1">Assets</h1>
        {/* Filter */}
        <div className="flex flex-wrap gap-1">
          {(["all", "images", "video", "documents",
             ...categories.filter(c => !["uncategorized"].includes(c.toLowerCase()) && !["images","video","documents"].includes(c.toLowerCase()))
          ] as string[]).map((cat) => (
            <button
              key={cat}
              type="button"
              onClick={() => setFilter(cat)}
              className={cn(
                "rounded px-2 py-1 text-xs font-mono transition-colors",
                filter === cat
                  ? "bg-cyan-accent text-navy-900"
                  : "bg-navy-700 text-slate-400 hover:text-slate-300 hover:bg-navy-600",
              )}
            >
              {cat === "all" ? "All" : cat.charAt(0).toUpperCase() + cat.slice(1)}
            </button>
          ))}
        </div>
        {/* View toggle */}
        <button
          type="button"
          onClick={() => setViewMode(viewMode === "grid" ? "list" : "grid")}
          className="rounded p-1.5 text-slate-400 hover:bg-navy-700 hover:text-slate-300"
          title={viewMode === "grid" ? "Switch to list" : "Switch to grid"}
        >
          {viewMode === "grid" ? (
            <List className="h-4 w-4" />
          ) : (
            <Grid className="h-4 w-4" />
          )}
        </button>
        {/* Upload button */}
        <button
          type="button"
          onClick={handleUploadClick}
          className="flex items-center gap-1 rounded-md bg-cyan-accent px-3 py-1.5 text-xs font-medium text-navy-900 hover:bg-cyan-accent/90"
        >
          <Upload className="h-3.5 w-3.5" />
          Upload
        </button>
      </div>

      {/* Error */}
      {error && (
        <div className="px-4 py-2 text-xs text-red-400 bg-red-900/20">
          {error}
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4">
        {filteredAssets.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-slate-500">
            <ImageIcon className="h-12 w-12 mb-4 opacity-30" />
            <p className="text-sm">No assets yet.</p>
            <p className="text-xs mt-1">
              Drag files here or click Upload.
            </p>
          </div>
        ) : viewMode === "grid" ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
            {filteredAssets.map((asset) => (
              <AssetCard
                key={asset.name}
                asset={asset}
                onClick={() => setPreview(asset)}
                onDelete={(e) => handleDelete(asset.name, e)}
              />
            ))}
          </div>
        ) : (
          <div className="space-y-1">
            {filteredAssets.map((asset) => (
              <AssetRow
                key={asset.name}
                asset={asset}
                onClick={() => setPreview(asset)}
                onDelete={(e) => handleDelete(asset.name, e)}
              />
            ))}
          </div>
        )}
      </div>

      {/* Drag overlay */}
      {isDragging && (
        <div className="absolute inset-0 z-50 flex items-center justify-center rounded-md border-2 border-dashed border-cyan-accent bg-cyan-accent/10">
          <p className="text-cyan-accent font-mono text-sm">
            Drop files to upload
          </p>
        </div>
      )}

      {/* Preview overlay */}
      {preview && (
        <PreviewOverlay asset={preview} onClose={() => setPreview(null)} />
      )}

      {/* Custom file picker modal */}
      <AssetFilePickerModal
        isOpen={showFilePicker}
        onClose={() => setShowFilePicker(false)}
        onFilesSelected={handleFilesSelected}
        categories={categories}
      />
    </div>
  );
}

/* --- Sub-components --- */

function AssetCard({
  asset,
  onClick,
  onDelete,
}: {
  asset: AssetItem;
  onClick: () => void;
  onDelete: (e: React.MouseEvent) => void;
}) {
  const cat = getExtCategory(asset.name);
  return (
    <div
      onClick={onClick}
      className="group relative rounded-md bg-navy-800 border border-navy-600 overflow-hidden cursor-pointer hover:border-cyan-accent/50 transition-colors"
    >
      {/* Thumbnail */}
      <div className="h-[120px] flex items-center justify-center bg-navy-900">
        {cat === "image" ? (
          <img
            src={`/api/assets/file/${encodeURIComponent(asset.name)}`}
            alt={asset.name}
            className="w-full h-full object-cover"
          />
        ) : cat === "video" ? (
          <video
            src={`/api/assets/file/${encodeURIComponent(asset.name)}`}
            className="w-full h-full object-cover"
          />
        ) : (
          <FileText className="h-10 w-10 text-slate-600" />
        )}
      </div>
      {/* Info */}
      <div className="p-2">
        <p className="text-xs text-slate-300 truncate">{asset.name}</p>
        {asset.category && asset.category !== "Uncategorized" && (
          <span className="block truncate text-[9px] font-mono text-cyan-accent/70 bg-cyan-accent/10 px-1 py-0.5 rounded mt-0.5">
            {asset.category}
          </span>
        )}
        <p className="text-xs text-slate-500">{formatSize(asset.size)}</p>
      </div>
      {/* Delete */}
      <button
        type="button"
        onClick={onDelete}
        className="absolute top-1 right-1 rounded p-1 bg-navy-900/80 text-slate-400 opacity-0 group-hover:opacity-100 hover:text-red-400 transition-opacity"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

function AssetRow({
  asset,
  onClick,
  onDelete,
}: {
  asset: AssetItem;
  onClick: () => void;
  onDelete: (e: React.MouseEvent) => void;
}) {
  const cat = getExtCategory(asset.name);
  const ext = asset.name.split(".").pop()?.toUpperCase() ?? "";
  return (
    <div
      onClick={onClick}
      className="group flex items-center gap-3 rounded-md bg-navy-800 border border-navy-600 px-3 py-2 cursor-pointer hover:border-cyan-accent/50 transition-colors"
    >
      {cat === "image" ? (
        <ImageIcon className="h-4 w-4 text-slate-400 flex-shrink-0" />
      ) : cat === "video" ? (
        <FileCode className="h-4 w-4 text-slate-400 flex-shrink-0" />
      ) : (
        <FileText className="h-4 w-4 text-slate-400 flex-shrink-0" />
      )}
      <span className="flex-1 text-sm text-slate-300 truncate">
        {asset.name}
      </span>
      <span className="text-xs text-slate-500 bg-navy-700 px-1.5 py-0.5 rounded">
        {ext}
      </span>
      <span className="text-xs text-slate-500 w-16 text-right">
        {formatSize(asset.size)}
      </span>
      <span className="text-xs text-slate-500 w-20 text-right">
        {formatDate(asset.createdAt)}
      </span>
      <button
        type="button"
        onClick={onDelete}
        className="rounded p-1 text-slate-400 opacity-0 group-hover:opacity-100 hover:text-red-400 transition-opacity"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

function PreviewOverlay({
  asset,
  onClose,
}: {
  asset: AssetItem;
  onClose: () => void;
}) {
  const cat = getExtCategory(asset.name);
  return (
    <div
      className="absolute inset-0 z-50 flex items-center justify-center bg-navy-900/90"
      onClick={onClose}
    >
      <div
        className="relative max-w-[80%] max-h-[80%]"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={onClose}
          className="absolute -top-8 right-0 rounded p-1 text-slate-400 hover:text-slate-200"
        >
          <X className="h-5 w-5" />
        </button>
        {cat === "image" ? (
          <img
            src={`/api/assets/file/${encodeURIComponent(asset.name)}`}
            alt={asset.name}
            className="max-w-full max-h-[70vh] rounded-md object-contain"
          />
        ) : cat === "video" ? (
          <video
            src={`/api/assets/file/${encodeURIComponent(asset.name)}`}
            controls
            className="max-w-full max-h-[70vh] rounded-md"
          />
        ) : (
          <div className="bg-navy-800 rounded-md p-8 text-center">
            <FileText className="h-16 w-16 text-slate-500 mx-auto mb-4" />
            <p className="text-slate-300">{asset.name}</p>
            <p className="text-xs text-slate-500 mt-1">
              {formatSize(asset.size)}
            </p>
          </div>
        )}
        <p className="text-center text-xs text-slate-500 mt-2">
          {asset.name}
        </p>
      </div>
    </div>
  );
}
