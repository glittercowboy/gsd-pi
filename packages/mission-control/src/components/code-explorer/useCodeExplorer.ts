import { useState, useCallback } from "react";

const LAST_FILE_KEY = "gsd-mc-code-explorer-last-file";

export interface UseCodeExplorerReturn {
  isOpen: boolean;
  openExplorer: () => void;
  closeExplorer: () => void;
  selectedFile: string | null;
  selectFile: (path: string) => void;
  lastFile: string | null;
}

export function useCodeExplorer(): UseCodeExplorerReturn {
  const [isOpen, setIsOpen] = useState(false);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);

  // Restore last file from localStorage
  const [lastFile] = useState<string | null>(() => {
    try { return localStorage.getItem(LAST_FILE_KEY); } catch { return null; }
  });

  const openExplorer = useCallback(() => {
    setIsOpen(true);
    // If no file selected, restore last file
    if (!selectedFile && lastFile) {
      setSelectedFile(lastFile);
    }
  }, [selectedFile, lastFile]);

  const closeExplorer = useCallback(() => {
    setIsOpen(false);
  }, []);

  const selectFile = useCallback((path: string) => {
    setSelectedFile(path);
    try { localStorage.setItem(LAST_FILE_KEY, path); } catch {}
  }, []);

  return { isOpen, openExplorer, closeExplorer, selectedFile, selectFile, lastFile };
}
