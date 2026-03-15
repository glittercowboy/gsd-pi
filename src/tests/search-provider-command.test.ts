/**
 * Contract tests for /search-provider slash command.
 *
 * Covers:
 * - Direct arg application (tavily, brave, auto)
 * - Interactive select UI when no arg given
 * - Cancel (Esc) produces no side effects
 * - Invalid arg falls back to interactive select
 * - Tab completion returns filtered AutocompleteItem[]
 * - Notify message includes effective provider from resolveSearchProvider()
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// ─── Helpers (reused from provider.test.ts pattern) ────────────────────────

function withEnv(
  vars: Record<string, string | undefined>,
  fn: () => void,
): void {
  const originals: Record<string, string | undefined> = {}
  for (const key of Object.keys(vars)) {
    originals[key] = process.env[key]
    if (vars[key] === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = vars[key]
    }
  }
  try {
    fn()
  } finally {
    for (const key of Object.keys(originals)) {
      if (originals[key] === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = originals[key]
      }
    }
  }
}

function makeTmpAuth(data: Record<string, unknown> = {}): { authPath: string; cleanup: () => void } {
  const tmp = mkdtempSync(join(tmpdir(), 'gsd-cmd-test-'))
  const authPath = join(tmp, 'auth.json')
  writeFileSync(authPath, JSON.stringify(data))
  return { authPath, cleanup: () => rmSync(tmp, { recursive: true, force: true }) }
}

// ─── Mock command context ──────────────────────────────────────────────────

interface MockCtx {
  ui: {
    select: (title: string, options: string[]) => Promise<string | undefined>
    notify: (message: string, type?: string) => void
    selectCalls: Array<{ title: string; options: string[] }>
    notifyCalls: Array<{ message: string; type?: string }>
    selectReturn: string | undefined
  }
  cwd: string
}

function makeMockCtx(selectReturn?: string): MockCtx {
  const ctx: MockCtx = {
    ui: {
      selectCalls: [],
      notifyCalls: [],
      selectReturn,
      async select(title: string, options: string[]) {
        ctx.ui.selectCalls.push({ title, options })
        return ctx.ui.selectReturn
      },
      notify(message: string, type?: string) {
        ctx.ui.notifyCalls.push({ message, type })
      },
    },
    cwd: '/tmp',
  }
  return ctx
}

// ─── Import the command module ─────────────────────────────────────────────

// We need to test the handler and completions directly.
// Import the registration function, then extract the handler by registering
// against a mock ExtensionAPI.

interface CapturedCommand {
  name: string
  description?: string
  getArgumentCompletions?: (prefix: string) => any
  handler: (args: string, ctx: any) => Promise<void>
}

async function loadCommand(): Promise<CapturedCommand> {
  const { registerSearchProviderCommand } = await import(
    '../resources/extensions/search-the-web/command-search-provider.ts'
  )

  let captured: CapturedCommand | undefined
  const mockPi = {
    registerCommand(name: string, options: any) {
      captured = { name, ...options }
    },
  }

  registerSearchProviderCommand(mockPi as any)
  assert.ok(captured, 'registerSearchProviderCommand should register a command')
  assert.equal(captured!.name, 'search-provider')
  return captured!
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. Direct arg — tavily
// ═══════════════════════════════════════════════════════════════════════════

test('direct arg "tavily" sets preference and notifies', async () => {
  const { setSearchProviderPreference, getSearchProviderPreference } = await import(
    '../resources/extensions/search-the-web/provider.ts'
  )
  const cmd = await loadCommand()
  const { authPath, cleanup } = makeTmpAuth()

  try {
    await withEnv({ TAVILY_API_KEY: 'tvly-test', BRAVE_API_KEY: undefined }, async () => {
      // Pre-set to auto so we can verify the change
      setSearchProviderPreference('auto', authPath)

      const ctx = makeMockCtx()
      await cmd.handler('tavily', ctx)

      // No select UI shown
      assert.equal(ctx.ui.selectCalls.length, 0, 'should not show select UI for direct arg')

      // Notification sent
      assert.equal(ctx.ui.notifyCalls.length, 1, 'should notify once')
      assert.match(ctx.ui.notifyCalls[0].message, /Search provider set to tavily/)
      assert.match(ctx.ui.notifyCalls[0].message, /Effective provider: tavily/)
    })
  } finally {
    cleanup()
  }
})

// ═══════════════════════════════════════════════════════════════════════════
// 2. Direct arg — brave
// ═══════════════════════════════════════════════════════════════════════════

test('direct arg "brave" sets preference and notifies', async () => {
  const cmd = await loadCommand()
  const { authPath, cleanup } = makeTmpAuth()

  try {
    await withEnv({ TAVILY_API_KEY: undefined, BRAVE_API_KEY: 'BSA-test' }, async () => {
      const ctx = makeMockCtx()
      await cmd.handler('brave', ctx)

      assert.equal(ctx.ui.selectCalls.length, 0)
      assert.equal(ctx.ui.notifyCalls.length, 1)
      assert.match(ctx.ui.notifyCalls[0].message, /Search provider set to brave/)
      assert.match(ctx.ui.notifyCalls[0].message, /Effective provider: brave/)
    })
  } finally {
    cleanup()
  }
})

// ═══════════════════════════════════════════════════════════════════════════
// 3. Direct arg — auto
// ═══════════════════════════════════════════════════════════════════════════

test('direct arg "auto" sets preference and notifies', async () => {
  const cmd = await loadCommand()
  const { authPath, cleanup } = makeTmpAuth()

  try {
    await withEnv({ TAVILY_API_KEY: 'tvly-test', BRAVE_API_KEY: 'BSA-test' }, async () => {
      const ctx = makeMockCtx()
      await cmd.handler('auto', ctx)

      assert.equal(ctx.ui.selectCalls.length, 0)
      assert.equal(ctx.ui.notifyCalls.length, 1)
      assert.match(ctx.ui.notifyCalls[0].message, /Search provider set to auto/)
      // auto with both keys → tavily
      assert.match(ctx.ui.notifyCalls[0].message, /Effective provider: tavily/)
    })
  } finally {
    cleanup()
  }
})

// ═══════════════════════════════════════════════════════════════════════════
// 4. No arg — shows select UI, user picks one
// ═══════════════════════════════════════════════════════════════════════════

test('no arg shows select UI with 3 options, user picks brave', async () => {
  const cmd = await loadCommand()

  await withEnv({ TAVILY_API_KEY: 'tvly-test', BRAVE_API_KEY: 'BSA-test' }, async () => {
    const ctx = makeMockCtx('brave (key: ✓)')
    await cmd.handler('', ctx)

    // Select UI shown
    assert.equal(ctx.ui.selectCalls.length, 1, 'should show select UI')
    assert.equal(ctx.ui.selectCalls[0].options.length, 4)

    // Options show key status
    assert.match(ctx.ui.selectCalls[0].options[0], /tavily \(key: ✓\)/)
    assert.match(ctx.ui.selectCalls[0].options[1], /brave \(key: ✓\)/)
    assert.match(ctx.ui.selectCalls[0].options[2], /ollama \(key:/)
    assert.equal(ctx.ui.selectCalls[0].options[3], 'auto')

    // Title shows current preference
    assert.match(ctx.ui.selectCalls[0].title, /current:/)

    // Notification sent
    assert.equal(ctx.ui.notifyCalls.length, 1)
    assert.match(ctx.ui.notifyCalls[0].message, /Search provider set to brave/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 5. Cancel (select returns undefined) — no side effects
// ═══════════════════════════════════════════════════════════════════════════

test('cancel (select returns undefined) produces no side effects', async () => {
  const { getSearchProviderPreference, setSearchProviderPreference } = await import(
    '../resources/extensions/search-the-web/provider.ts'
  )
  const cmd = await loadCommand()
  const { authPath, cleanup } = makeTmpAuth()

  try {
    await withEnv({ TAVILY_API_KEY: 'tvly-test', BRAVE_API_KEY: undefined }, async () => {
      setSearchProviderPreference('tavily', authPath)

      // selectReturn = undefined simulates Esc
      const ctx = makeMockCtx(undefined)
      await cmd.handler('', ctx)

      // Select was called
      assert.equal(ctx.ui.selectCalls.length, 1)
      // No notification (no side effects)
      assert.equal(ctx.ui.notifyCalls.length, 0, 'cancel should produce no notification')
    })
  } finally {
    cleanup()
  }
})

// ═══════════════════════════════════════════════════════════════════════════
// 6. Invalid arg — falls back to interactive select
// ═══════════════════════════════════════════════════════════════════════════

test('invalid arg "google" falls back to interactive select', async () => {
  const cmd = await loadCommand()

  await withEnv({ TAVILY_API_KEY: 'tvly-test', BRAVE_API_KEY: undefined }, async () => {
    const ctx = makeMockCtx('tavily (key: ✓)')
    await cmd.handler('google', ctx)

    // Should show select UI because "google" is not valid
    assert.equal(ctx.ui.selectCalls.length, 1, 'invalid arg should fall back to select UI')
    assert.equal(ctx.ui.notifyCalls.length, 1)
    assert.match(ctx.ui.notifyCalls[0].message, /Search provider set to tavily/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 7. Tab completion — all 3 options when prefix is empty
// ═══════════════════════════════════════════════════════════════════════════

test('tab completion returns all 4 options when prefix is empty', async () => {
  const cmd = await loadCommand()

  withEnv({ TAVILY_API_KEY: 'tvly-test', BRAVE_API_KEY: 'BSA-test' }, () => {
    const items = cmd.getArgumentCompletions!('')
    assert.ok(items, 'completions should not be null')
    assert.equal(items!.length, 4)

    const values = items!.map((i: any) => i.value)
    assert.deepEqual(values, ['tavily', 'brave', 'ollama', 'auto'])

    // Each item has label and description
    for (const item of items!) {
      assert.ok(item.label, 'each item should have a label')
      assert.ok(item.description, 'each item should have a description')
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 8. Tab completion — filters by prefix
// ═══════════════════════════════════════════════════════════════════════════

test('tab completion filters by prefix: "t" returns only tavily', async () => {
  const cmd = await loadCommand()

  withEnv({ TAVILY_API_KEY: 'tvly-test', BRAVE_API_KEY: undefined }, () => {
    const items = cmd.getArgumentCompletions!('t')
    assert.ok(items)
    assert.equal(items!.length, 1)
    assert.equal(items![0].value, 'tavily')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 9. Notify message includes effective provider from resolveSearchProvider()
// ═══════════════════════════════════════════════════════════════════════════

test('notify message shows effective provider (fallback case)', async () => {
  const cmd = await loadCommand()

  // Set to brave but only tavily key exists → effective = tavily (fallback)
  await withEnv({ TAVILY_API_KEY: 'tvly-test', BRAVE_API_KEY: undefined }, async () => {
    const ctx = makeMockCtx()
    await cmd.handler('brave', ctx)

    assert.equal(ctx.ui.notifyCalls.length, 1)
    // Set to brave but effective is tavily (fallback)
    assert.match(ctx.ui.notifyCalls[0].message, /Search provider set to brave/)
    assert.match(ctx.ui.notifyCalls[0].message, /Effective provider: tavily/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 10. Notify message shows "none" when no keys available
// ═══════════════════════════════════════════════════════════════════════════

test('notify message shows "none" when no API keys available', async () => {
  const cmd = await loadCommand()

  await withEnv({ TAVILY_API_KEY: undefined, BRAVE_API_KEY: undefined }, async () => {
    const ctx = makeMockCtx()
    await cmd.handler('auto', ctx)

    assert.equal(ctx.ui.notifyCalls.length, 1)
    assert.match(ctx.ui.notifyCalls[0].message, /Effective provider: none/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 11. Select options show key unavailability (✗)
// ═══════════════════════════════════════════════════════════════════════════

test('select options show key unavailability with ✗', async () => {
  const cmd = await loadCommand()

  await withEnv({ TAVILY_API_KEY: undefined, BRAVE_API_KEY: undefined }, async () => {
    const ctx = makeMockCtx('auto')
    await cmd.handler('', ctx)

    assert.equal(ctx.ui.selectCalls.length, 1)
    assert.match(ctx.ui.selectCalls[0].options[0], /tavily \(key: ✗\)/)
    assert.match(ctx.ui.selectCalls[0].options[1], /brave \(key: ✗\)/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 12. Command registered with correct name
// ═══════════════════════════════════════════════════════════════════════════

test('command is registered as "search-provider"', async () => {
  const cmd = await loadCommand()
  assert.equal(cmd.name, 'search-provider')
  assert.ok(cmd.description, 'should have a description')
  assert.ok(cmd.getArgumentCompletions, 'should have tab completion')
  assert.ok(cmd.handler, 'should have a handler')
})
