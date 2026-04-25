import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const cssPath = new URL('../src/renderer/src/styles/index.css', import.meta.url)

async function loadTokens() {
  // Node 22+ runs TypeScript modules via --experimental-strip-types. We import
  // the same module the production renderer imports so regressions in token
  // exports are caught by an import-time error rather than a string grep.
  const mod = await import('../src/renderer/src/lib/theme/tokens.ts')
  return mod
}

test('theme CSS declares every token exported by tokens.ts, values in sync', async () => {
  const css = await readFile(cssPath, 'utf8')
  const { colors, fonts, fontSizes } = await loadTokens()

  const escape = (s) => s.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')
  const kebab = (s) => s.replace(/([A-Z])/g, '-$1').toLowerCase()

  // Colors: every exported color becomes a --color-* custom property
  // (kebab-case of the JS camelCase key) with the declared hex/rgba value.
  for (const [key, expectedValue] of Object.entries(colors)) {
    const cssName = `--color-${kebab(key)}`
    const pattern = new RegExp(`${escape(cssName)}\\s*:\\s*${escape(String(expectedValue))}\\s*;`)
    assert.match(
      css,
      pattern,
      `CSS must declare ${cssName} with value ${expectedValue} exported by tokens.ts#colors.${key}`,
    )
  }

  // Fonts: --font-sans and --font-mono carry the exported font stacks.
  for (const [key, expectedValue] of Object.entries(fonts)) {
    const cssName = `--font-${key}`
    const pattern = new RegExp(`${escape(cssName)}\\s*:\\s*${escape(String(expectedValue))}\\s*;`)
    assert.match(
      css,
      pattern,
      `CSS must declare ${cssName} with the font stack exported by tokens.ts#fonts.${key}`,
    )
  }

  // Font sizes: --text-* maps from tokens.ts#fontSizes. `bodyLg` maps to
  // `body-lg` per the established CSS naming.
  const kebabSize = (k) =>
    k === 'bodyLg' ? 'body-lg' : k.replace(/([A-Z])/g, '-$1').toLowerCase()
  for (const [key, expectedValue] of Object.entries(fontSizes)) {
    const cssName = `--text-${kebabSize(key)}`
    const pattern = new RegExp(`${escape(cssName)}\\s*:\\s*${escape(String(expectedValue))}\\s*;`)
    assert.match(
      css,
      pattern,
      `CSS must declare ${cssName} with value ${expectedValue} exported by tokens.ts#fontSizes.${key}`,
    )
  }
})

test('every @font-face rule declares font-display: block (no FOIT during initial paint)', async () => {
  const css = await readFile(cssPath, 'utf8')

  // Walk the CSS, extracting each @font-face body by brace-balancing. CSS
  // @font-face rules do not nest, so a single-level depth counter is correct.
  const fontFaceBodies = []
  const fontFaceRe = /@font-face\s*\{/g
  let match
  while ((match = fontFaceRe.exec(css)) !== null) {
    const start = match.index + match[0].length
    let depth = 1
    let i = start
    for (; i < css.length && depth > 0; i++) {
      if (css[i] === '{') depth++
      else if (css[i] === '}') depth--
    }
    fontFaceBodies.push(css.slice(start, i - 1))
  }

  assert.ok(fontFaceBodies.length > 0, 'expected at least one @font-face rule to exist')

  for (const [idx, body] of fontFaceBodies.entries()) {
    assert.match(
      body,
      /font-display\s*:\s*block\s*;/,
      `@font-face rule #${idx + 1} must declare font-display: block ` +
        `to avoid FOIT (flash of invisible text) during initial paint`,
    )
  }
})
