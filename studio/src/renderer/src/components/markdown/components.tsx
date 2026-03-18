import type { ComponentPropsWithoutRef } from 'react'
import type { Components, ExtraProps } from 'streamdown'

/**
 * Custom Streamdown component overrides styled for the dark amber design system.
 *
 * These replace the default markdown element rendering with components that
 * use the app's Tailwind theme tokens (text-primary, accent, bg-tertiary, etc).
 */

type P<T extends keyof React.JSX.IntrinsicElements> = ComponentPropsWithoutRef<T> & ExtraProps

export const components: Components = {
  // ---------------------------------------------------------------------------
  // Headings — proper size hierarchy, semibold for h1/h2, medium for h3+
  // ---------------------------------------------------------------------------

  h1: ({ node, ...props }: P<'h1'>) => (
    <h1
      className="mb-4 text-[1.75rem] font-semibold leading-tight text-text-primary first:mt-0 [text-wrap:balance]"
      {...props}
    />
  ),

  h2: ({ node, ...props }: P<'h2'>) => (
    <h2
      className="mb-3 mt-6 text-[1.375rem] font-semibold leading-snug text-text-primary first:mt-0 [text-wrap:balance]"
      {...props}
    />
  ),

  h3: ({ node, ...props }: P<'h3'>) => (
    <h3
      className="mb-2 mt-5 text-[1.125rem] font-medium leading-snug text-text-primary first:mt-0 [text-wrap:balance]"
      {...props}
    />
  ),

  h4: ({ node, ...props }: P<'h4'>) => (
    <h4
      className="mb-2 mt-4 text-[1rem] font-medium leading-snug text-text-primary first:mt-0"
      {...props}
    />
  ),

  h5: ({ node, ...props }: P<'h5'>) => (
    <h5
      className="mb-2 mt-4 text-[1rem] font-medium leading-snug text-text-secondary first:mt-0"
      {...props}
    />
  ),

  h6: ({ node, ...props }: P<'h6'>) => (
    <h6
      className="mb-2 mt-4 text-[1rem] font-medium leading-snug text-text-tertiary first:mt-0"
      {...props}
    />
  ),

  // ---------------------------------------------------------------------------
  // Paragraph
  // ---------------------------------------------------------------------------

  p: ({ node, ...props }: P<'p'>) => (
    <p
      className="mb-4 text-[15px] leading-7 text-text-primary last:mb-0 [text-wrap:pretty]"
      {...props}
    />
  ),

  // ---------------------------------------------------------------------------
  // Inline code — distinct from code blocks: smaller, amber-tinted bg
  // ---------------------------------------------------------------------------

  inlineCode: ({ node, ...props }: P<'code'>) => (
    <code
      className="rounded bg-bg-tertiary px-1.5 py-0.5 font-mono text-[13px] text-accent"
      {...props}
    />
  ),

  // ---------------------------------------------------------------------------
  // Code blocks (pre) — dark container with subtle inset shadow
  // Shiki handles syntax coloring on inner elements via the code plugin.
  // ---------------------------------------------------------------------------

  pre: ({ node, ...props }: P<'pre'>) => (
    <pre
      className="my-4 overflow-x-auto rounded-[10px] border border-border bg-[#0c0c0c] p-4 shadow-[inset_0_1px_2px_rgba(0,0,0,0.3)]"
      {...props}
    />
  ),

  // ---------------------------------------------------------------------------
  // Tables — styled with borders, padding, subtle header bg
  // ---------------------------------------------------------------------------

  table: ({ node, ...props }: P<'table'>) => (
    <div className="my-4 overflow-x-auto">
      <table className="w-full text-[14px]" {...props} />
    </div>
  ),

  thead: ({ node, ...props }: P<'thead'>) => (
    <thead {...props} />
  ),

  tbody: ({ node, ...props }: P<'tbody'>) => (
    <tbody {...props} />
  ),

  tr: ({ node, ...props }: P<'tr'>) => (
    <tr {...props} />
  ),

  th: ({ node, ...props }: P<'th'>) => (
    <th
      className="border-b border-border bg-bg-secondary/50 px-4 py-2.5 text-left font-medium text-text-secondary"
      {...props}
    />
  ),

  td: ({ node, ...props }: P<'td'>) => (
    <td
      className="border-b border-border/50 px-4 py-2.5 text-text-primary"
      {...props}
    />
  ),

  // ---------------------------------------------------------------------------
  // Blockquote — accent-colored left border, muted italic text
  // ---------------------------------------------------------------------------

  blockquote: ({ node, ...props }: P<'blockquote'>) => (
    <blockquote
      className="my-4 border-l-2 border-accent/40 pl-4 italic text-text-secondary"
      {...props}
    />
  ),

  // ---------------------------------------------------------------------------
  // Lists
  // ---------------------------------------------------------------------------

  ul: ({ node, ...props }: P<'ul'>) => (
    <ul className="my-3 list-disc space-y-1 pl-6" {...props} />
  ),

  ol: ({ node, ...props }: P<'ol'>) => (
    <ol className="my-3 list-decimal space-y-1 pl-6" {...props} />
  ),

  li: ({ node, ...props }: P<'li'>) => (
    <li className="text-[15px] leading-7 text-text-primary" {...props} />
  ),

  // ---------------------------------------------------------------------------
  // Links — accent colored with hover underline
  // ---------------------------------------------------------------------------

  a: ({ node, ...props }: P<'a'>) => (
    <a
      className="text-accent underline-offset-2 transition-colors hover:text-accent-hover hover:underline"
      {...props}
    />
  ),

  // ---------------------------------------------------------------------------
  // Horizontal rule
  // ---------------------------------------------------------------------------

  hr: ({ node, ...props }: P<'hr'>) => (
    <hr className="my-8 border-border" {...props} />
  ),

  // ---------------------------------------------------------------------------
  // Inline formatting
  // ---------------------------------------------------------------------------

  strong: ({ node, ...props }: P<'strong'>) => (
    <strong className="font-semibold text-text-primary" {...props} />
  ),

  em: ({ node, ...props }: P<'em'>) => (
    <em className="italic" {...props} />
  ),
}
