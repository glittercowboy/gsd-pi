/**
 * FileEditor — CodeMirror 6 editor wrapper for Code Explorer.
 * Mounts EditorView once, recreates when filePath changes.
 * Supports syntax highlighting for ts/tsx/js/jsx/json/md/css/py.
 */
import { useEffect, useRef } from "react";
import { EditorView, keymap } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { basicSetup } from "@codemirror/basic-setup";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { css } from "@codemirror/lang-css";
import { python } from "@codemirror/lang-python";
import { oneDark } from "@codemirror/theme-one-dark";

interface FileEditorProps {
  content: string;
  filePath: string;
  onChange: (content: string) => void;
  onSave: () => void;
}

function getLanguageExtension(filename: string) {
  const ext = filename.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "ts": return javascript({ typescript: true });
    case "tsx": return javascript({ typescript: true, jsx: true });
    case "js": return javascript();
    case "jsx": return javascript({ jsx: true });
    case "json": return json();
    case "md": return markdown();
    case "css": return css();
    case "py": return python();
    default: return [];
  }
}

export function FileEditor({ content, filePath, onChange, onSave }: FileEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    // Destroy any existing view
    if (viewRef.current) {
      viewRef.current.destroy();
      viewRef.current = null;
    }

    const langExt = getLanguageExtension(filePath);

    const state = EditorState.create({
      doc: content,
      extensions: [
        basicSetup,
        oneDark,
        ...(Array.isArray(langExt) ? langExt : [langExt]),
        keymap.of([
          {
            key: "Mod-s",
            run: () => {
              onSave();
              return true;
            },
          },
        ]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            onChange(update.state.doc.toString());
          }
        }),
        EditorView.theme({
          "&": { height: "100%" },
          ".cm-scroller": { overflow: "auto" },
        }),
      ],
    });

    const view = new EditorView({
      state,
      parent: containerRef.current,
    });

    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filePath]);

  // Update content if it changes externally (e.g., file reloaded)
  useEffect(() => {
    if (!viewRef.current) return;
    const currentDoc = viewRef.current.state.doc.toString();
    if (currentDoc !== content) {
      viewRef.current.dispatch({
        changes: { from: 0, to: currentDoc.length, insert: content },
      });
    }
  // Only run when content prop changes, not on every keystroke
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filePath]);

  return (
    <div
      ref={containerRef}
      className="h-full overflow-auto"
      style={{ fontFamily: "JetBrains Mono, monospace", fontSize: "13px" }}
    />
  );
}
