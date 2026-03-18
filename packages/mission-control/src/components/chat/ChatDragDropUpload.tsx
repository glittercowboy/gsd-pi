/**
 * ChatDragDropUpload — wrapper that adds drag-drop file upload to chat panel.
 *
 * On drop, uploads each file to /api/assets/upload and calls onAssetUploaded
 * with the returned metadata. Shows translucent overlay during drag.
 */
import { useState, useCallback } from "react";
import type { AssetItem } from "@/hooks/useAssets";

interface ChatDragDropUploadProps {
  onAssetUploaded: (asset: AssetItem) => void;
  apiBase?: string;
  children: React.ReactNode;
}

export function ChatDragDropUpload({
  onAssetUploaded,
  apiBase = "http://127.0.0.1:4200",
  children,
}: ChatDragDropUploadProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [dragCounter, setDragCounter] = useState(0);

  const handleDragEnter = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setDragCounter((c) => c + 1);
      if (e.dataTransfer.types.includes("Files")) {
        setIsDragging(true);
      }
    },
    [],
  );

  const handleDragLeave = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setDragCounter((c) => {
        const next = c - 1;
        if (next <= 0) setIsDragging(false);
        return Math.max(0, next);
      });
    },
    [],
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragging(false);
      setDragCounter(0);

      const files = Array.from(e.dataTransfer.files);
      for (const file of files) {
        try {
          const formData = new FormData();
          formData.append("file", file);
          const res = await fetch(`${apiBase}/api/assets/upload`, {
            method: "POST",
            body: formData,
          });
          if (!res.ok) continue;
          const asset: AssetItem = await res.json();
          onAssetUploaded(asset);
        } catch {
          // silently skip failed uploads
        }
      }
    },
    [apiBase, onAssetUploaded],
  );

  return (
    <div
      className="relative h-full"
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {children}
      {isDragging && (
        <div className="absolute inset-0 z-50 flex items-center justify-center rounded-md border-2 border-dashed border-cyan-accent bg-cyan-accent/10">
          <p className="text-cyan-accent font-mono text-sm">
            Drop file to attach
          </p>
        </div>
      )}
    </div>
  );
}
