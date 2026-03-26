"use client"

import { useEffect, useMemo, useRef, useState, useCallback } from "react"
import { Loader2, Save, X } from "lucide-react"
import { cn } from "@/lib/utils"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { CodeEditor } from "@/components/gsd/code-editor"
import { useEditorFontSize } from "@/lib/use-editor-font-size"
import { useTheme } from "next-themes"

/* ── Language detection ── */

const EXT_TO_LANG: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "jsx",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  jsonc: "jsonc",
  md: "markdown",
  mdx: "mdx",
  css: "css",
  scss: "scss",
  less: "less",
  html: "html",
  htm: "html",
  xml: "xml",
  svg: "xml",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  fish: "fish",
  py: "python",
  rb: "ruby",
  rs: "rust",
  go: "go",
  java: "java",
  kt: "kotlin",
  swift: "swift",
  c: "c",
  cpp: "cpp",
  h: "c",
  hpp: "cpp",
  cs: "csharp",
  php: "php",
  sql: "sql",
  graphql: "graphql",
  gql: "graphql",
  dockerfile: "dockerfile",
  makefile: "makefile",
  lua: "lua",
  vim: "viml",
  r: "r",
  tex: "latex",
  diff: "diff",
  ini: "ini",
  conf: "ini",
  env: "dotenv",
}

const SPECIAL_FILENAMES: Record<string, string> = {
  Dockerfile: "dockerfile",
  Makefile: "makefile",
  Containerfile: "dockerfile",
  Justfile: "makefile",
  Rakefile: "ruby",
  Gemfile: "ruby",
  ".env": "dotenv",
  ".env.local": "dotenv",
  ".env.example": "dotenv",
  ".eslintrc": "json",
  ".prettierrc": "json",
  "tsconfig.json": "jsonc",
  "jsconfig.json": "jsonc",
}

function detectLanguage(filepath: string): string | null {
  const filename = filepath.split("/").pop() ?? ""

  // Check special filenames first
  if (SPECIAL_FILENAMES[filename]) return SPECIAL_FILENAMES[filename]

  const ext = filename.includes(".") ? filename.split(".").pop()?.toLowerCase() : null
  if (ext && EXT_TO_LANG[ext]) return EXT_TO_LANG[ext]

  return null
}

function isMarkdown(filepath: string): boolean {
  const ext = filepath.split(".").pop()?.toLowerCase()
  return ext === "md" || ext === "mdx"
}

/* ── Shiki singleton ── */

type ShikiHighlighter = {
  codeToHtml: (code: string, options: { lang: string; theme: string }) => string
}

let highlighterPromise: Promise<ShikiHighlighter> | null = null

async function getHighlighter(): Promise<ShikiHighlighter> {
  if (!highlighterPromise) {
    highlighterPromise = import("shiki").then((mod) =>
      mod.createHighlighter({
        themes: ["github-dark-default", "github-light-default"],
        langs: [
          "typescript", "tsx", "javascript", "jsx",
          "json", "jsonc", "markdown", "mdx",
          "css", "scss", "less", "html", "xml",
          "yaml", "toml", "bash", "python", "ruby",
          "rust", "go", "java", "kotlin", "swift",
          "c", "cpp", "csharp", "php", "sql",
          "graphql", "dockerfile", "makefile", "lua",
          "diff", "ini", "dotenv",
        ],
      }),
    ).catch((err) => {
      // Reset so the next call retries instead of returning a rejected promise forever
      highlighterPromise = null
      throw err
    })
  }
  return highlighterPromise
}

/* ── Code viewer (syntax highlighted) ── */

function CodeViewer({ content, filepath, shikiTheme = "github-dark-default" }: { content: string; filepath: string; shikiTheme?: string }) {
  const [html, setHtml] = useState<string | null>(null)
  const [ready, setReady] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  const lang = detectLanguage(filepath)

  useEffect(() => {
    let cancelled = false

    if (!lang) {
      const readyTimer = window.setTimeout(() => {
        setReady(true)
      }, 0)
      return () => window.clearTimeout(readyTimer)
    }

    getHighlighter().then((highlighter) => {
      if (cancelled) return
      try {
        const highlighted = highlighter.codeToHtml(content, {
          lang,
          theme: shikiTheme,
        })
        setHtml(highlighted)
      } catch {
        // Language not loaded or unsupported — fall back to plain
        setHtml(null)
      }
      setReady(true)
    }).catch(() => {
      if (!cancelled) setReady(true)
    })

    return () => { cancelled = true }
  }, [content, lang, shikiTheme])

  if (!ready) {
    return (
      <div className="flex items-center justify-center py-12 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin mr-2" />
        Highlighting…
      </div>
    )
  }

  if (html) {
    return (
      <div
        ref={containerRef}
        className="file-viewer-code overflow-x-auto text-sm leading-relaxed"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    )
  }

  // Fallback: plain text with line numbers
  return <PlainViewer content={content} />
}

/* ── Plain text viewer with line numbers ── */

function PlainViewer({ content }: { content: string }) {
  const lines = useMemo(() => content.split("\n"), [content])
  const gutterWidth = String(lines.length).length

  return (
    <div className="overflow-x-auto text-sm leading-relaxed font-mono">
      <table className="border-collapse">
        <tbody>
          {lines.map((line, i) => (
            <tr key={i} className="hover:bg-accent/20">
              <td
                className="select-none pr-4 text-right text-muted-foreground align-top"
                style={{ minWidth: `${gutterWidth + 1}ch` }}
              >
                {i + 1}
              </td>
              <td className="whitespace-pre text-muted-foreground">{line || " "}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/* ── Markdown viewer ── */

function MarkdownViewer({ content, filepath, shikiTheme = "github-dark-default" }: { content: string; filepath: string; shikiTheme?: string }) {
  const [rendered, setRendered] = useState<React.ReactNode | null>(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    let cancelled = false

    // Dynamic import to keep the main bundle lean
    Promise.all([
      import("react-markdown"),
      import("remark-gfm"),
      getHighlighter(),
    ]).then(([ReactMarkdownMod, remarkGfmMod, highlighter]) => {
      if (cancelled) return

      const ReactMarkdown = ReactMarkdownMod.default
      const remarkGfm = remarkGfmMod.default

      setRendered(
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            code({ className, children, ...props }) {
              const match = /language-(\w+)/.exec(className || "")
              const codeStr = String(children).replace(/\n$/, "")

              if (match) {
                try {
                  const highlighted = highlighter.codeToHtml(codeStr, {
                    lang: match[1],
                    theme: shikiTheme,
                  })
                  return (
                    <div
                      className="file-viewer-code my-3 rounded-md overflow-x-auto text-sm"
                      dangerouslySetInnerHTML={{ __html: highlighted }}
                    />
                  )
                } catch {
                  // Fall through to default rendering
                }
              }

              // Inline code or unknown language
              const isInline = !className && !String(children).includes("\n")
              if (isInline) {
                return (
                  <code className="rounded bg-muted px-1.5 py-0.5 text-sm font-mono" {...props}>
                    {children}
                  </code>
                )
              }

              return (
                <pre className="my-3 overflow-x-auto rounded-md bg-[#0d1117] p-4 text-sm">
                  <code>{children}</code>
                </pre>
              )
            },
            pre({ children }) {
              // Unwrap <pre> since code blocks handle their own wrapper
              return <>{children}</>
            },
            table({ children }) {
              return (
                <div className="my-4 overflow-x-auto">
                  <table className="min-w-full border-collapse border border-border text-sm">
                    {children}
                  </table>
                </div>
              )
            },
            th({ children }) {
              return (
                <th className="border border-border bg-muted/50 px-3 py-2 text-left font-medium">
                  {children}
                </th>
              )
            },
            td({ children }) {
              return (
                <td className="border border-border px-3 py-2">{children}</td>
              )
            },
            a({ href, children }) {
              return (
                <a href={href} className="text-info hover:underline" target="_blank" rel="noopener noreferrer">
                  {children}
                </a>
              )
            },
            img({ src, alt }) {
              return (
                <span className="my-2 block rounded border border-border bg-muted/50 px-3 py-2 text-xs text-muted-foreground italic">
                  🖼 {alt || (typeof src === "string" ? src : "") || "image"}
                </span>
              )
            },
          }}
        >
          {content}
        </ReactMarkdown>,
      )
      setReady(true)
    }).catch(() => {
      if (!cancelled) setReady(true)
    })

    return () => { cancelled = true }
  }, [content, filepath, shikiTheme])

  if (!ready) {
    return (
      <div className="flex items-center justify-center py-12 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin mr-2" />
        Rendering…
      </div>
    )
  }

  if (!rendered) {
    return <PlainViewer content={content} />
  }

  return <div className="markdown-body">{rendered}</div>
}

/* ── Inline diff viewer — shows before/after with red/green line highlights ── */

function computeDiffLines(before: string, after: string): Array<{ type: "add" | "remove" | "context"; lineNum: number | null; text: string }> {
  const oldLines = before.split("\n")
  const newLines = after.split("\n")
  const result: Array<{ type: "add" | "remove" | "context"; lineNum: number | null; text: string }> = []

  // Simple LCS-based diff for inline display
  const n = oldLines.length
  const m = newLines.length

  // For files that are too large, fall back to showing just additions/removals
  if (n + m > 5000) {
    oldLines.forEach((l, i) => result.push({ type: "remove", lineNum: i + 1, text: l }))
    newLines.forEach((l, i) => result.push({ type: "add", lineNum: i + 1, text: l }))
    return result
  }

  // Build edit script using O(ND) algorithm (simplified Myers)
  const max = n + m
  const v = new Int32Array(2 * max + 1)
  const trace: Int32Array[] = []

  outer:
  for (let d = 0; d <= max; d++) {
    const vCopy = new Int32Array(v)
    trace.push(vCopy)
    for (let k = -d; k <= d; k += 2) {
      let x: number
      if (k === -d || (k !== d && v[k - 1 + max] < v[k + 1 + max])) {
        x = v[k + 1 + max]
      } else {
        x = v[k - 1 + max] + 1
      }
      let y = x - k
      while (x < n && y < m && oldLines[x] === newLines[y]) {
        x++
        y++
      }
      v[k + max] = x
      if (x >= n && y >= m) break outer
    }
  }

  // Backtrack to produce diff
  type Edit = { type: "add" | "remove" | "context"; oldIdx: number; newIdx: number }
  const edits: Edit[] = []
  let x = n, y = m
  for (let d = trace.length - 1; d >= 0; d--) {
    const vPrev = trace[d]
    const k = x - y
    let prevK: number
    if (k === -d || (k !== d && vPrev[k - 1 + max] < vPrev[k + 1 + max])) {
      prevK = k + 1
    } else {
      prevK = k - 1
    }
    const prevX = vPrev[prevK + max]
    const prevY = prevX - prevK

    // Diag moves = context lines
    while (x > prevX && y > prevY) {
      x--; y--
      edits.push({ type: "context", oldIdx: x, newIdx: y })
    }
    if (d > 0) {
      if (x === prevX) {
        // Insert
        y--
        edits.push({ type: "add", oldIdx: x, newIdx: y })
      } else {
        // Delete
        x--
        edits.push({ type: "remove", oldIdx: x, newIdx: y })
      }
    }
  }

  edits.reverse()

  // Convert to output lines, showing only changed regions with ±3 lines of context
  const CONTEXT = 3
  const important = new Set<number>()
  edits.forEach((e, i) => {
    if (e.type !== "context") {
      for (let j = Math.max(0, i - CONTEXT); j <= Math.min(edits.length - 1, i + CONTEXT); j++) {
        important.add(j)
      }
    }
  })

  let lastIncluded = -1
  for (let i = 0; i < edits.length; i++) {
    if (!important.has(i)) continue
    if (lastIncluded >= 0 && i - lastIncluded > 1) {
      result.push({ type: "context", lineNum: null, text: "···" })
    }
    const e = edits[i]
    if (e.type === "context") {
      result.push({ type: "context", lineNum: e.newIdx + 1, text: newLines[e.newIdx] })
    } else if (e.type === "remove") {
      result.push({ type: "remove", lineNum: e.oldIdx + 1, text: oldLines[e.oldIdx] })
    } else {
      result.push({ type: "add", lineNum: e.newIdx + 1, text: newLines[e.newIdx] })
    }
    lastIncluded = i
  }

  return result
}

function InlineDiffViewer({ before, after, onDismiss }: { before: string; after: string; onDismiss?: () => void }) {
  const lines = useMemo(() => computeDiffLines(before, after), [before, after])

  return (
    <div className="flex-1 overflow-y-auto font-mono text-sm leading-relaxed">
      <table className="w-full border-collapse">
        <tbody>
          {lines.map((line, i) => (
            <tr
              key={i}
              className={cn(
                line.type === "add" && "bg-emerald-500/10",
                line.type === "remove" && "bg-red-500/10",
              )}
            >
              <td className="select-none w-[1ch] pl-2 pr-1 text-center align-top">
                {line.type === "add" ? (
                  <span className="text-emerald-400/80">+</span>
                ) : line.type === "remove" ? (
                  <span className="text-red-400/80">−</span>
                ) : null}
              </td>
              <td
                className={cn(
                  "select-none pr-3 text-right align-top min-w-[3ch]",
                  line.type === "add" ? "text-emerald-400/40" :
                  line.type === "remove" ? "text-red-400/40" :
                  "text-muted-foreground/50",
                )}
              >
                {line.lineNum ?? ""}
              </td>
              <td
                className={cn(
                  "whitespace-pre pr-4",
                  line.type === "add" && "text-emerald-300",
                  line.type === "remove" && "text-red-300 line-through decoration-red-400/30",
                  line.type === "context" && line.text === "···" && "text-muted-foreground/50 text-center italic",
                  line.type === "context" && line.text !== "···" && "text-muted-foreground",
                )}
              >
                {line.text || " "}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/* ── Read-only content renderer (shared between standalone and tab modes) ── */

function ReadOnlyContent({ content, filepath, fontSize, shikiTheme }: { content: string; filepath: string; fontSize?: number; shikiTheme?: string }) {
  return (
    <div style={fontSize ? { fontSize } : undefined}>
      {isMarkdown(filepath) ? (
        <MarkdownViewer content={content} filepath={filepath} shikiTheme={shikiTheme} />
      ) : (
        <CodeViewer content={content} filepath={filepath} shikiTheme={shikiTheme} />
      )}
    </div>
  )
}

/* ── Exported component ── */

interface FileContentViewerProps {
  content: string
  filepath: string
  className?: string
  /** Required for editing — the root context for the file */
  root?: "gsd" | "project"
  /** Required for editing — the relative path within the root */
  path?: string
  /** Required for editing — called with new content when the user saves */
  onSave?: (newContent: string) => Promise<void>
  /** When set, shows an inline diff overlay (before/after content) */
  diff?: { before: string; after: string }
  /** Called to dismiss the diff overlay */
  onDismissDiff?: () => void
  /** When true, MD files default to Edit tab so the raw changes are visible */
  agentOpened?: boolean
}

export function FileContentViewer({
  content,
  filepath,
  className,
  root,
  path,
  onSave,
  diff,
  onDismissDiff,
  agentOpened,
}: FileContentViewerProps) {
  const canEdit = root !== undefined && path !== undefined && onSave !== undefined

  // ── Dirty state tracking ──
  const [editContent, setEditContent] = useState(content)
  const [isSaving, setIsSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  // Reset edit content when the source content changes (e.g. after save + re-fetch)
  useEffect(() => {
    setEditContent(content)
  }, [content])

  const isDirty = editContent !== content

  const [fontSize] = useEditorFontSize()
  const { resolvedTheme } = useTheme()
  const shikiTheme = resolvedTheme === "light" ? "github-light-default" : "github-dark-default"
  const language = detectLanguage(filepath)

  const handleSave = useCallback(async () => {
    if (!onSave || !isDirty || isSaving) return
    setIsSaving(true)
    setSaveError(null)
    try {
      await onSave(editContent)
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Failed to save")
    } finally {
      setIsSaving(false)
    }
  }, [onSave, isDirty, isSaving, editContent])

  // ── Ctrl+S / Cmd+S keyboard shortcut ──
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault()
        handleSave()
      }
    }
    document.addEventListener("keydown", handler)
    return () => document.removeEventListener("keydown", handler)
  }, [handleSave])

  // ── Read-only mode (backward compatible) ──
  if (!canEdit) {
    return (
      <div className={cn("flex-1 overflow-y-auto p-4", className)} style={{ fontSize }}>
        <ReadOnlyContent content={content} filepath={filepath} fontSize={fontSize} shikiTheme={shikiTheme} />
      </div>
    )
  }

  // ── Diff overlay mode: agent just edited this file ──
  if (diff) {
    return (
      <div className={cn("flex flex-1 flex-col overflow-hidden min-h-0", className)}>
        <div className="flex items-center gap-2 border-b border-border px-4 h-9">
          <span className="text-sm font-medium font-mono truncate">{filepath}</span>
          <span className="ml-2 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-medium text-emerald-400 uppercase tracking-wide">
            Changed
          </span>
          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={onDismissDiff}
              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
            >
              <X className="h-3 w-3" />
              Dismiss
            </button>
          </div>
        </div>
        <InlineDiffViewer before={diff.before} after={diff.after} onDismiss={onDismissDiff} />
      </div>
    )
  }

  // ── Editable mode: markdown keeps View/Edit tabs ──
  if (isMarkdown(filepath)) {
    return (
      <Tabs key={agentOpened ? "agent-edit" : "normal"} defaultValue={agentOpened ? "edit" : "view"} className={cn("flex flex-1 flex-col overflow-hidden min-h-0", className)}>
        <div className="flex items-center gap-2 border-b border-border px-4 h-9">
          <span className="text-sm font-medium font-mono truncate mr-2">{filepath}</span>
          <TabsList className="h-7 bg-transparent p-0 ml-auto">
            <TabsTrigger
              value="view"
              className="h-6 rounded-md px-2 text-xs data-[state=active]:bg-muted"
            >
              View
            </TabsTrigger>
            <TabsTrigger
              value="edit"
              className="h-6 rounded-md px-2 text-xs data-[state=active]:bg-muted"
            >
              Edit
            </TabsTrigger>
          </TabsList>

          {/* Save button */}
          <div className="flex items-center gap-2">
            {saveError && (
              <span className="text-xs text-destructive max-w-[200px] truncate" title={saveError}>
                {saveError}
              </span>
            )}
            <button
              onClick={handleSave}
              disabled={!isDirty || isSaving}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                isDirty && !isSaving
                  ? "bg-foreground text-background hover:bg-foreground/90"
                  : "bg-muted text-muted-foreground cursor-not-allowed opacity-50",
              )}
            >
              {isSaving ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Save className="h-3 w-3" />
              )}
              Save
            </button>
          </div>
        </div>

        <TabsContent value="view" className="flex-1 overflow-y-auto p-4 mt-0" style={{ fontSize }}>
          <ReadOnlyContent content={content} filepath={filepath} fontSize={fontSize} shikiTheme={shikiTheme} />
        </TabsContent>

        <TabsContent value="edit" className="flex-1 overflow-hidden mt-0 min-h-0">
          <CodeEditor
            value={editContent}
            onChange={setEditContent}
            language={language}
            fontSize={fontSize}
            className="h-full border-0 rounded-none"
          />
        </TabsContent>
      </Tabs>
    )
  }

  // ── Editable mode: non-markdown gets single CodeEditor view ──
  return (
    <div className={cn("flex flex-1 flex-col overflow-hidden min-h-0", className)}>
      {/* Header bar with filepath and save button */}
      <div className="flex items-center gap-2 border-b border-border px-4 h-9">
        <span className="text-sm font-medium font-mono truncate">{filepath}</span>
        <div className="ml-auto flex items-center gap-2">
          {saveError && (
            <span className="text-xs text-destructive max-w-[200px] truncate" title={saveError}>
              {saveError}
            </span>
          )}
          <button
            onClick={handleSave}
            disabled={!isDirty || isSaving}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
              isDirty && !isSaving
                ? "bg-foreground text-background hover:bg-foreground/90"
                : "bg-muted text-muted-foreground cursor-not-allowed opacity-50",
            )}
          >
            {isSaving ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Save className="h-3 w-3" />
            )}
            Save
          </button>
        </div>
      </div>
      {/* CodeEditor fills remaining space */}
      <CodeEditor
        value={editContent}
        onChange={setEditContent}
        language={language}
        fontSize={fontSize}
        className="flex-1 min-h-0 border-0 rounded-none"
      />
    </div>
  )
}
