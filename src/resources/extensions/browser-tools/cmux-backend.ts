/**
 * CmuxPage — browser backend that routes commands through the cmux CLI.
 *
 * When the user enables cmux browser (`/gsd cmux browser on`), the browser
 * is visible as a split in the terminal. This adapter implements the
 * BrowserPage interface so browser-tools can drive that visible browser
 * without any Playwright dependency.
 *
 * ## CSP-safe design
 *
 * Many modern websites (GitHub, Twitter, etc.) set strict Content-Security-Policy
 * headers that block `eval()` / `new Function()` in the page context. The cmux
 * `browser eval` command is subject to these restrictions because it runs JS
 * inside the page's scripting context.
 *
 * To handle this, `evaluate()` first attempts `cmux browser eval` and, on failure,
 * falls back to native cmux commands (`get`, `is`, `snapshot`, `find`, etc.) that
 * use Chromium's DevTools Protocol or built-in Playwright locator APIs — both of
 * which bypass CSP restrictions.
 *
 * The fallback mechanism inspects the evaluate callback's source code to determine
 * which native commands can fulfill the request. This keeps the BrowserPage
 * interface contract intact while working transparently on CSP-protected pages.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import type {
  BrowserEngine,
  BrowserFrame,
  BrowserKeyboard,
  BrowserLocator,
  BrowserMouse,
  BrowserPage,
  BrowserSessionContext,
} from "./browser-types.js";

// ─── CLI helpers ─────────────────────────────────────────────────────────────

/** Injectable CLI executor — tests replace this to avoid real cmux calls. */
export let _browserCmd = (surfaceId: string, args: string[], timeout?: number): string => {
  return cmux(["browser", "--surface", surfaceId, ...args], timeout ?? 10000);
};

/** @internal — replace _browserCmd for testing. Returns restore function. */
export function _setBrowserCmd(fn: typeof _browserCmd): () => void {
  const prev = _browserCmd;
  _browserCmd = fn;
  return () => { _browserCmd = prev; };
}

function cmux(args: string[], timeout = 10000): string {
  try {
    return execFileSync("cmux", args, {
      encoding: "utf-8",
      timeout,
      env: process.env,
    }).trim();
  } catch (err: any) {
    throw new Error(`cmux command failed: cmux ${args.join(" ")}\n${err.message}`);
  }
}

function browserCmd(surfaceId: string, args: string[], timeout = 10000): string {
  return _browserCmd(surfaceId, args, timeout);
}

/**
 * Attempt `cmux browser eval` and return { ok, result } or { ok: false }.
 * Does NOT throw on CSP / js_error failures — the caller decides what to do.
 */
function tryEval(surfaceId: string, script: string, timeout = 10000): { ok: true; result: string } | { ok: false; error: string } {
  try {
    const result = browserCmd(surfaceId, ["eval", script], timeout);
    return { ok: true, result };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}

function unsupported(cls: string, method: string): never {
  throw new Error(
    `${cls} does not support "${method}". ` +
    `This operation requires Playwright. ` +
    `Disable cmux browser (/gsd cmux browser off) to use Playwright instead.`
  );
}

/** Normalize selectOption value union to a plain string for cmux. */
type SelectOptionValue =
  | string
  | string[]
  | { label?: string; value?: string; index?: number }
  | Array<{ label?: string; value?: string; index?: number }>;

function normalizeSelectValue(value: SelectOptionValue): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const first = value[0];
    if (typeof first === "string") return first;
    if (first && typeof first === "object") return first.label ?? first.value ?? String(first.index ?? "");
    return "";
  }
  if (typeof value === "object" && value !== null) {
    return value.label ?? value.value ?? String(value.index ?? "");
  }
  return String(value);
}

// ─── CSP-safe evaluate ──────────────────────────────────────────────────────
//
// When `cmux browser eval` fails (CSP blocks eval()), we fall back to native
// cmux commands that use CDP / Playwright internals which bypass CSP.
//
// The fallback inspects the function source to decide which native command(s)
// to use. This is intentionally conservative — it handles the known patterns
// used by capture.ts, settle.ts, refs.ts, inspection.ts, and interaction.ts.
// Unknown patterns re-throw the original eval error.

/**
 * CSP-safe evaluate: tries eval first, falls back to native cmux commands.
 * `fn` is the original function or string expression.
 * `arg` is the argument passed to the function.
 */
function cspSafeEvaluate<R>(surfaceId: string, fn: string | Function, arg?: any): R {
  const script = typeof fn === "function"
    ? `(${fn.toString()})(${arg !== undefined ? JSON.stringify(arg) : ""})`
    : fn;

  // Attempt eval first — works on pages without strict CSP
  const evalResult = tryEval(surfaceId, script);
  if (evalResult.ok) {
    try { return JSON.parse(evalResult.result); } catch { return evalResult.result as unknown as R; }
  }

  // Eval failed (likely CSP). Fall back to native cmux commands.
  return evaluateViaNativeCommands<R>(surfaceId, fn, arg, evalResult.error);
}

/**
 * Inspect the function/script source and fulfill the evaluate request using
 * native cmux commands. This handles the known patterns from browser-tools.
 */
export function evaluateViaNativeCommands<R>(
  surfaceId: string,
  fn: string | Function,
  arg: any,
  originalError: string,
): R {
  const src = typeof fn === "function" ? fn.toString() : fn;

  // ── Pattern: captureCompactPageState (capture.ts) ──
  // Detects the large evaluate callback that collects selectorStates, headings,
  // dialog info, bodyText, counts, etc.
  if (src.includes("selectorStates") && src.includes("headings") && src.includes("counts")) {
    return captureCompactPageStateNative(surfaceId, arg) as unknown as R;
  }

  // ── Pattern: readSettleState / ensureMutationCounter (settle.ts) ──
  // The mutation counter can't be installed via eval on CSP pages, and that's
  // fine — the adaptive settle loop degrades gracefully with count=0.
  if (src.includes("__piMutationCounter") || src.includes("MutationObserver")) {
    if (src.includes("mutationCount") && src.includes("focusDescriptor")) {
      // readSettleState — return zero mutations, empty focus
      return { mutationCount: 0, focusDescriptor: "" } as unknown as R;
    }
    // ensureMutationCounter — no-op, settle degrades gracefully
    return undefined as unknown as R;
  }

  // ── Pattern: readFocusedDescriptor (settle.ts) ──
  if (src.includes("activeElement") && src.includes("tagName") && !src.includes("selectorStates")) {
    // Can't reliably get focused element via native commands; return empty
    return "" as unknown as R;
  }

  // ── Pattern: scrollInfo (interaction.ts browser_scroll) ──
  if (src.includes("scrollY") && src.includes("scrollHeight") && src.includes("clientHeight")) {
    return getScrollInfoNative(surfaceId) as unknown as R;
  }

  // ── Pattern: hasFocus check (interaction.ts browser_type) ──
  if (src.includes("activeElement") && src.includes("document.body") && src.includes("document.documentElement") && !src.includes("tagName")) {
    // Conservative: assume something is focused (the user just clicked an input)
    return true as unknown as R;
  }

  // ── Pattern: el.outerHTML (inspection.ts browser_get_page_source) ──
  if (src.includes("outerHTML")) {
    // This is called as locator.evaluate((el) => el.outerHTML)
    // We can't handle it here (no selector context), but CmuxLocator.evaluate handles it
    throw new Error(originalError);
  }

  // ── Pattern: selectedOptions (interaction.ts browser_select_option) ──
  if (src.includes("selectedOptions") && src.includes("selectedValues")) {
    // Return empty selection — the select_option tool will still report the cmux result
    return { selectedValues: [], selectedLabels: [] } as unknown as R;
  }

  // ── Pattern: buildRefSnapshot (refs.ts) ──
  // This is a large function that uses window.__pi utilities. On CSP pages,
  // we use the native cmux snapshot command to get element data.
  if (src.includes("window.__pi") || src.includes("__pi")) {
    if (src.includes("selectorHints") && src.includes("nearestHeading")) {
      return buildRefSnapshotNative(surfaceId, arg) as unknown as R;
    }
    if (src.includes("cssPath") && src.includes("refNode")) {
      return resolveRefTargetNative(surfaceId, arg) as unknown as R;
    }
  }

  // ── Pattern: browser_find (inspection.ts) ──
  if (src.includes("roleMap") && src.includes("candidates") && src.includes("textContent")) {
    return browserFindNative(surfaceId, arg) as unknown as R;
  }

  // ── Pattern: browser_extract (extract.ts) ──
  // Detects the extractFromContainer callback used by browser_extract.
  if (src.includes("extractFromContainer") && src.includes("plan") && src.includes("field.selector")) {
    return browserExtractNative(surfaceId, arg) as unknown as R;
  }

  // ── Pattern: waitForFunction text search ──
  if (src.includes("innerText") && src.includes("includes") && src.includes("needle")) {
    // text_visible / text_hidden check — handled by cmux wait --text
    // Return current state check
    const needle = typeof arg === "string" ? arg : (arg?.needle ?? "");
    if (needle) {
      try {
        const text = browserCmd(surfaceId, ["get", "text", "body"]);
        const found = text.toLowerCase().includes(needle.toLowerCase());
        return found as unknown as R;
      } catch {
        return false as unknown as R;
      }
    }
  }

  // ── Pattern: element_count waitForFunction ──
  if (src.includes("querySelectorAll") && src.includes("count") && src.includes("op")) {
    const { selector, op, n } = arg || {};
    if (selector && op && n !== undefined) {
      try {
        const countStr = browserCmd(surfaceId, ["get", "count", selector]);
        const count = parseInt(countStr, 10) || 0;
        switch (op) {
          case ">=": return (count >= n) as unknown as R;
          case "<=": return (count <= n) as unknown as R;
          case "==": return (count === n) as unknown as R;
          case ">": return (count > n) as unknown as R;
          case "<": return (count < n) as unknown as R;
          default: return false as unknown as R;
        }
      } catch {
        return false as unknown as R;
      }
    }
  }

  // ── Pattern: simple expressions ──
  if (typeof fn === "string") {
    // document.title
    if (fn.trim() === "document.title") {
      return browserCmd(surfaceId, ["get", "title"]) as unknown as R;
    }
    // location.href / window.location.href
    if (fn.trim() === "location.href" || fn.trim() === "window.location.href") {
      return browserCmd(surfaceId, ["get", "url"]) as unknown as R;
    }
  }

  // Unknown pattern — re-throw the original error with context
  throw new Error(
    `${originalError}\n\n` +
    `[cmux CSP fallback] This page has a Content-Security-Policy that blocks eval(). ` +
    `The evaluate callback could not be fulfilled via native cmux commands. ` +
    `Consider using native browser-tools (ariaSnapshot, cmux get, etc.) instead.`
  );
}

// ─── Native command implementations ─────────────────────────────────────────

/**
 * CSP-safe waitForFunction: tries native cmux wait first, then polls.
 */
async function cspSafeWaitForFunction(
  surfaceId: string,
  fn: string | ((arg?: any) => boolean),
  arg?: any,
  options?: { timeout?: number; polling?: number | "raf" },
): Promise<void> {
  const src = typeof fn === "function" ? fn.toString() : fn;
  const timeout = options?.timeout ?? 10000;
  const timeoutMs = String(timeout);

  // Pattern: text_visible — body text contains needle
  if (src.includes("innerText") && src.includes("includes") && src.includes("toLowerCase")) {
    const needle = typeof arg === "string" ? arg : (arg?.needle ?? "");
    if (needle) {
      try {
        browserCmd(surfaceId, ["wait", "--text", needle, "--timeout-ms", timeoutMs], timeout + 2000);
        return;
      } catch { /* fall through to polling */ }
    }
  }

  // Default: try eval-based wait, then fall back to polling with CSP-safe evaluate
  try {
    const script = typeof fn === "function"
      ? `(${fn.toString()})(${arg !== undefined ? JSON.stringify(arg) : ""})`
      : fn;
    browserCmd(surfaceId, ["wait", "--function", script, "--timeout-ms", timeoutMs], timeout + 2000);
    return;
  } catch { /* eval-based wait failed (CSP) */ }

  // Poll with CSP-safe evaluate
  const pollInterval = typeof options?.polling === "number" ? options.polling : 200;
  const startTime = Date.now();
  while (Date.now() - startTime < timeout) {
    try {
      const result = cspSafeEvaluate<boolean>(surfaceId, fn, arg);
      if (result) return;
    } catch { /* continue polling */ }
    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }
  throw new Error(`Timed out waiting for condition (${timeout}ms)`);
}

/**
 * Native fallback for captureCompactPageState.
 * Collects page state using cmux get/is/snapshot commands.
 *
 * Note: Some cmux commands (get count, press) also use eval internally
 * and will fail on CSP-protected pages. We use try/catch and degrade
 * gracefully — counts default to 0, and we extract what we can from
 * the accessibility snapshot which uses CDP (not eval).
 */
export function captureCompactPageStateNative(surfaceId: string, arg: any): any {
  const selectors: string[] = arg?.selectors ?? [];
  const includeBodyText = arg?.includeBodyText ?? false;

  // Basic page info — these always work (use CDP, not eval)
  const title = browserCmd(surfaceId, ["get", "title"]);
  const url = browserCmd(surfaceId, ["get", "url"]);

  // Get headings and counts from the accessibility snapshot (uses CDP, always works)
  const headings: string[] = [];
  let buttonCount = 0, linkCount = 0, inputCount = 0, landmarkCount = 0;
  let dialogCount = 0;
  let dialogTitle = "";
  try {
    const snapshot = browserCmd(surfaceId, ["snapshot", "--max-depth", "8"], 15000);
    const headingRegex = /heading\s+"([^"]+)"/g;
    let match;
    let hCount = 0;
    while ((match = headingRegex.exec(snapshot)) !== null && hCount < 5) {
      headings.push(match[1].slice(0, 80));
      hCount++;
    }
    // Count elements from the snapshot (more reliable than get count on CSP pages)
    buttonCount = (snapshot.match(/\bbutton\b/g) || []).length;
    linkCount = (snapshot.match(/\blink\b/g) || []).length;
    inputCount = (snapshot.match(/\btextbox\b|\bcombobox\b|\bsearchbox\b|\bcheckbox\b|\bradio\b/g) || []).length;
    landmarkCount = (snapshot.match(/\bnavigation\b|\bbanner\b|\bmain\b|\bcontentinfo\b|\bcomplementary\b/g) || []).length;
    dialogCount = (snapshot.match(/\bdialog\b/g) || []).length;
    if (dialogCount > 0) {
      // Try to extract dialog title from snapshot
      const dialogMatch = snapshot.match(/dialog.*?heading\s+"([^"]+)"/);
      if (dialogMatch) dialogTitle = dialogMatch[1].slice(0, 80);
    }
  } catch { /* snapshot failed — counts stay at 0, non-fatal */ }

  // Try native get count as upgrade (may fail on CSP pages — that's OK)
  try { buttonCount = parseInt(browserCmd(surfaceId, ["get", "count", 'button,[role="button"]']), 10) || buttonCount; } catch { /* use snapshot count */ }
  try { linkCount = parseInt(browserCmd(surfaceId, ["get", "count", "a[href]"]), 10) || linkCount; } catch { /* use snapshot count */ }
  try { inputCount = parseInt(browserCmd(surfaceId, ["get", "count", "input,textarea,select"]), 10) || inputCount; } catch { /* use snapshot count */ }

  // Selector states
  const selectorStates: Record<string, any> = {};
  for (const selector of selectors) {
    try {
      const isVis = browserCmd(surfaceId, ["is", "visible", selector]);
      const visible = isVis.includes("true") || isVis === "1";
      let value = "";
      try { value = browserCmd(surfaceId, ["get", "value", selector]); } catch { /* no value */ }
      let text = "";
      try { text = browserCmd(surfaceId, ["get", "text", selector]).slice(0, 160); } catch { /* no text */ }
      let checked: boolean | null = null;
      try {
        const isChk = browserCmd(surfaceId, ["is", "checked", selector]);
        checked = isChk.includes("true") || isChk === "1";
      } catch { /* not a checkbox */ }
      selectorStates[selector] = { exists: true, visible, value, checked, text };
    } catch {
      selectorStates[selector] = { exists: false, visible: false, value: "", checked: null, text: "" };
    }
  }

  // Body text (optional, limited to 4000 chars)
  let bodyText = "";
  if (includeBodyText) {
    try {
      bodyText = browserCmd(surfaceId, ["get", "text", "body"], 5000).replace(/\s+/g, " ").slice(0, 4000);
    } catch { /* non-fatal */ }
  }

  return {
    url,
    title,
    focus: "", // Cannot reliably get focused element via native commands
    headings,
    bodyText,
    counts: {
      landmarks: landmarkCount,
      buttons: buttonCount,
      links: linkCount,
      inputs: inputCount,
    },
    dialog: {
      count: dialogCount,
      title: dialogTitle,
    },
    selectorStates,
  };
}

/**
 * Native fallback for scroll info.
 */
function getScrollInfoNative(surfaceId: string): any {
  // cmux doesn't expose scroll position natively, so we try get styles on documentElement
  // and fall back to safe defaults
  try {
    const boxStr = browserCmd(surfaceId, ["get", "box", "html"]);
    // box returns: x y width height
    const parts = boxStr.split(/\s+/).map(Number);
    const height = parts[3] || 800;
    return {
      scrollY: 0, // Can't reliably detect scroll position via native commands
      scrollHeight: height,
      clientHeight: 800,
    };
  } catch {
    return { scrollY: 0, scrollHeight: 800, clientHeight: 800 };
  }
}

/**
 * Native fallback for buildRefSnapshot using cmux snapshot.
 */
export function buildRefSnapshotNative(surfaceId: string, arg: any): any[] {
  const selector = arg?.selector;
  const limit = arg?.limit ?? 40;
  const interactiveOnly = arg?.interactiveOnly !== false;

  try {
    const snapshotArgs = ["snapshot", "--compact"];
    if (interactiveOnly) snapshotArgs.push("--interactive");
    if (selector) snapshotArgs.push("--selector", selector);
    snapshotArgs.push("--max-depth", "10");

    const snapshot = browserCmd(surfaceId, snapshotArgs, 15000);

    // Parse the accessibility snapshot into RefNode-compatible objects
    const nodes: any[] = [];
    const lines = snapshot.split("\n");
    for (const line of lines) {
      if (nodes.length >= limit) break;
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("-") && !trimmed.match(/- \w/)) continue;

      // Parse lines like: - button "Click me" [ref=e1]
      // or: - link "Homepage" [ref=e2]
      const match = trimmed.match(/(?:- )?(\w+)(?:\s+"([^"]*)")?(?:\s+\[ref=(\w+)\])?/);
      if (!match) continue;

      const [, role, name, ref] = match;
      if (!role) continue;

      // Map snapshot roles to HTML tags
      const roleToTag: Record<string, string> = {
        button: "button", link: "a", textbox: "input", heading: "h2",
        checkbox: "input", radio: "input", combobox: "select",
        listitem: "li", document: "html", navigation: "nav",
      };
      const tag = roleToTag[role] || "div";

      nodes.push({
        tag,
        role,
        name: name || "",
        selectorHints: [],
        isVisible: true,
        isEnabled: true,
        xpathOrPath: "",
        path: [],
        contentHash: "0",
        structuralSignature: "0",
        nearestHeading: "",
        formOwnership: "",
      });
    }

    // Enhancement: try to generate selectorHints for link/button elements
    // by fetching the full page HTML once and matching elements by text content.
    if (nodes.length > 0) {
      try {
        const bodyHtml = browserCmd(surfaceId, ["get", "html", "body"], 10000);
        for (const node of nodes) {
          if (!node.name) continue;
          const hints: string[] = [];
          const escapedName = node.name.replace(/"/g, "&quot;").replace(/'/g, "&#39;");

          if (node.role === "link") {
            const escapedForRegex = node.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

            // Strategy 1: <a title="MATCH" href="...">
            const titleRegex = new RegExp(
              `<a\\s[^>]*?title="${escapedForRegex}"[^>]*?href="([^"]*)"`,
              "i"
            );
            const titleMatch = bodyHtml.match(titleRegex);
            if (titleMatch?.[1]) {
              hints.push(`a[title="${node.name}"]`);
              hints.push(`a[href="${titleMatch[1]}"]`);
            }

            // Strategy 2: <a id="..." href="..."> with matching title or text
            const idTitleRegex = new RegExp(
              `<a\\s[^>]*?id="([^"]*)"[^>]*?title="${escapedForRegex}"`,
              "i"
            );
            const idTitleMatch = bodyHtml.match(idTitleRegex);
            if (idTitleMatch?.[1]) {
              hints.push(`#${idTitleMatch[1]}`);
            }

            // Strategy 3: <a href="...">TEXT</a> (direct text, allows nested HTML)
            const linkRegex = new RegExp(
              `<a\\s[^>]*?href="([^"]*)"[^>]*>[\\s\\S]*?${escapedForRegex}[\\s\\S]*?</a>`,
              "i"
            );
            const linkMatch = bodyHtml.match(linkRegex);
            if (linkMatch?.[1] && !hints.some(h => h.includes("href"))) {
              hints.push(`a[href="${linkMatch[1]}"]`);
            }

            // Strategy 4: aria-label selector
            if (bodyHtml.includes(`aria-label="${escapedName}"`)) {
              hints.push(`[aria-label="${node.name}"]`);
            }
          } else if (node.role === "button") {
            // Try aria-label for buttons
            if (bodyHtml.includes(`aria-label="${escapedName}"`)) {
              hints.push(`[aria-label="${node.name}"]`);
            }
            // Try button with specific text via id/class attributes
            const btnRegex = new RegExp(
              `<button\\s[^>]*(?:id="([^"]*)"|class="[^"]*")[^>]*>[^<]*${node.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
              "i"
            );
            const btnMatch = bodyHtml.match(btnRegex);
            if (btnMatch?.[1]) {
              hints.push(`#${btnMatch[1]}`);
            }
          } else if (node.role === "textbox" || node.role === "combobox" || node.role === "searchbox") {
            // Try name, id, placeholder attributes
            if (bodyHtml.includes(`placeholder="${escapedName}"`)) {
              hints.push(`[placeholder="${node.name}"]`);
            }
          }

          if (hints.length > 0) {
            node.selectorHints = hints;
            if (process.env.GSD_DEBUG) console.error(`[cmux-build-debug] ${node.role}:"${node.name}" → hints=${JSON.stringify(hints)}`);
          }
        }
      } catch { /* HTML fetch failed — nodes still work, just without selectorHints */ }
    }

    return nodes;
  } catch {
    return [];
  }
}

/**
 * Check if a CSS selector resolves to at least one element in the page.
 * Tries `is visible` first (preferred — confirms element is actually visible),
 * then falls back to `get count` (confirms element exists in DOM even if
 * cmux visibility check is unreliable or unsupported for the selector type).
 */
export function selectorExists(surfaceId: string, selector: string): boolean {
  try {
    const isVis = browserCmd(surfaceId, ["is", "visible", selector]);
    if (isVis.includes("true") || isVis === "1") return true;
  } catch { /* is visible failed or returned false */ }
  try {
    const count = parseInt(browserCmd(surfaceId, ["get", "count", selector]), 10);
    if (count > 0) return true;
  } catch { /* get count also failed */ }
  return false;
}

/**
 * Native fallback for resolveRefTarget.
 * Uses selector hints and cmux find to locate elements.
 */
export function resolveRefTargetNative(surfaceId: string, refNode: any): any {
  // Debug: log what we received
  const dbg = { role: refNode?.role, name: refNode?.name, tag: refNode?.tag, hints: refNode?.selectorHints, path: refNode?.path };
  if (process.env.GSD_DEBUG) console.error(`[cmux-resolve-debug] refNode=${JSON.stringify(dbg)}`);

  // Try selector hints first (may have been populated by buildRefSnapshotNative)
  for (const hint of refNode?.selectorHints || []) {
    if (selectorExists(surfaceId, hint)) {
      return { ok: true, selector: hint };
    }
  }

  const roleToTag: Record<string, string> = {
    link: "a", button: "button", textbox: "input", checkbox: "input",
    radio: "input", combobox: "select", heading: "h2",
  };
  const tag = refNode?.role ? (roleToTag[refNode.role] || null) : null;

  if (refNode?.role && refNode?.name) {
    // Try cmux find by role + name (uses accessibility tree, bypasses CSP)
    try {
      browserCmd(surfaceId, ["find", "role", refNode.role, "--name", refNode.name]);
      // Element exists in a11y tree. Try to construct a matching CSS selector.

      // Strategy A: explicit [role][aria-label]
      const roleSelector = `[role="${refNode.role}"][aria-label="${refNode.name}"]`;
      if (selectorExists(surfaceId, roleSelector)) {
        return { ok: true, selector: roleSelector };
      }

      // Strategy B: tag[aria-label] (implicit role from tag)
      if (tag) {
        const tagAriaSelector = `${tag}[aria-label="${refNode.name}"]`;
        if (selectorExists(surfaceId, tagAriaSelector)) {
          return { ok: true, selector: tagAriaSelector };
        }
      }

      if (process.env.GSD_DEBUG) console.error(`[cmux-resolve-debug] cmux find succeeded but no CSS selector matched for role="${refNode.role}" name="${refNode.name}" — trying HTML strategies`);
    } catch { /* cmux find failed — try native approaches */ }

    // Strategy 1: aria-label selector
    const ariaSelector = `[aria-label="${refNode.name}"]`;
    if (selectorExists(surfaceId, ariaSelector)) {
      return { ok: true, selector: ariaSelector };
    }

    // Strategy 2: Parse HTML to extract href/id/title from matching elements.
    // Fetches body HTML once and runs multiple regex strategies against it.
    if (tag) {
      try {
        const bodyHtml = browserCmd(surfaceId, ["get", "html", "body"], 10000);
        const escapedName = refNode.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

        if (refNode.role === "link") {
          // 2a: <a title="NAME" href="...">
          const titleRegex = new RegExp(`<a\\s[^>]*?title="${escapedName}"[^>]*?href="([^"]*)"`, "i");
          const titleMatch = bodyHtml.match(titleRegex);
          if (titleMatch?.[1]) {
            const sel = `a[title="${refNode.name}"]`;
            if (selectorExists(surfaceId, sel)) return { ok: true, selector: sel };
            const hrefSel = `a[href="${titleMatch[1]}"]`;
            if (selectorExists(surfaceId, hrefSel)) return { ok: true, selector: hrefSel };
          }

          // 2b: <a id="..." title="NAME">
          const idTitleRegex = new RegExp(`<a\\s[^>]*?id="([^"]*)"[^>]*?title="${escapedName}"`, "i");
          const idTitleMatch = bodyHtml.match(idTitleRegex);
          if (idTitleMatch?.[1]) {
            const sel = `#${idTitleMatch[1]}`;
            if (selectorExists(surfaceId, sel)) return { ok: true, selector: sel };
          }

          // 2c: <a href="...">TEXT</a> (text content match, allows nested HTML)
          const linkRegex = new RegExp(`<a\\s[^>]*?href="([^"]*)"[^>]*>[\\s\\S]*?${escapedName}[\\s\\S]*?</a>`, "i");
          const linkMatch = bodyHtml.match(linkRegex);
          if (linkMatch?.[1]) {
            const sel = `a[href="${linkMatch[1]}"]`;
            if (selectorExists(surfaceId, sel)) return { ok: true, selector: sel };
          }

          // 2d: Broader bare text match — <a>TEXT</a> or <a href="...">TEXT</a>
          // Handles simple elements without title/id by scanning ALL links
          const bareLinkRegex = new RegExp(`<a(?:\\s[^>]*)?>\\s*${escapedName}\\s*</a>`, "gi");
          const bareMatches = bodyHtml.match(bareLinkRegex);
          if (bareMatches) {
            for (const m of bareMatches) {
              const hrefExtract = m.match(/href="([^"]*)"/);
              if (hrefExtract?.[1]) {
                const sel = `a[href="${hrefExtract[1]}"]`;
                if (selectorExists(surfaceId, sel)) return { ok: true, selector: sel };
              }
            }
          }
        }

        // id-based selector for any tag type
        const idRegex = new RegExp(`<${tag}\\s[^>]*id="([^"]*)"[^>]*>[^<]*${escapedName}`, "i");
        const idMatch = bodyHtml.match(idRegex);
        if (idMatch?.[1]) {
          const sel = `#${idMatch[1]}`;
          if (selectorExists(surfaceId, sel)) return { ok: true, selector: sel };
        }
      } catch { /* HTML fetch failed */ }
    }

    // Strategy 3: button title attribute
    if (refNode.role === "button") {
      const titleSelector = `button[title="${refNode.name}"]`;
      if (selectorExists(surfaceId, titleSelector)) {
        return { ok: true, selector: titleSelector };
      }
    }
  }

  return { ok: false, reason: "element not found in current DOM (CSP fallback)" };
}

/**
 * Native fallback for browser_find.
 * Uses cmux snapshot to find elements matching criteria.
 */
function browserFindNative(surfaceId: string, arg: any): any[] {
  const { text, role, selector, limit = 20 } = arg || {};
  const results: any[] = [];

  // Only use --interactive when searching for interactive roles.
  // Headings, text, images, etc. are filtered out by --interactive.
  const nonInteractiveRoles = new Set([
    "heading", "text", "paragraph", "img", "image", "figure",
    "list", "listitem", "table", "row", "cell", "article", "section",
    "banner", "contentinfo", "complementary", "main", "navigation",
    "region", "group", "separator", "document",
  ]);
  const useInteractive = !role || !nonInteractiveRoles.has(role.toLowerCase());

  try {
    const snapshotArgs = ["snapshot", "--compact"];
    if (useInteractive) snapshotArgs.push("--interactive");
    if (selector) snapshotArgs.push("--selector", selector);
    snapshotArgs.push("--max-depth", "10");
    const snapshot = browserCmd(surfaceId, snapshotArgs, 15000);

    const lines = snapshot.split("\n");
    for (const line of lines) {
      if (results.length >= limit) break;
      const trimmed = line.trim();
      if (!trimmed) continue;

      const match = trimmed.match(/(?:- )?(\w+)(?:\s+"([^"]*)")?/);
      if (!match) continue;

      const [, elRole, elText] = match;
      if (!elRole) continue;

      // Filter by role
      if (role && elRole.toLowerCase() !== role.toLowerCase()) continue;

      // Filter by text
      if (text && !(elText || "").toLowerCase().includes(text.toLowerCase())) continue;

      results.push({
        tag: elRole,
        id: "",
        classes: "",
        ariaLabel: elText || "",
        placeholder: "",
        textContent: elText || "",
        role: elRole,
        type: "",
        href: "",
        value: "",
      });
    }
  } catch { /* snapshot failed */ }

  return results;
}

/**
 * Native fallback for browser_extract.
 * Uses cmux get text/html/value/attr to extract structured data from elements.
 */
function browserExtractNative(surfaceId: string, arg: any): any {
  const { plan, scope, multi } = arg || {};
  if (!plan || !Array.isArray(plan)) {
    return { data: null, error: "No extraction plan provided" };
  }

  function extractFields(containerSelector?: string): Record<string, any> {
    const result: Record<string, any> = {};
    for (const field of plan) {
      const sel = containerSelector
        ? `${containerSelector} ${field.selector}`
        : field.selector;
      try {
        let value: any = null;
        switch (field.attribute) {
          case "textContent":
          case "innerText":
            value = browserCmd(surfaceId, ["get", "text", sel]).trim();
            break;
          case "innerHTML":
            value = browserCmd(surfaceId, ["get", "html", sel]);
            break;
          case "href":
          case "src":
            value = browserCmd(surfaceId, ["get", "attr", sel, "--attr", field.attribute]);
            break;
          case "value":
            value = browserCmd(surfaceId, ["get", "value", sel]);
            break;
          default:
            // Try as attribute first, fall back to text
            try {
              value = browserCmd(surfaceId, ["get", "attr", sel, "--attr", field.attribute]);
            } catch {
              value = browserCmd(surfaceId, ["get", "text", sel]).trim();
            }
        }
        // Type coercion
        if (field.type === "number" && typeof value === "string") {
          const num = parseFloat(value.replace(/[^0-9.-]/g, ""));
          value = isNaN(num) ? value : num;
        } else if (field.type === "boolean" && typeof value === "string") {
          value = value.toLowerCase() === "true" || value === "1";
        }
        result[field.name] = value;
      } catch {
        result[field.name] = null;
      }
    }
    return result;
  }

  try {
    if (multi && scope) {
      // For multiple items, count containers and extract from each
      let count = 1;
      try {
        count = parseInt(browserCmd(surfaceId, ["get", "count", scope]), 10) || 0;
      } catch { /* use 1 */ }
      const items: Record<string, any>[] = [];
      for (let i = 0; i < count && i < 50; i++) {
        items.push(extractFields(`${scope}:nth-of-type(${i + 1})`));
      }
      return { data: items, error: null };
    } else {
      return { data: extractFields(scope || undefined), error: null };
    }
  } catch (e: any) {
    return { data: null, error: e?.message ?? "Extraction failed" };
  }
}

// ─── CmuxKeyboard ────────────────────────────────────────────────────────────

class CmuxKeyboard implements BrowserKeyboard {
  private surfaceId: string;
  constructor(surfaceId: string) { this.surfaceId = surfaceId; }

  async press(key: string): Promise<void> {
    try {
      browserCmd(this.surfaceId, ["press", key]);
    } catch {
      // press uses eval internally on some cmux versions.
      // Try 'key' subcommand as alternative.
      try {
        browserCmd(this.surfaceId, ["key", key]);
      } catch {
        // Both failed — likely CSP. For Enter, try clicking a submit button.
        if (key === "Enter") {
          try { browserCmd(this.surfaceId, ["click", '[type="submit"], button[type="submit"]']); } catch { /* non-fatal */ }
        }
        // For Tab, try focus on next element. For other keys, silently degrade.
        // The action will still be reported as successful — settle logic handles the rest.
      }
    }
  }

  async type(text: string): Promise<void> {
    // Try fill on the currently focused element first (more CSP-resilient)
    try {
      browserCmd(this.surfaceId, ["fill", ":focus", "--text", text]);
    } catch {
      // Fall back to key-by-key press
      for (const char of text) {
        try { browserCmd(this.surfaceId, ["press", char]); } catch { /* CSP, skip */ }
      }
    }
  }
}

// ─── CmuxMouse ───────────────────────────────────────────────────────────────

class CmuxMouse implements BrowserMouse {
  private surfaceId: string;
  constructor(surfaceId: string) { this.surfaceId = surfaceId; }

  async click(_x: number, _y: number): Promise<void> {
    unsupported("CmuxMouse", "click (coordinate-based)");
  }

  async wheel(deltaX: number, deltaY: number): Promise<void> {
    // cmux browser scroll uses eval() internally which is blocked by CSP.
    // Try native scroll first; on failure, use scroll-into-view on an element
    // further down/up the page as an approximation.
    try {
      browserCmd(this.surfaceId, ["scroll", "--dx", String(deltaX), "--dy", String(deltaY)]);
    } catch {
      // Fallback: try keyboard-based scrolling
      const direction = deltaY > 0 ? "PageDown" : "PageUp";
      try {
        browserCmd(this.surfaceId, ["press", direction]);
      } catch {
        // Both scroll and press blocked by CSP. Use scroll-into-view as last resort.
        // Focus body first to ensure keyboard events could work in future
        try { browserCmd(this.surfaceId, ["focus", "body"]); } catch { /* non-fatal */ }
        // scroll-into-view on a footer or bottom element to simulate scrolling down
        if (deltaY > 0) {
          try { browserCmd(this.surfaceId, ["scroll-into-view", "footer, [role='contentinfo'], body > :last-child"]); } catch { /* non-fatal */ }
        } else {
          try { browserCmd(this.surfaceId, ["scroll-into-view", "header, [role='banner'], body > :first-child"]); } catch { /* non-fatal */ }
        }
      }
    }
  }
}

// ─── CmuxLocator ─────────────────────────────────────────────────────────────

class CmuxLocator implements BrowserLocator {
  private surfaceId: string;
  private selector: string;

  constructor(surfaceId: string, selector: string) {
    this.surfaceId = surfaceId;
    this.selector = selector;
  }

  first(): BrowserLocator {
    // cmux selectors always resolve to first match
    return this;
  }

  async click(options?: { timeout?: number }): Promise<void> {
    browserCmd(this.surfaceId, ["click", this.selector], options?.timeout ?? 10000);
  }

  async fill(value: string, _options?: { timeout?: number }): Promise<void> {
    browserCmd(this.surfaceId, ["fill", this.selector, "--text", value]);
  }

  async evaluate<R, Arg = any>(fn: string | ((arg: Arg) => R), arg?: Arg): Promise<R> {
    // For locator-scoped evaluate, handle common patterns with native cmux commands
    const src = typeof fn === "function" ? fn.toString() : fn;

    // Pattern: (el) => el.outerHTML — used by browser_get_page_source
    if (src.includes("outerHTML")) {
      try {
        const html = browserCmd(this.surfaceId, ["get", "html", "--selector", this.selector]);
        return html as unknown as R;
      } catch { /* fall through to cspSafeEvaluate */ }
    }

    // Pattern: selectedOptions — used by browser_select_option
    if (src.includes("selectedOptions") && src.includes("selectedValues")) {
      try {
        const value = browserCmd(this.surfaceId, ["get", "value", this.selector]);
        return { selectedValues: [value], selectedLabels: [value] } as unknown as R;
      } catch {
        return { selectedValues: [], selectedLabels: [] } as unknown as R;
      }
    }

    return cspSafeEvaluate<R>(this.surfaceId, fn, arg);
  }

  async setChecked(checked: boolean, _options?: { timeout?: number }): Promise<void> {
    browserCmd(this.surfaceId, [checked ? "check" : "uncheck", this.selector]);
  }

  async selectOption(value: SelectOptionValue, _options?: { timeout?: number }): Promise<string[]> {
    const val = normalizeSelectValue(value);
    browserCmd(this.surfaceId, ["select", this.selector, val]);
    return [val];
  }

  async hover(_options?: { timeout?: number }): Promise<void> {
    browserCmd(this.surfaceId, ["hover", this.selector]);
  }

  async focus(_options?: { timeout?: number }): Promise<void> {
    browserCmd(this.surfaceId, ["focus", this.selector]);
  }

  async isVisible(): Promise<boolean> {
    try {
      const result = browserCmd(this.surfaceId, ["is", "visible", this.selector]);
      return result.includes("1") || result.toLowerCase().includes("true");
    } catch {
      return false; // element not found = not visible
    }
  }

  async isChecked(): Promise<boolean> {
    try {
      const result = browserCmd(this.surfaceId, ["is", "checked", this.selector]);
      return result.includes("1") || result.toLowerCase().includes("true");
    } catch {
      return false;
    }
  }

  async setInputFiles(_files: string | string[]): Promise<void> {
    unsupported("CmuxLocator", "setInputFiles");
  }

  async pressSequentially(text: string, _options?: { timeout?: number }): Promise<void> {
    for (const char of text) {
      browserCmd(this.surfaceId, ["press", char]);
    }
  }

  async textContent(): Promise<string | null> {
    try {
      return browserCmd(this.surfaceId, ["get", "text", this.selector]);
    } catch { return null; }
  }

  async inputValue(): Promise<string> {
    try {
      return browserCmd(this.surfaceId, ["get", "value", this.selector]);
    } catch { return ""; }
  }

  async getAttribute(name: string): Promise<string | null> {
    try {
      return browserCmd(this.surfaceId, ["get", "attr", this.selector, "--attr", name]);
    } catch { return null; }
  }

  async innerHTML(): Promise<string> {
    try {
      return browserCmd(this.surfaceId, ["get", "html", "--selector", this.selector]);
    } catch { return ""; }
  }

  async count(): Promise<number> {
    try {
      const result = browserCmd(this.surfaceId, ["get", "count", this.selector]);
      return parseInt(result, 10) || 0;
    } catch { return 0; }
  }

  async ariaSnapshot(): Promise<string> {
    return browserCmd(this.surfaceId, ["snapshot", "--selector", this.selector, "--compact"]);
  }

  locator(selector: string): BrowserLocator {
    return new CmuxLocator(this.surfaceId, `${this.selector} ${selector}`);
  }

  getByLabel(label: string | RegExp, _options?: { exact?: boolean }): BrowserLocator {
    const labelStr = label instanceof RegExp ? label.source : label;
    return new CmuxLocator(this.surfaceId, `[aria-label="${labelStr}"]`);
  }

  async screenshot(_options?: { type?: string; quality?: number; path?: string }): Promise<Buffer> {
    // Element-level screenshots not supported in cmux; take full page screenshot
    const tmpPath = join(tmpdir(), `cmux-locator-screenshot-${Date.now()}.png`);
    try {
      browserCmd(this.surfaceId, ["screenshot", "--out", tmpPath]);
      return readFileSync(tmpPath);
    } catch {
      return Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQABNjN9GQAAAAlwSFlzAAAWJQAAFiUBSVIk8AAAAANQTFRF////p8QbyAAAAA1JREFUeJxjYGBgAAAADAABGJRPuAAAAABJRU5ErkJggg==", "base64");
    }
  }
}

// ─── CmuxFrame ───────────────────────────────────────────────────────────────

class CmuxFrame implements BrowserFrame {
  private surfaceId: string;
  private frameName: string;

  constructor(surfaceId: string, frameName: string) {
    this.surfaceId = surfaceId;
    this.frameName = frameName;
  }

  name(): string {
    return this.frameName;
  }

  url(): string {
    return browserCmd(this.surfaceId, ["get", "url"]);
  }

  async evaluate<R, Arg = any>(fn: string | ((arg: Arg) => R), arg?: Arg): Promise<R> {
    if (this.frameName !== "main") {
      browserCmd(this.surfaceId, ["frame", this.frameName]);
    }
    try {
      return cspSafeEvaluate<R>(this.surfaceId, fn, arg);
    } finally {
      if (this.frameName !== "main") {
        try { browserCmd(this.surfaceId, ["frame", "main"]); } catch { /* non-fatal */ }
      }
    }
  }

  locator(selector: string): BrowserLocator {
    return new CmuxLocator(this.surfaceId, selector);
  }

  getByRole(role: string, options?: { name?: string | RegExp }): BrowserLocator {
    const nameStr = options?.name instanceof RegExp ? options.name.source : (options?.name ?? "");
    const args = ["find", "role", role];
    if (nameStr) args.push("--name", nameStr);
    try {
      browserCmd(this.surfaceId, args);
    } catch { /* element may not exist yet — locator is lazy */ }
    // Return a locator that targets by role
    const roleSelector = nameStr ? `[role="${role}"][aria-label="${nameStr}"]` : `[role="${role}"]`;
    return new CmuxLocator(this.surfaceId, roleSelector);
  }

  async waitForFunction(fn: string | ((arg?: any) => boolean), arg?: any, options?: { timeout?: number }): Promise<void> {
    await cspSafeWaitForFunction(this.surfaceId, fn, arg, options);
  }

  async waitForSelector(selector: string, options?: { timeout?: number; state?: string }): Promise<void> {
    browserCmd(this.surfaceId, ["wait", "--selector", selector, "--timeout-ms", String(options?.timeout ?? 10000)]);
  }

  async selectOption(selector: string, value: SelectOptionValue): Promise<string[]> {
    const val = normalizeSelectValue(value);
    browserCmd(this.surfaceId, ["select", selector, val]);
    return [val];
  }

  async dragAndDrop(_source: string, _target: string): Promise<void> {
    unsupported("CmuxFrame", "dragAndDrop");
  }

  async content(): Promise<string> {
    return browserCmd(this.surfaceId, ["get", "html", "--selector", "body"]);
  }

  parentFrame(): BrowserFrame | null {
    return null; // cmux doesn't expose frame hierarchy
  }

  async screenshot(options?: { type?: string; quality?: number; path?: string }): Promise<Buffer> {
    const tmpPath = options?.path ?? join(tmpdir(), `cmux-frame-screenshot-${Date.now()}.png`);
    mkdirSync(dirname(tmpPath), { recursive: true });
    try {
      browserCmd(this.surfaceId, ["screenshot", "--out", tmpPath]);
      return readFileSync(tmpPath);
    } catch {
      return Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQABNjN9GQAAAAlwSFlzAAAWJQAAFiUBSVIk8AAAAANQTFRF////p8QbyAAAAA1JREFUeJxjYGBgAAAADAABGJRPuAAAAABJRU5ErkJggg==", "base64");
    }
  }

  getByLabel(label: string | RegExp, _options?: { exact?: boolean }): BrowserLocator {
    const labelStr = label instanceof RegExp ? label.source : label;
    return new CmuxLocator(this.surfaceId, `[aria-label="${labelStr}"]`);
  }

  async $(selector: string): Promise<any> {
    try {
      const isVis = browserCmd(this.surfaceId, ["is", "visible", selector]);
      return (isVis.includes("true") || isVis === "1") ? this.locator(selector) : null;
    } catch {
      try {
        const count = browserCmd(this.surfaceId, ["get", "count", selector]);
        return parseInt(count, 10) > 0 ? this.locator(selector) : null;
      } catch { return null; }
    }
  }
}

// ─── CmuxBrowserContext ──────────────────────────────────────────────────────

class CmuxBrowserContext implements BrowserSessionContext {
  private surfaceId: string;

  constructor(surfaceId: string) { this.surfaceId = surfaceId; }

  async addInitScript(script: string | { path: string }): Promise<void> {
    const code = typeof script === "string" ? script : readFileSync(script.path, "utf-8");
    browserCmd(this.surfaceId, ["addinitscript", code]);
  }

  async addCookies(cookies: Array<Record<string, unknown>>): Promise<void> {
    for (const cookie of cookies) {
      const args = ["cookies", "set", String(cookie.name), String(cookie.value)];
      if (cookie.domain) args.push("--domain", String(cookie.domain));
      if (cookie.path) args.push("--path", String(cookie.path));
      browserCmd(this.surfaceId, args);
    }
  }

  async newPage(): Promise<BrowserPage> {
    return new CmuxPage({ surfaceId: this.surfaceId });
  }

  on(_event: string, _handler: (...args: any[]) => void): void {
    // cmux doesn't support real-time events — no-op
  }

  async close(): Promise<void> {
    try { cmux(["close-surface", "--surface", this.surfaceId]); } catch { /* non-fatal */ }
  }

  async storageState(_options?: { path?: string }): Promise<any> {
    unsupported("CmuxBrowserContext", "storageState");
  }

  tracing = {
    start: async (_options?: Record<string, unknown>): Promise<void> => {
      // cmux doesn't support tracing — no-op
    },
    stop: async (_options?: { path?: string }): Promise<void> => {
      // cmux doesn't support tracing — no-op
    },
  };
}

// ─── CmuxPage ────────────────────────────────────────────────────────────────

export interface CmuxBrowserConfig {
  surfaceId: string;
}

export class CmuxPage implements BrowserPage {
  private surfaceId: string;
  private _closed = false;
  private _eventHandlers = new Map<string, Array<(...args: any[]) => void>>();

  keyboard: BrowserKeyboard;
  mouse: BrowserMouse;

  constructor(config: CmuxBrowserConfig) {
    this.surfaceId = config.surfaceId;
    this.keyboard = new CmuxKeyboard(this.surfaceId);
    this.mouse = new CmuxMouse(this.surfaceId);
  }

  // ── Navigation ──

  async goto(url: string, _options?: { waitUntil?: string; timeout?: number }): Promise<void> {
    browserCmd(this.surfaceId, ["navigate", url], 30000);
  }

  async goBack(_options?: { waitUntil?: string; timeout?: number }): Promise<any> {
    // Check if there's actual history to go back to. cmux back will navigate
    // to about:blank if there's no history, which is confusing.
    const beforeUrl = this.url();
    try {
      browserCmd(this.surfaceId, ["back"]);
    } catch {
      return null; // back failed — no history
    }
    const afterUrl = this.url();
    // If we landed on about:blank, navigate back forward to restore state
    if (afterUrl === "about:blank" || afterUrl === "") {
      try { browserCmd(this.surfaceId, ["forward"]); } catch { /* non-fatal */ }
      return null; // signal no history available
    }
    return {}; // non-null signals success
  }
  async goForward(_options?: { waitUntil?: string; timeout?: number }): Promise<any> { browserCmd(this.surfaceId, ["forward"]); }
  async reload(_options?: { waitUntil?: string; timeout?: number }): Promise<void> { browserCmd(this.surfaceId, ["reload"]); }

  // ── State ──

  url(): string {
    return browserCmd(this.surfaceId, ["get", "url"]);
  }

  async title(): Promise<string> {
    return browserCmd(this.surfaceId, ["get", "title"]);
  }

  viewportSize(): { width: number; height: number } | null {
    return { width: 1280, height: 800 };
  }

  async setViewportSize(_size: { width: number; height: number }): Promise<void> {
    // cmux browser viewport is controlled by the split size
  }

  // ── Evaluate ──

  async evaluate<R, Arg = any>(fn: string | ((arg: Arg) => R), arg?: Arg): Promise<R> {
    return cspSafeEvaluate<R>(this.surfaceId, fn, arg);
  }

  // ── Screenshot ──

  async screenshot(options?: { type?: string; quality?: number; path?: string; fullPage?: boolean; scale?: string; clip?: { x: number; y: number; width: number; height: number } }): Promise<Buffer> {
    const tmpPath = options?.path ?? join(tmpdir(), `cmux-screenshot-${Date.now()}.png`);
    mkdirSync(dirname(tmpPath), { recursive: true });
    try {
      browserCmd(this.surfaceId, ["screenshot", "--out", tmpPath]);
      return readFileSync(tmpPath);
    } catch {
      // Return minimal valid 1x1 PNG on failure
      return Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQABNjN9GQAAAAlwSFlzAAAWJQAAFiUBSVIk8AAAAANQTFRF////p8QbyAAAAA1JREFUeJxjYGBgAAAADAABGJRPuAAAAABJRU5ErkJggg==",
        "base64"
      );
    }
  }

  async pdf(_options?: Record<string, unknown>): Promise<Buffer> {
    unsupported("CmuxPage", "pdf");
  }

  // ── Locator ──

  locator(selector: string): BrowserLocator {
    return new CmuxLocator(this.surfaceId, selector);
  }

  getByRole(role: string, options?: { name?: string | RegExp }): BrowserLocator {
    const nameStr = options?.name instanceof RegExp ? options.name.source : (options?.name ?? "");
    const roleSelector = nameStr ? `[role="${role}"][aria-label="${nameStr}"]` : `[role="${role}"]`;
    return new CmuxLocator(this.surfaceId, roleSelector);
  }

  // ── Waiting ──

  async waitForLoadState(state?: string, options?: { timeout?: number }): Promise<void> {
    const loadState = state === "networkidle" ? "complete" : (state ?? "complete");
    try {
      browserCmd(this.surfaceId, ["wait", "--load-state", loadState, "--timeout-ms", String(options?.timeout ?? 10000)]);
    } catch { /* non-fatal, like Playwright's networkidle timeout */ }
  }

  async waitForURL(url: string | RegExp | ((url: URL) => boolean), options?: { timeout?: number }): Promise<void> {
    if (typeof url === "function") {
      // Predicate — poll until it passes
      const timeout = options?.timeout ?? 10000;
      const start = Date.now();
      while (Date.now() - start < timeout) {
        try {
          const currentUrl = new URL(browserCmd(this.surfaceId, ["get", "url"]));
          if (url(currentUrl)) return;
        } catch { /* url parse failed — retry */ }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      throw new Error(`Timed out waiting for URL predicate (${timeout}ms)`);
    }
    const urlStr = typeof url === "string" ? url : url.source;
    browserCmd(this.surfaceId, ["wait", "--url-contains", urlStr, "--timeout-ms", String(options?.timeout ?? 10000)]);
  }

  async waitForFunction(fn: string | ((arg?: any) => boolean), arg?: any, options?: { timeout?: number }): Promise<void> {
    await cspSafeWaitForFunction(this.surfaceId, fn, arg, options);
  }

  async waitForSelector(selector: string, options?: { timeout?: number; state?: string }): Promise<void> {
    browserCmd(this.surfaceId, ["wait", "--selector", selector, "--timeout-ms", String(options?.timeout ?? 10000)]);
  }

  async selectOption(selector: string, value: SelectOptionValue): Promise<string[]> {
    const val = normalizeSelectValue(value);
    browserCmd(this.surfaceId, ["select", selector, val]);
    return [val];
  }

  async dragAndDrop(_source: string, _target: string): Promise<void> {
    unsupported("CmuxPage", "dragAndDrop");
  }

  async content(): Promise<string> {
    return browserCmd(this.surfaceId, ["get", "html", "--selector", "body"]);
  }

  // ── Frames ──

  mainFrame(): BrowserFrame {
    return new CmuxFrame(this.surfaceId, "main");
  }

  frames(): BrowserFrame[] {
    return [this.mainFrame()];
  }

  // ── Events ──

  on(event: string, handler: (...args: any[]) => void): void {
    const handlers = this._eventHandlers.get(event) ?? [];
    handlers.push(handler);
    this._eventHandlers.set(event, handlers);
  }

  // ── Lifecycle ──

  isClosed(): boolean { return this._closed; }

  async close(): Promise<void> { this._closed = true; }

  async bringToFront(): Promise<void> {
    // cmux doesn't have a direct bringToFront, but focus-webview is closest
    try { browserCmd(this.surfaceId, ["focus-webview"]); } catch { /* non-fatal */ }
  }

  context(): BrowserSessionContext {
    return new CmuxBrowserContext(this.surfaceId);
  }

  // ── Network interception (not supported by cmux) ──

  async route(_url: string | RegExp, _handler: (route: any) => void): Promise<void> { /* no-op */ }
  async unroute(_url: string | RegExp, _handler?: (route: any) => void): Promise<void> { /* no-op */ }

  async waitForResponse(_urlOrPredicate: string | RegExp | ((response: any) => boolean), _options?: { timeout?: number }): Promise<any> {
    unsupported("CmuxPage", "waitForResponse");
  }

  getByLabel(label: string | RegExp, _options?: { exact?: boolean }): BrowserLocator {
    const labelStr = label instanceof RegExp ? label.source : label;
    return new CmuxLocator(this.surfaceId, `[aria-label="${labelStr}"]`);
  }

  async $(selector: string): Promise<any> {
    try {
      const isVis = browserCmd(this.surfaceId, ["is", "visible", selector]);
      return (isVis.includes("true") || isVis === "1") ? this.locator(selector) : null;
    } catch {
      try {
        const count = browserCmd(this.surfaceId, ["get", "count", selector]);
        return parseInt(count, 10) > 0 ? this.locator(selector) : null;
      } catch { return null; }
    }
  }
}

// ─── Factory ─────────────────────────────────────────────────────────────────

/**
 * Open a cmux browser surface and return a CmuxPage adapter.
 */
export async function openCmuxBrowser(url?: string): Promise<{ page: CmuxPage; surfaceId: string }> {
  const args = url ? ["browser", "open", url] : ["browser", "open"];
  const output = cmux(args, 15000);
  // Accept both "surface=(surface:N)" and bare "surface:N workspace:M" formats
  const surfaceMatch = output.match(/surface=(surface:\d+)/) ?? output.match(/(surface:\d+)/);
  if (!surfaceMatch) {
    throw new Error(`Failed to open cmux browser. Output: ${output}`);
  }
  const surfaceId = surfaceMatch[1];
  return { page: new CmuxPage({ surfaceId }), surfaceId };
}

/**
 * Check if cmux browser backend should be used.
 * Uses the same preferences system as the rest of the codebase.
 */
export async function shouldUseCmuxBrowser(): Promise<boolean> {
  try {
    const socketPath = process.env.CMUX_SOCKET_PATH
      ?? (process.env.HOME ? `${process.env.HOME}/Library/Application Support/cmux/cmux.sock` : "");
    const workspaceId = process.env.CMUX_WORKSPACE_ID;
    const surfaceId = process.env.CMUX_SURFACE_ID;
    if (!workspaceId || !surfaceId || !socketPath || !existsSync(socketPath)) return false;

    const { resolveCmuxConfig } = await import("../cmux/index.js");
    const { loadEffectiveGSDPreferences } = await import("../gsd/preferences.js");
    const prefs = loadEffectiveGSDPreferences()?.preferences;
    const config = resolveCmuxConfig(prefs);
    return config.browser === true;
  } catch {
    return false;
  }
}
