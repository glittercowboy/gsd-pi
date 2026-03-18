import { createCodePlugin } from '@streamdown/code'

/**
 * Shiki code highlighting plugin for Streamdown.
 *
 * Uses vitesse-dark for both light/dark slots — the app is dark-only.
 * Container styling (borders, bg, padding) is handled by component
 * overrides in ./components.tsx, not by Shiki.
 */
export const codePlugin = createCodePlugin({
  themes: ['vitesse-dark', 'vitesse-dark'],
})
