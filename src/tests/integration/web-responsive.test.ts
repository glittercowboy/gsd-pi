/**
 * Structural tests verifying mobile-responsive CSS classes exist in key web UI components.
 *
 * These tests read the source files and assert that responsive Tailwind classes
 * (md:, sm:, lg:, xl:) and mobile-specific markup are present where expected.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const WEB_ROOT = resolve(import.meta.dirname, '../../../web')

function readComponent(relativePath: string): string {
  return readFileSync(resolve(WEB_ROOT, relativePath), 'utf-8')
}

// ── layout.tsx ──────────────────────────────────────────────────────────────

test('layout.tsx exports a Viewport with device-width', () => {
  const src = readComponent('app/layout.tsx')
  assert.ok(src.includes("Viewport"), 'should import Viewport type from next')
  assert.ok(src.includes("device-width"), 'should set width to device-width')
  assert.ok(src.includes("maximumScale"), 'should set maximumScale for mobile')
})

// ── app-shell.tsx ───────────────────────────────────────────────────────────

test('app-shell.tsx has a mobile hamburger menu toggle', () => {
  const src = readComponent('components/gsd/app-shell.tsx')
  assert.ok(src.includes('mobile-nav-toggle'), 'should have mobile-nav-toggle test id')
  assert.ok(src.includes('Menu'), 'should import Menu icon for hamburger')
})

test('app-shell.tsx hides desktop sidebar on mobile with md:flex', () => {
  const src = readComponent('components/gsd/app-shell.tsx')
  // The desktop sidebar wrapper should use hidden + md:flex
  assert.ok(src.includes('hidden md:flex'), 'desktop sidebar should be hidden on mobile')
})

test('app-shell.tsx has a mobile nav drawer', () => {
  const src = readComponent('components/gsd/app-shell.tsx')
  assert.ok(src.includes('mobile-nav-drawer'), 'should have mobile-nav-drawer test id')
  assert.ok(src.includes('mobile-nav-overlay'), 'should have mobile-nav-overlay test id')
})

test('app-shell.tsx has a mobile milestone drawer', () => {
  const src = readComponent('components/gsd/app-shell.tsx')
  assert.ok(src.includes('mobile-milestone-drawer'), 'should have mobile-milestone-drawer test id')
  assert.ok(src.includes('mobile-milestone-toggle'), 'should have mobile-milestone-toggle test id')
})

test('app-shell.tsx has a mobile bottom bar', () => {
  const src = readComponent('components/gsd/app-shell.tsx')
  assert.ok(src.includes('mobile-bottom-bar'), 'should have mobile-bottom-bar test id')
})

test('app-shell.tsx header uses responsive padding', () => {
  const src = readComponent('components/gsd/app-shell.tsx')
  assert.ok(src.includes('md:px-4'), 'header should have responsive horizontal padding')
})

test('app-shell.tsx hides project label on small screens', () => {
  const src = readComponent('components/gsd/app-shell.tsx')
  assert.ok(src.includes('hidden sm:inline'), 'project label should be hidden on mobile')
})

test('app-shell.tsx hides desktop milestone sidebar on mobile', () => {
  const src = readComponent('components/gsd/app-shell.tsx')
  // The milestone sidebar resize handle should be hidden on mobile
  assert.ok(
    src.includes('hidden md:flex') || src.includes('hidden md:block'),
    'milestone sidebar should be hidden on mobile',
  )
})

// ── sidebar.tsx ──────────────────────────────────────────────────────────────

test('sidebar.tsx supports a mobile prop', () => {
  const src = readComponent('components/gsd/sidebar.tsx')
  assert.ok(src.includes('mobile?:'), 'Sidebar should accept a mobile prop')
  assert.ok(src.includes('mobile?: boolean'), 'mobile prop should be boolean')
})

test('sidebar.tsx has a MobileNavPanel with touch-friendly targets', () => {
  const src = readComponent('components/gsd/sidebar.tsx')
  assert.ok(src.includes('mobile-nav-panel'), 'should have mobile-nav-panel test id')
  assert.ok(src.includes('min-h-[44px]'), 'nav items should have 44px minimum touch target height')
})

// ── dashboard.tsx ───────────────────────────────────────────────────────────

test('dashboard.tsx has responsive grid for metric cards', () => {
  const src = readComponent('components/gsd/dashboard.tsx')
  assert.ok(src.includes('sm:grid-cols-2'), 'metric grid should stack to 2 cols on sm')
  assert.ok(src.includes('xl:grid-cols-4'), 'metric grid should expand to 4 cols on xl')
})

test('dashboard.tsx has responsive padding on content area', () => {
  const src = readComponent('components/gsd/dashboard.tsx')
  assert.ok(src.includes('md:p-6'), 'content area should have responsive padding')
})

test('dashboard.tsx has responsive header padding', () => {
  const src = readComponent('components/gsd/dashboard.tsx')
  assert.ok(src.includes('md:px-6'), 'dashboard header should have responsive horizontal padding')
})

// ── status-bar.tsx ──────────────────────────────────────────────────────────

test('status-bar.tsx hides branch info on small screens', () => {
  const src = readComponent('components/gsd/status-bar.tsx')
  // Branch info should be hidden on mobile
  assert.ok(
    src.includes('hidden sm:flex'),
    'branch info should use hidden sm:flex for responsive display',
  )
})

test('status-bar.tsx has responsive text sizing', () => {
  const src = readComponent('components/gsd/status-bar.tsx')
  assert.ok(src.includes('md:text-xs'), 'status bar should have responsive text size')
})

test('status-bar.tsx has responsive gap spacing', () => {
  const src = readComponent('components/gsd/status-bar.tsx')
  assert.ok(src.includes('md:gap-4'), 'status bar should have responsive gap')
})

// ── globals.css ─────────────────────────────────────────────────────────────

test('globals.css has mobile touch target styles', () => {
  const src = readComponent('../web/app/globals.css')
  assert.ok(src.includes('max-width: 767px'), 'should have a mobile media query')
  assert.ok(src.includes('mobile-touch-target'), 'should define mobile-touch-target class')
  assert.ok(src.includes('min-height: 44px'), 'touch targets should be at least 44px')
})

test('globals.css has mobile sidebar drawer styles', () => {
  const src = readComponent('../web/app/globals.css')
  assert.ok(src.includes('mobile-sidebar-drawer'), 'should define mobile-sidebar-drawer class')
  assert.ok(src.includes('mobile-sidebar-overlay'), 'should define mobile-sidebar-overlay class')
})
