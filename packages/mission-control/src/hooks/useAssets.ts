/**
 * useAssets — hook for listing, uploading, deleting project assets.
 *
 * Manages filter and view mode state for the assets gallery.
 * All mutations reload the asset list after completion.
 */
import { useState, useEffect, useCallback, useMemo } from "react";

export interface AssetItem {
  name: string;
  path: string;
  type: string;
  size: number;
  createdAt: number;
  category?: string;
}

export type AssetFilter = string;
export type AssetViewMode = "grid" | "list";

const IMAGE_EXTS = ["png", "jpg", "jpeg", "gif", "svg", "webp"];
const VIDEO_EXTS = ["mp4", "webm", "mov"];
const DOC_EXTS = ["pdf", "md", "txt", "doc", "docx"];

function getAssetCategory(name: string): "images" | "video" | "documents" | "other" {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (IMAGE_EXTS.includes(ext)) return "images";
  if (VIDEO_EXTS.includes(ext)) return "video";
  if (DOC_EXTS.includes(ext)) return "documents";
  return "other";
}

export interface UseAssetsResult {
  assets: AssetItem[];
  filteredAssets: AssetItem[];
  loading: boolean;
  error: string | null;
  upload: (file: File, category?: string) => Promise<AssetItem>;
  remove: (name: string) => Promise<void>;
  reload: () => Promise<void>;
  filter: AssetFilter;
  setFilter: (f: AssetFilter) => void;
  viewMode: AssetViewMode;
  setViewMode: (m: AssetViewMode) => void;
  categories: string[];
}

export function useAssets(apiBase = "http://127.0.0.1:4200"): UseAssetsResult {
  const [assets, setAssets] = useState<AssetItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<AssetFilter>("all");
  const [viewMode, setViewMode] = useState<AssetViewMode>("grid");
  const [categories, setCategories] = useState<string[]>([]);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [listRes, catsRes] = await Promise.all([
        fetch(`${apiBase}/api/assets/list`),
        fetch(`${apiBase}/api/assets/categories`),
      ]);
      if (!listRes.ok) throw new Error(`Assets fetch failed: ${listRes.status}`);
      const data: AssetItem[] = await listRes.json();
      setAssets(data);
      if (catsRes.ok) {
        const cats: string[] = await catsRes.json();
        setCategories(cats);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, [apiBase]);

  useEffect(() => {
    reload();
  }, [reload]);

  const upload = useCallback(
    async (file: File, category?: string): Promise<AssetItem> => {
      setError(null);
      const formData = new FormData();
      formData.append("file", file);
      formData.append("category", category ?? "Uncategorized");
      const res = await fetch(`${apiBase}/api/assets/upload`, {
        method: "POST",
        body: formData,
      });
      if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
      const item: AssetItem = await res.json();
      await reload();
      return item;
    },
    [apiBase, reload],
  );

  const remove = useCallback(
    async (name: string): Promise<void> => {
      setError(null);
      const res = await fetch(`${apiBase}/api/assets/${encodeURIComponent(name)}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error(`Delete failed: ${res.status}`);
      await reload();
    },
    [apiBase, reload],
  );

  const filteredAssets = useMemo(() => {
    if (filter === "all") return assets;
    if (["images", "video", "documents"].includes(filter)) {
      return assets.filter((a) => getAssetCategory(a.name) === filter);
    }
    // Custom category filter
    return assets.filter((a) => (a.category ?? "Uncategorized") === filter);
  }, [assets, filter]);

  return {
    assets,
    filteredAssets,
    loading,
    error,
    upload,
    remove,
    reload,
    filter,
    setFilter,
    viewMode,
    setViewMode,
    categories,
  };
}
