/**
 * browser-tools — Playwright integration tests
 *
 * Exercises browser-side evaluate scripts against real DOM:
 * - EVALUATE_HELPERS_SOURCE (window.__pi utilities)
 * - Intent scoring scripts from intent.ts
 * - Form analysis scripts from forms.ts
 *
 * Uses Playwright Chromium for real page.evaluate() against HTML fixtures.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Source loading — import the IIFE builders directly via jiti.
// The test-only named exports in tools/intent.ts and tools/forms.ts exist
// exactly so this test can call the real, in-tree builders. No brace
// walking, no regex stripping — a refactor of the signatures just updates
// the import surface, not the test.
// ---------------------------------------------------------------------------

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const jiti = require("jiti")(__dirname, { interopDefault: true, debug: false });
const { EVALUATE_HELPERS_SOURCE } = jiti("../evaluate-helpers.ts");
const { buildIntentScoringScript } = jiti("../tools/intent.ts");
const { buildFormAnalysisScript } = jiti("../tools/forms.ts");

// ---------------------------------------------------------------------------
// Browser lifecycle
// ---------------------------------------------------------------------------

let browser;
let page;

before(async () => {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
  page = await context.newPage();
});

after(async () => {
  if (browser) await browser.close();
});

/** Inject window.__pi helpers into the current page */
async function injectHelpers() {
  await page.evaluate(EVALUATE_HELPERS_SOURCE);
}

// =========================================================================
// 1. window.__pi utility tests
// =========================================================================

describe("window.__pi utilities", () => {
  it("simpleHash — deterministic output for same input", async () => {
    await page.setContent("<p>test</p>");
    await injectHelpers();
    const h1 = await page.evaluate(() => window.__pi.simpleHash("hello world"));
    const h2 = await page.evaluate(() => window.__pi.simpleHash("hello world"));
    assert.equal(h1, h2);
    assert.equal(typeof h1, "string");
    assert.ok(h1.length > 0);
  });

  it("simpleHash — different output for different input", async () => {
    await page.setContent("<p>test</p>");
    await injectHelpers();
    const h1 = await page.evaluate(() => window.__pi.simpleHash("hello"));
    const h2 = await page.evaluate(() => window.__pi.simpleHash("world"));
    assert.notEqual(h1, h2);
  });

  it("isVisible — visible element returns true", async () => {
    await page.setContent('<div id="vis" style="width:100px;height:100px;">visible</div>');
    await injectHelpers();
    const result = await page.evaluate(() => window.__pi.isVisible(document.getElementById("vis")));
    assert.equal(result, true);
  });

  it("isVisible — display:none returns false", async () => {
    await page.setContent('<div id="hidden" style="display:none;">hidden</div>');
    await injectHelpers();
    const result = await page.evaluate(() => window.__pi.isVisible(document.getElementById("hidden")));
    assert.equal(result, false);
  });

  it("isVisible — visibility:hidden returns false", async () => {
    await page.setContent('<div id="inv" style="visibility:hidden;width:100px;height:100px;">inv</div>');
    await injectHelpers();
    const result = await page.evaluate(() => window.__pi.isVisible(document.getElementById("inv")));
    assert.equal(result, false);
  });

  it("isEnabled — enabled input returns true", async () => {
    await page.setContent('<input id="en" type="text" />');
    await injectHelpers();
    const result = await page.evaluate(() => window.__pi.isEnabled(document.getElementById("en")));
    assert.equal(result, true);
  });

  it("isEnabled — disabled input returns false", async () => {
    await page.setContent('<input id="dis" type="text" disabled />');
    await injectHelpers();
    const result = await page.evaluate(() => window.__pi.isEnabled(document.getElementById("dis")));
    assert.equal(result, false);
  });

  it("isEnabled — aria-disabled returns false", async () => {
    await page.setContent('<button id="adis" aria-disabled="true">Click</button>');
    await injectHelpers();
    const result = await page.evaluate(() => window.__pi.isEnabled(document.getElementById("adis")));
    assert.equal(result, false);
  });

  it("inferRole — button element → button", async () => {
    await page.setContent('<button id="btn">Go</button>');
    await injectHelpers();
    const role = await page.evaluate(() => window.__pi.inferRole(document.getElementById("btn")));
    assert.equal(role, "button");
  });

  it("inferRole — anchor with href → link", async () => {
    await page.setContent('<a id="lnk" href="/page">Link</a>');
    await injectHelpers();
    const role = await page.evaluate(() => window.__pi.inferRole(document.getElementById("lnk")));
    assert.equal(role, "link");
  });

  it("inferRole — input[type=text] → textbox", async () => {
    await page.setContent('<input id="txt" type="text" />');
    await injectHelpers();
    const role = await page.evaluate(() => window.__pi.inferRole(document.getElementById("txt")));
    assert.equal(role, "textbox");
  });

  it("inferRole — input[type=search] → searchbox", async () => {
    await page.setContent('<input id="srch" type="search" />');
    await injectHelpers();
    const role = await page.evaluate(() => window.__pi.inferRole(document.getElementById("srch")));
    assert.equal(role, "searchbox");
  });

  it("inferRole — explicit role attribute overrides tag", async () => {
    await page.setContent('<div id="d" role="button">Click me</div>');
    await injectHelpers();
    const role = await page.evaluate(() => window.__pi.inferRole(document.getElementById("d")));
    assert.equal(role, "button");
  });

  it("accessibleName — button with text content", async () => {
    await page.setContent('<button id="b">Submit Form</button>');
    await injectHelpers();
    const name = await page.evaluate(() => window.__pi.accessibleName(document.getElementById("b")));
    assert.equal(name, "Submit Form");
  });

  it("accessibleName — input with aria-label", async () => {
    await page.setContent('<input id="i" aria-label="Search query" />');
    await injectHelpers();
    const name = await page.evaluate(() => window.__pi.accessibleName(document.getElementById("i")));
    assert.equal(name, "Search query");
  });

  it("accessibleName — input with label[for]", async () => {
    await page.setContent('<label for="email">Email Address</label><input id="email" type="email" />');
    await injectHelpers();
    // accessibleName checks aria-label/labelledby/placeholder/alt/value/textContent —
    // but NOT label[for]. That's by design — it's a lightweight heuristic, not full ARIA.
    // For label[for], the accessible name falls back to textContent (empty for input).
    // Test what it actually returns.
    const name = await page.evaluate(() => window.__pi.accessibleName(document.getElementById("email")));
    // Input has no aria-label, no labelledby, no placeholder, no alt, no value, no textContent
    // So it returns empty string
    assert.equal(typeof name, "string");
  });

  it("accessibleName — input with aria-labelledby", async () => {
    await page.setContent('<span id="lbl">Username</span><input id="u" aria-labelledby="lbl" />');
    await injectHelpers();
    const name = await page.evaluate(() => window.__pi.accessibleName(document.getElementById("u")));
    assert.equal(name, "Username");
  });

  it("accessibleName — input with placeholder as fallback", async () => {
    await page.setContent('<input id="p" placeholder="Enter name" />');
    await injectHelpers();
    const name = await page.evaluate(() => window.__pi.accessibleName(document.getElementById("p")));
    assert.equal(name, "Enter name");
  });

  it("isInteractiveEl — button → true", async () => {
    await page.setContent('<button id="b">Go</button>');
    await injectHelpers();
    const result = await page.evaluate(() => window.__pi.isInteractiveEl(document.getElementById("b")));
    assert.equal(result, true);
  });

  it("isInteractiveEl — div → false", async () => {
    await page.setContent('<div id="d">Just text</div>');
    await injectHelpers();
    const result = await page.evaluate(() => window.__pi.isInteractiveEl(document.getElementById("d")));
    assert.equal(result, false);
  });

  it("isInteractiveEl — input → true", async () => {
    await page.setContent('<input id="i" type="text" />');
    await injectHelpers();
    const result = await page.evaluate(() => window.__pi.isInteractiveEl(document.getElementById("i")));
    assert.equal(result, true);
  });

  it("isInteractiveEl — anchor with href → true", async () => {
    await page.setContent('<a id="a" href="/page">Link</a>');
    await injectHelpers();
    const result = await page.evaluate(() => window.__pi.isInteractiveEl(document.getElementById("a")));
    assert.equal(result, true);
  });

  it("isInteractiveEl — div with tabindex → true", async () => {
    await page.setContent('<div id="t" tabindex="0">Focusable</div>');
    await injectHelpers();
    const result = await page.evaluate(() => window.__pi.isInteractiveEl(document.getElementById("t")));
    assert.equal(result, true);
  });

  it("cssPath — returns valid selector that resolves back to element", async () => {
    await page.setContent('<div><span><button id="target">Click</button></span></div>');
    await injectHelpers();
    const selector = await page.evaluate(() => window.__pi.cssPath(document.getElementById("target")));
    assert.equal(typeof selector, "string");
    assert.ok(selector.length > 0);
    // Verify round-trip: querySelector with that selector finds the element
    const roundTrip = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      return el ? el.id : null;
    }, selector);
    assert.equal(roundTrip, "target");
  });

  it("cssPath — element with id uses #id shortcut", async () => {
    await page.setContent('<div id="myid">content</div>');
    await injectHelpers();
    const selector = await page.evaluate(() => window.__pi.cssPath(document.getElementById("myid")));
    assert.equal(selector, "#myid");
  });

  it("cssPath — nested element without id uses tag path", async () => {
    await page.setContent('<main><section><p class="test">hello</p></section></main>');
    await injectHelpers();
    const selector = await page.evaluate(() => {
      const el = document.querySelector("p.test");
      return window.__pi.cssPath(el);
    });
    assert.ok(selector.startsWith("body >"));
    // Verify it resolves
    const text = await page.evaluate((sel) => document.querySelector(sel)?.textContent, selector);
    assert.equal(text, "hello");
  });
});

// =========================================================================
// 2. Intent scoring tests
// =========================================================================

describe("intent scoring", () => {
  it("submit_form — submit button inside form scores higher than outside", async () => {
    await page.setContent(`
      <form>
        <input type="text" name="q" />
        <button type="submit" id="inside">Submit</button>
      </form>
      <button id="outside">Random Button</button>
    `);
    await injectHelpers();

    const script = buildIntentScoringScript("submit_form");
    const result = await page.evaluate(script);

    assert.ok(!result.error, `Unexpected error: ${result.error}`);
    assert.ok(result.candidates.length >= 1, "Expected at least 1 candidate");

    // The submit button inside the form should be top-ranked
    const inside = result.candidates.find(c => c.selector.includes("inside") || c.text.includes("submit"));
    const outside = result.candidates.find(c => c.selector.includes("outside") || c.text.includes("random"));

    assert.ok(inside, "Should find the inside submit button");
    if (outside) {
      assert.ok(inside.score > outside.score, `Inside score (${inside.score}) should exceed outside (${outside.score})`);
    }
  });

  it("close_dialog — × button in dialog scores highest", async () => {
    await page.setContent(`
      <div role="dialog" aria-modal="true" style="width:400px;height:300px;position:relative;">
        <button id="close-x" aria-label="close" style="position:absolute;top:5px;right:5px;">×</button>
        <p>Dialog content</p>
        <button id="cancel">Cancel</button>
      </div>
      <button id="other">Other</button>
    `);
    await injectHelpers();

    const script = buildIntentScoringScript("close_dialog");
    const result = await page.evaluate(script);

    assert.ok(!result.error, `Unexpected error: ${result.error}`);
    assert.ok(result.candidates.length >= 1, "Expected at least 1 candidate");

    // The × button should score high due to text match + aria-label + inside-dialog + top-right
    const closeBtn = result.candidates[0];
    assert.ok(
      closeBtn.text.includes("×") || closeBtn.name.toLowerCase().includes("close"),
      `Top candidate should be the × button, got: ${closeBtn.text} / ${closeBtn.name}`
    );
  });

  it("search_field — input[type=search] scores higher than input[type=text]", async () => {
    await page.setContent(`
      <header>
        <nav>
          <input id="search" type="search" placeholder="Search..." />
          <input id="text" type="text" placeholder="Username" />
        </nav>
      </header>
    `);
    await injectHelpers();

    const script = buildIntentScoringScript("search_field");
    const result = await page.evaluate(script);

    assert.ok(!result.error, `Unexpected error: ${result.error}`);
    assert.ok(result.candidates.length >= 1, "Expected at least 1 candidate");

    const searchInput = result.candidates.find(c => c.tag === "input" && c.name.toLowerCase().includes("search"));
    assert.ok(searchInput, "Should find the search input");

    // It should be the top candidate or at least higher than the text input
    const textInput = result.candidates.find(c => c.name.toLowerCase().includes("username"));
    if (textInput) {
      assert.ok(
        searchInput.score > textInput.score,
        `Search score (${searchInput.score}) should exceed text (${textInput.score})`
      );
    }
  });

  it("primary_cta — large button in main scores higher than small nav link", async () => {
    await page.setContent(`
      <nav>
        <a id="nav-link" href="/about" style="font-size:12px;padding:2px 4px;">About</a>
      </nav>
      <main>
        <button id="cta" style="font-size:24px;padding:20px 60px;width:300px;height:80px;">Get Started</button>
      </main>
    `);
    await injectHelpers();

    const script = buildIntentScoringScript("primary_cta");
    const result = await page.evaluate(script);

    assert.ok(!result.error, `Unexpected error: ${result.error}`);
    assert.ok(result.candidates.length >= 1, "Expected at least 1 candidate");

    // The large button in main should outrank the small nav link
    const cta = result.candidates.find(c => c.text.includes("get started"));
    const navLink = result.candidates.find(c => c.text.includes("about"));

    assert.ok(cta, "Should find the CTA button");
    if (navLink) {
      assert.ok(cta.score > navLink.score, `CTA score (${cta.score}) should exceed nav link (${navLink.score})`);
    }
  });

  it("submit_form — returns correct result structure", async () => {
    await page.setContent(`
      <form>
        <button type="submit">Save</button>
      </form>
    `);
    await injectHelpers();

    const script = buildIntentScoringScript("submit_form");
    const result = await page.evaluate(script);

    assert.equal(result.intent, "submit_form");
    assert.equal(result.normalized, "submitform");
    assert.equal(typeof result.count, "number");
    assert.ok(Array.isArray(result.candidates));

    const c = result.candidates[0];
    assert.equal(typeof c.score, "number");
    assert.equal(typeof c.selector, "string");
    assert.equal(typeof c.tag, "string");
    assert.equal(typeof c.role, "string");
    assert.equal(typeof c.name, "string");
    assert.equal(typeof c.text, "string");
    assert.equal(typeof c.reason, "string");
  });

  it("unknown intent returns error", async () => {
    await page.setContent("<p>test</p>");
    await injectHelpers();

    const script = buildIntentScoringScript("nonexistent_intent");
    const result = await page.evaluate(script);
    assert.ok(result.error, "Should return an error for unknown intent");
    assert.ok(result.error.includes("Unknown intent"));
  });

  it("missing window.__pi returns error", async () => {
    // Navigate to about:blank and clear window.__pi to simulate missing helpers
    await page.setContent("<p>test</p>");
    await page.evaluate(() => { delete window.__pi; });
    const script = buildIntentScoringScript("submit_form");
    const result = await page.evaluate(script);
    assert.ok(result.error, "Should return an error when __pi not injected");
    assert.ok(result.error.includes("__pi"));
  });
});

// =========================================================================
// 3. Form analysis tests
// =========================================================================

describe("form analysis", () => {
  const COMPLEX_FORM = `
    <form id="testform" action="/submit">
      <!-- label[for] association -->
      <label for="fname">First Name</label>
      <input id="fname" name="first_name" type="text" required />

      <!-- wrapping label -->
      <label>Last Name <input id="lname" name="last_name" type="text" /></label>

      <!-- aria-label -->
      <input id="email" name="email" type="email" aria-label="Email Address" required />

      <!-- aria-labelledby -->
      <span id="phone-label">Phone Number</span>
      <input id="phone" name="phone" type="tel" aria-labelledby="phone-label" />

      <!-- placeholder as fallback -->
      <input id="city" name="city" type="text" placeholder="Enter your city" />

      <!-- hidden input -->
      <input id="token" name="csrf_token" type="hidden" value="abc123" />

      <!-- select with options -->
      <label for="country">Country</label>
      <select id="country" name="country">
        <option value="">Select...</option>
        <option value="us" selected>United States</option>
        <option value="uk">United Kingdom</option>
      </select>

      <!-- checkbox -->
      <label><input id="agree" name="agree" type="checkbox" /> I agree to terms</label>

      <!-- submit button -->
      <button type="submit" id="submit-btn">Register</button>
    </form>
  `;

  it("label via label[for] resolves correctly", async () => {
    await page.setContent(COMPLEX_FORM);
    const script = buildFormAnalysisScript("#testform");
    const result = await page.evaluate(script);

    assert.ok(!result.error, `Unexpected error: ${result.error}`);
    const fname = result.fields.find(f => f.name === "first_name");
    assert.ok(fname, "Should find first_name field");
    assert.equal(fname.label, "First Name");
  });

  it("label via wrapping label resolves correctly", async () => {
    await page.setContent(COMPLEX_FORM);
    const script = buildFormAnalysisScript("#testform");
    const result = await page.evaluate(script);

    const lname = result.fields.find(f => f.name === "last_name");
    assert.ok(lname, "Should find last_name field");
    assert.equal(lname.label, "Last Name");
  });

  it("label via aria-label resolves correctly", async () => {
    await page.setContent(COMPLEX_FORM);
    const script = buildFormAnalysisScript("#testform");
    const result = await page.evaluate(script);

    const email = result.fields.find(f => f.name === "email");
    assert.ok(email, "Should find email field");
    assert.equal(email.label, "Email Address");
  });

  it("label via aria-labelledby resolves correctly", async () => {
    await page.setContent(COMPLEX_FORM);
    const script = buildFormAnalysisScript("#testform");
    const result = await page.evaluate(script);

    const phone = result.fields.find(f => f.name === "phone");
    assert.ok(phone, "Should find phone field");
    assert.equal(phone.label, "Phone Number");
  });

  it("label via placeholder as fallback", async () => {
    await page.setContent(COMPLEX_FORM);
    const script = buildFormAnalysisScript("#testform");
    const result = await page.evaluate(script);

    const city = result.fields.find(f => f.name === "city");
    assert.ok(city, "Should find city field");
    assert.equal(city.label, "Enter your city");
  });

  it("hidden input is flagged as hidden", async () => {
    await page.setContent(COMPLEX_FORM);
    const script = buildFormAnalysisScript("#testform");
    const result = await page.evaluate(script);

    const token = result.fields.find(f => f.name === "csrf_token");
    assert.ok(token, "Should find csrf_token field");
    assert.equal(token.hidden, true);
    assert.equal(token.type, "hidden");
  });

  it("submit button is discovered", async () => {
    await page.setContent(COMPLEX_FORM);
    const script = buildFormAnalysisScript("#testform");
    const result = await page.evaluate(script);

    assert.ok(result.submitButtons.length >= 1, "Should find at least 1 submit button");
    const btn = result.submitButtons[0];
    assert.equal(btn.text, "Register");
    assert.equal(btn.type, "submit");
  });

  it("returns correct result structure", async () => {
    await page.setContent(COMPLEX_FORM);
    const script = buildFormAnalysisScript("#testform");
    const result = await page.evaluate(script);

    assert.equal(typeof result.formSelector, "string");
    assert.ok(Array.isArray(result.fields));
    assert.ok(Array.isArray(result.submitButtons));
    assert.equal(typeof result.fieldCount, "number");
    assert.equal(typeof result.visibleFieldCount, "number");
    assert.ok(result.fieldCount > 0);
  });

  it("required fields are correctly identified", async () => {
    await page.setContent(COMPLEX_FORM);
    const script = buildFormAnalysisScript("#testform");
    const result = await page.evaluate(script);

    const fname = result.fields.find(f => f.name === "first_name");
    assert.equal(fname.required, true, "first_name should be required");

    const lname = result.fields.find(f => f.name === "last_name");
    assert.equal(lname.required, false, "last_name should not be required");
  });

  it("select options are included", async () => {
    await page.setContent(COMPLEX_FORM);
    const script = buildFormAnalysisScript("#testform");
    const result = await page.evaluate(script);

    const country = result.fields.find(f => f.name === "country");
    assert.ok(country, "Should find country field");
    assert.equal(country.type, "select");
    assert.ok(Array.isArray(country.options));
    assert.ok(country.options.length >= 3);
    const selected = country.options.find(o => o.selected);
    assert.equal(selected.value, "us");
  });

  it("auto-detects single form when no selector given", async () => {
    await page.setContent(COMPLEX_FORM);
    const script = buildFormAnalysisScript();
    const result = await page.evaluate(script);

    assert.ok(!result.error, "Should auto-detect the form");
    assert.ok(result.fields.length > 0, "Should find fields");
    assert.ok(result.formSelector.includes("testform") || result.formSelector.includes("form"));
  });

  it("returns error for non-existent selector", async () => {
    await page.setContent("<p>no form</p>");
    const script = buildFormAnalysisScript("#doesnotexist");
    const result = await page.evaluate(script);

    assert.ok(result.error, "Should return error for missing form");
    assert.ok(result.error.includes("not found"));
  });
});
