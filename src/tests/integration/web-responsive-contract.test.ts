/**
 * Behavioural responsive-layout contract for the packaged web host.
 *
 * Replaces the source-grep `web-responsive.test.ts` (deleted in #4890).
 * Each assertion drives the rendered DOM at a real viewport via
 * Playwright — renaming a Tailwind utility but keeping the rendered
 * outcome unchanged passes; deleting `flex md:hidden` from the
 * hamburger button (or removing the testid) fails. Goodhart-proof.
 *
 * Refs: #4888, #4810
 *
 * The test uses the existing web-mode-runtime-harness to launch the
 * packaged host once, then iterates breakpoints in a single browser
 * to keep total runtime acceptable for `test:integration`.
 */

import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"

import type { Browser, BrowserContext, Page } from "playwright"
import { chromium } from "playwright"

import {
  killProcessOnPort,
  launchPackagedWebHost,
  type RuntimeLaunchResult,
} from "./web-mode-runtime-harness.ts"

const repoRoot = process.cwd()

// ─── viewport breakpoints ────────────────────────────────────────────────
//
// Tailwind defaults: sm=640, md=768, lg=1024, xl=1280, 2xl=1536. We pick
// representative sizes inside each band and assert layout differs in the
// ways `app-shell.tsx` claims (mobile-only chrome, desktop-only chrome).

const MOBILE = { width: 375, height: 800 } // sm-band
const TABLET = { width: 900, height: 800 } // md-band (>= md, < lg)
const DESKTOP = { width: 1440, height: 900 } // xl-band

// ─── helpers ─────────────────────────────────────────────────────────────

async function gotoPackagedHost(page: Page, launch: RuntimeLaunchResult): Promise<void> {
  // The launcher hands an auth token via the fragment so the client
  // bootstrap can read it. Without it the shell renders the
  // "Authentication Required" branch — which is itself responsive but
  // is not what these tests cover.
  const target = launch.authToken ? `${launch.url}/#token=${launch.authToken}` : launch.url

  // Capture browser console + page errors so a failed selector wait
  // can surface why the shell didn't mount instead of just timing out.
  const consoleEntries: string[] = []
  page.on("console", (msg) => {
    consoleEntries.push(`[${msg.type()}] ${msg.text()}`)
  })
  const pageErrors: string[] = []
  page.on("pageerror", (err) => {
    pageErrors.push(err.stack ?? err.message)
  })

  // `load` (not `domcontentloaded`) — the shell is loaded via
  // `next/dynamic({ ssr: false })` so the lazy chunk fetch happens
  // after the initial HTML; `load` waits for those chunks.
  await page.goto(target, { waitUntil: "load", timeout: 30_000 })

  // Wait for the lazy-loaded shell to mount. The header testid
  // `mobile-nav-toggle` exists in the DOM (visible or not) at every
  // viewport once the shell has hydrated. AppShell's only early-exit
  // is the `bootStatus === "unauthenticated"` branch (no testid) —
  // hitting it means the auth token from the URL fragment didn't
  // reach `/api/boot`.
  try {
    await page.waitForSelector('[data-testid="mobile-nav-toggle"]', {
      state: "attached",
      timeout: 30_000,
    })
  } catch (error) {
    // Diagnostic dump — without this, all we see in CI is a generic
    // selector timeout. Surfaces (a) which top-level state the shell
    // settled in, (b) any console errors, (c) a slice of body HTML.
    const diag = await page.evaluate(() => {
      const body = document.body
      return {
        url: window.location.href,
        hash: window.location.hash,
        hasOnboardingGate: Boolean(document.querySelector('[data-testid="onboarding-gate"]')),
        hasAuthRequiredHeading: Array.from(document.querySelectorAll("h1")).some(
          (h) => h.textContent?.includes("Authentication Required"),
        ),
        bodyHtml: body ? body.innerHTML.slice(0, 2_000) : "<no body>",
      }
    })
    throw new Error(
      `mobile-nav-toggle never attached. url=${diag.url} hash=${JSON.stringify(diag.hash)} ` +
        `onboardingGate=${diag.hasOnboardingGate} authRequired=${diag.hasAuthRequiredHeading}\n` +
        `body[0..2000]:\n${diag.bodyHtml}\n` +
        `pageErrors:\n${pageErrors.join("\n") || "(none)"}\n` +
        `console:\n${consoleEntries.slice(-50).join("\n") || "(none)"}\n` +
        `original: ${(error as Error).message}`,
    )
  }
}

async function setViewport(page: Page, vp: { width: number; height: number }): Promise<void> {
  await page.setViewportSize(vp)
  // Allow Tailwind's media-query-driven className flips to settle.
  await delay(50)
}

// ─── single-fixture suite ────────────────────────────────────────────────
//
// One subprocess host + one chromium instance shared across all the
// breakpoint assertions. The harness sanitises the runtime env per
// launch, and the locked-onboarding state is fine for these tests
// because the AppShell renders alongside the OnboardingGate (the gate
// is a sibling overlay, not a wrapping conditional).

test("responsive contract: web host honours viewport-driven chrome", async (t) => {
  const tempRoot = mkdtempSync(join(tmpdir(), "gsd-web-responsive-contract-"))
  const tempHome = join(tempRoot, "home")
  let port: number | null = null
  let browser: Browser | null = null
  let context: BrowserContext | null = null

  t.after(async () => {
    if (context) await context.close().catch(() => {})
    if (browser) await browser.close().catch(() => {})
    if (port !== null) await killProcessOnPort(port)
    try {
      rmSync(tempRoot, { recursive: true, force: true })
    } catch {
      // best-effort
    }
  })

  // 1. Boot the packaged host. The harness invokes `npm run build:pi`
  //    and `npm run build:web-host` if their artifacts are missing —
  //    so this works on a fresh checkout but only pays the build cost
  //    once per CI run.
  const launch = await launchPackagedWebHost({
    launchCwd: repoRoot,
    tempHome,
    env: {
      GSD_WEB_TEST_FAKE_API_KEY_VALIDATION: "1",
      GSD_WEB_TEST_DISABLE_EXTERNAL_CLI: "1",
    },
  })
  port = launch.port
  assert.equal(launch.exitCode, 0, `launcher must exit cleanly:\n${launch.stderr}`)

  // 2. Try to launch a real chromium. If the browser isn't installed
  //    (some minimal CI images), record that explicitly — never silently
  //    skip. Ship `npx playwright install chromium` as a separate task
  //    if this appears on a runner; do not paper over it here.
  try {
    browser = await chromium.launch({ headless: true })
  } catch (error) {
    throw new Error(
      `Playwright chromium failed to launch — install browsers via 'npx playwright install chromium'. Underlying error: ${(error as Error).message}`,
    )
  }
  context = await browser.newContext({ viewport: MOBILE })
  const page = await context.newPage()

  await gotoPackagedHost(page, launch)

  // ───────────────────────────────────────────────────────────────────
  // 3. Mobile (≤767px): hamburger visible, bottom bar visible, drawer
  //    interaction wires up, milestone toggle present.
  // ───────────────────────────────────────────────────────────────────
  await setViewport(page, MOBILE)

  await assert.doesNotReject(
    page.locator('[data-testid="mobile-nav-toggle"]').waitFor({ state: "visible", timeout: 5_000 }),
    "mobile-nav-toggle must be visible at mobile viewport",
  )
  await assert.doesNotReject(
    page.locator('[data-testid="mobile-bottom-bar"]').waitFor({ state: "visible", timeout: 5_000 }),
    "mobile-bottom-bar must be visible at mobile viewport",
  )

  // Drawer toggle: closed → open → overlay-dismiss → closed.
  // The drawer element is mounted regardless (it's a transform-based
  // off-screen panel), so we assert on its className transition rather
  // than visibility-or-attached.
  await page.locator('[data-testid="mobile-nav-toggle"]').click()
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="mobile-nav-drawer"]') as HTMLElement | null
      return Boolean(el) && /translate-x-0/.test(el!.className)
    },
    null,
    { timeout: 5_000 },
  )
  // Overlay click closes the drawer.
  await page.locator('[data-testid="mobile-nav-overlay"]').click()
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="mobile-nav-drawer"]') as HTMLElement | null
      return Boolean(el) && /-translate-x-full/.test(el!.className)
    },
    null,
    { timeout: 5_000 },
  )

  // Milestone drawer parallels the nav drawer.
  await assert.doesNotReject(
    page.locator('[data-testid="mobile-milestone-toggle"]').waitFor({ state: "visible", timeout: 5_000 }),
    "mobile-milestone-toggle must be visible at mobile viewport",
  )

  // Touch-target minimum: hamburger button must be ≥ 40px square so
  // the WCAG-recommended 44×44 hit area can be reached without scaling
  // (Tailwind's h-10 w-10 = 40px; we accept that as the floor).
  const toggleBox = await page.locator('[data-testid="mobile-nav-toggle"]').boundingBox()
  assert.ok(toggleBox, "mobile-nav-toggle must have a bounding box")
  assert.ok(
    toggleBox!.height >= 40 && toggleBox!.width >= 40,
    `mobile-nav-toggle must meet the 40px touch-target floor, got ${JSON.stringify(toggleBox)}`,
  )

  // The branch / project-cwd label uses `hidden sm:inline` — at 375px
  // it should be hidden (display: none).
  const cwdDisplay = await page
    .locator('[data-testid="workspace-project-cwd"]')
    .first()
    .evaluate((el) => window.getComputedStyle(el).display)
  assert.equal(cwdDisplay, "none", `workspace-project-cwd must be hidden on mobile, got display=${cwdDisplay}`)

  // ───────────────────────────────────────────────────────────────────
  // 4. Desktop (≥1024px): hamburger and bottom bar hidden; cwd visible.
  // ───────────────────────────────────────────────────────────────────
  await setViewport(page, DESKTOP)

  const navToggleDisplay = await page
    .locator('[data-testid="mobile-nav-toggle"]')
    .evaluate((el) => window.getComputedStyle(el).display)
  assert.equal(
    navToggleDisplay,
    "none",
    `mobile-nav-toggle must be hidden on desktop, got display=${navToggleDisplay}`,
  )
  const bottomBarDisplay = await page
    .locator('[data-testid="mobile-bottom-bar"]')
    .evaluate((el) => window.getComputedStyle(el).display)
  assert.equal(
    bottomBarDisplay,
    "none",
    `mobile-bottom-bar must be hidden on desktop, got display=${bottomBarDisplay}`,
  )

  const desktopCwdDisplay = await page
    .locator('[data-testid="workspace-project-cwd"]')
    .first()
    .evaluate((el) => window.getComputedStyle(el).display)
  assert.notEqual(
    desktopCwdDisplay,
    "none",
    "workspace-project-cwd must be visible on desktop",
  )

  // ───────────────────────────────────────────────────────────────────
  // 5. Tablet (768–1023px, the md band): mobile chrome already gone,
  //    desktop chrome already in. Asserts the breakpoint cutover lands
  //    at md, not at lg.
  // ───────────────────────────────────────────────────────────────────
  await setViewport(page, TABLET)

  const tabletNavToggleDisplay = await page
    .locator('[data-testid="mobile-nav-toggle"]')
    .evaluate((el) => window.getComputedStyle(el).display)
  assert.equal(
    tabletNavToggleDisplay,
    "none",
    `mobile-nav-toggle must hide at the md breakpoint, got display=${tabletNavToggleDisplay} at ${TABLET.width}px`,
  )

  // ───────────────────────────────────────────────────────────────────
  // 6. Viewport meta — the layout.tsx Viewport export must reach the
  //    rendered <head> with width=device-width and a maximum-scale.
  // ───────────────────────────────────────────────────────────────────
  const viewportMeta = await page
    .locator('meta[name="viewport"]')
    .getAttribute("content")
  assert.ok(viewportMeta, "viewport meta tag must be present in <head>")
  assert.match(
    viewportMeta!,
    /width=device-width/,
    `viewport meta must declare device-width, got: ${viewportMeta}`,
  )
  assert.match(
    viewportMeta!,
    /maximum-scale=1/,
    `viewport meta must pin maximum-scale=1, got: ${viewportMeta}`,
  )
})
