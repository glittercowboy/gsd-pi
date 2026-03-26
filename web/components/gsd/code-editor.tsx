"use client"

import { useMemo } from "react"
import dynamic from "next/dynamic"
import { useTheme } from "next-themes"
import { Loader2 } from "lucide-react"
import { createTheme } from "@uiw/codemirror-themes"
import { tags as t } from "@lezer/highlight"
import { loadLanguage, type LanguageName } from "@uiw/codemirror-extensions-langs"
import { EditorView } from "@codemirror/view"
import { cn } from "@/lib/utils"

/* ── Dynamic import (no SSR — CodeMirror needs browser DOM) ── */

const ReactCodeMirror = dynamic(() => import("@uiw/react-codemirror"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full min-h-[120px] items-center justify-center">
      <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
    </div>
  ),
})

/* ── Syntax highlighting styles ── */

const darkStyles = [
  { tag: [t.comment, t.lineComment, t.blockComment], color: "#6a737d" },
  { tag: [t.keyword], color: "#ff7b72" },
  { tag: [t.operator], color: "#79c0ff" },
  { tag: [t.string, t.special(t.string)], color: "#a5d6ff" },
  { tag: [t.number, t.bool, t.null], color: "#79c0ff" },
  { tag: [t.variableName], color: "#c9d1d9" },
  { tag: [t.definition(t.variableName)], color: "#d2a8ff" },
  { tag: [t.function(t.variableName)], color: "#d2a8ff" },
  { tag: [t.typeName, t.className], color: "#ffa657" },
  { tag: [t.propertyName], color: "#79c0ff" },
  { tag: [t.definition(t.propertyName)], color: "#c9d1d9" },
  { tag: [t.bracket], color: "#8b949e" },
  { tag: [t.punctuation], color: "#8b949e" },
  { tag: [t.tagName], color: "#7ee787" },
  { tag: [t.attributeName], color: "#79c0ff" },
  { tag: [t.attributeValue], color: "#a5d6ff" },
  { tag: [t.regexp], color: "#7ee787" },
  { tag: [t.escape], color: "#79c0ff" },
  { tag: [t.meta], color: "#8b949e" },
]

const lightStyles = [
  { tag: [t.comment, t.lineComment, t.blockComment], color: "#6a737d" },
  { tag: [t.keyword], color: "#cf222e" },
  { tag: [t.operator], color: "#0550ae" },
  { tag: [t.string, t.special(t.string)], color: "#0a3069" },
  { tag: [t.number, t.bool, t.null], color: "#0550ae" },
  { tag: [t.variableName], color: "#24292f" },
  { tag: [t.definition(t.variableName)], color: "#8250df" },
  { tag: [t.function(t.variableName)], color: "#8250df" },
  { tag: [t.typeName, t.className], color: "#953800" },
  { tag: [t.propertyName], color: "#0550ae" },
  { tag: [t.definition(t.propertyName)], color: "#24292f" },
  { tag: [t.bracket], color: "#57606a" },
  { tag: [t.punctuation], color: "#57606a" },
  { tag: [t.tagName], color: "#116329" },
  { tag: [t.attributeName], color: "#0550ae" },
  { tag: [t.attributeValue], color: "#0a3069" },
  { tag: [t.regexp], color: "#116329" },
  { tag: [t.escape], color: "#0550ae" },
  { tag: [t.meta], color: "#57606a" },
]

/* ── Static theme objects (module-level, never recreated on render) ── */

const darkTheme = createTheme({
  theme: "dark",
  settings: {
    background: "oklch(0.09 0 0)",
    foreground: "oklch(0.9 0 0)",
    caret: "oklch(0.9 0 0)",
    selection: "oklch(0.2 0 0)",
    lineHighlight: "oklch(0.12 0 0)",
    gutterBackground: "oklch(0.09 0 0)",
    gutterForeground: "oklch(0.42 0 0)",
    gutterBorder: "transparent",
  },
  styles: darkStyles,
})

const lightTheme = createTheme({
  theme: "light",
  settings: {
    background: "oklch(0.98 0 0)",
    foreground: "oklch(0.15 0 0)",
    caret: "oklch(0.15 0 0)",
    selection: "oklch(0.9 0 0)",
    lineHighlight: "oklch(0.96 0 0)",
    gutterBackground: "oklch(0.98 0 0)",
    gutterForeground: "oklch(0.55 0 0)",
    gutterBorder: "transparent",
  },
  styles: lightStyles,
})

/* ── Language mapping (shiki lang names → CodeMirror loadLanguage names) ── */

const CM_LANG_MAP: Record<string, LanguageName | null> = {
  // TypeScript / JavaScript family
  typescript: "ts",
  tsx: "tsx",
  javascript: "js",
  jsx: "jsx",
  // Shell variants
  bash: "bash",
  sh: "sh",
  zsh: "sh",
  // Data formats
  json: "json",
  jsonc: "json",
  yaml: "yaml",
  toml: "toml",
  // Markup
  markdown: "markdown",
  mdx: "markdown", // CM has no mdx — use markdown
  html: "html",
  xml: "xml",
  // Styles
  css: "css",
  scss: "scss",
  less: "less",
  // Systems
  python: "py",
  ruby: "rb",
  rust: "rs",
  go: "go",
  java: "java",
  kotlin: "kt",
  swift: "swift",
  c: "c",
  cpp: "cpp",
  csharp: "cs",
  // Other
  php: "php",
  sql: "sql",
  graphql: null, // CM has no graphql support
  dockerfile: null, // CM has no dockerfile support
  makefile: null, // CM has no makefile support
  lua: "lua",
  r: "r",
  latex: "tex",
  diff: "diff",
  // No CM equivalent → plain text
  viml: null,
  dotenv: null,
  fish: null,
  ini: "ini",
}

/* ── Component ── */

interface CodeEditorProps {
  value: string
  onChange: (value: string) => void
  language: string | null
  fontSize: number
  className?: string
}

export function CodeEditor({
  value,
  onChange,
  language,
  fontSize,
  className,
}: CodeEditorProps) {
  const { resolvedTheme } = useTheme()
  const theme = resolvedTheme !== "light" ? darkTheme : lightTheme

  // Resolve and cache language extension
  const langExtension = useMemo(() => {
    if (!language) return null
    const cmName = CM_LANG_MAP[language]
    if (cmName === undefined || cmName === null) return null
    return loadLanguage(cmName)
  }, [language])

  // Font size extension
  const fontSizeExt = useMemo(
    () =>
      EditorView.theme({
        "&": { fontSize: `${fontSize}px` },
        ".cm-gutters": { fontSize: `${fontSize}px` },
      }),
    [fontSize],
  )

  // Combined extensions (memoized to avoid re-initialization)
  const extensions = useMemo(() => {
    const exts = [fontSizeExt]
    if (langExtension) exts.push(langExtension)
    return exts
  }, [fontSizeExt, langExtension])

  return (
    <ReactCodeMirror
      value={value}
      onChange={onChange}
      theme={theme}
      extensions={extensions}
      height="100%"
      basicSetup={{
        lineNumbers: true,
        highlightActiveLine: true,
        highlightActiveLineGutter: true,
        foldGutter: true,
        bracketMatching: true,
        closeBrackets: true,
        autocompletion: false,
        tabSize: 2,
      }}
      className={cn("overflow-hidden rounded-md border", className)}
    />
  )
}
