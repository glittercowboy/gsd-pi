import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { Markdown, visibleWidth } from "@gsd/pi-tui";
import { getMarkdownTheme, initTheme } from "@gsd/pi-coding-agent";
import type { QuestionOption, Question } from "../interview-ui.js";

// Theme must be initialized before Markdown rendering
before(() => { initTheme(); });

// ─── QuestionOption.preview type contract ─────────────────────────────────────

describe("QuestionOption preview field", () => {
  it("accepts option without preview (backward compat)", () => {
    const opt: QuestionOption = { label: "A", description: "Desc A" };
    assert.equal(opt.preview, undefined);
  });

  it("accepts option with preview string", () => {
    const opt: QuestionOption = {
      label: "A",
      description: "Desc A",
      preview: "## Code\n```ts\nconst x = 1;\n```",
    };
    assert.equal(typeof opt.preview, "string");
    assert.ok(opt.preview!.length > 0);
  });

  it("Question with mixed preview/no-preview options is valid", () => {
    const q: Question = {
      id: "test",
      header: "Test",
      question: "Pick one",
      options: [
        { label: "A", description: "Has preview", preview: "# Preview A" },
        { label: "B", description: "No preview" },
        { label: "C", description: "Has preview", preview: "# Preview C" },
      ],
    };
    const withPreview = q.options.filter((o) => o.preview);
    const withoutPreview = q.options.filter((o) => !o.preview);
    assert.equal(withPreview.length, 2);
    assert.equal(withoutPreview.length, 1);
  });
});

// ─── Markdown preview rendering ───────────────────────────────────────────────

describe("preview column rendering", () => {
  it("Markdown component renders non-empty output for a markdown string", () => {
    const mdTheme = getMarkdownTheme();
    const md = new Markdown("## Hello\n\nSome **bold** text.", 1, 0, mdTheme);
    const lines = md.render(40);
    assert.ok(lines.length > 0, "Markdown should produce at least one line");
    // At least one line should have visible content
    const hasContent = lines.some((l) => visibleWidth(l) > 0);
    assert.ok(hasContent, "At least one rendered line should have visible content");
  });

  it("Markdown component renders code blocks", () => {
    const mdTheme = getMarkdownTheme();
    const md = new Markdown("```ts\nconst x = 1;\n```", 1, 0, mdTheme);
    const lines = md.render(40);
    assert.ok(lines.length > 0);
    const joined = lines.join("\n");
    // The rendered output should contain the code content somewhere
    assert.ok(joined.includes("const") || joined.includes("x"), "Code block content should be present");
  });

  it("Markdown component respects width constraint", () => {
    const mdTheme = getMarkdownTheme();
    const longContent = "This is a very long paragraph that should wrap when rendered at a narrow width constraint.";
    const md = new Markdown(longContent, 1, 0, mdTheme);
    const lines = md.render(30);
    // All lines should respect the width
    for (const line of lines) {
      assert.ok(
        visibleWidth(line) <= 30,
        `Line exceeds width: "${line}" (visible: ${visibleWidth(line)})`,
      );
    }
  });
});

// ─── Layout stability ─────────────────────────────────────────────────────────

describe("layout stability", () => {
  const MIN_PREVIEW_WIDTH = 30;
  const MIN_OPTIONS_WIDTH = 30;
  const DIVIDER_WIDTH = 3;

  /** Mirrors questionHasAnyPreview() logic from interview-ui.ts */
  function questionHasAnyPreview(options: QuestionOption[]): boolean {
    return options.some((o) => o.preview != null && o.preview.trim().length > 0);
  }

  it("useSideBySide is true when ANY option has a preview (not just current)", () => {
    const options: QuestionOption[] = [
      { label: "A", description: "Has preview", preview: "# Hello" },
      { label: "B", description: "No preview" },
      { label: "C", description: "Also no preview" },
    ];
    const width = 100;
    const useSideBySide = questionHasAnyPreview(options) && width >= (MIN_OPTIONS_WIDTH + MIN_PREVIEW_WIDTH + DIVIDER_WIDTH);
    assert.equal(useSideBySide, true, "side-by-side should activate when any option has preview");
  });

  it("useSideBySide is false when no options have a preview", () => {
    const options: QuestionOption[] = [
      { label: "A", description: "No preview" },
      { label: "B", description: "No preview" },
    ];
    const useSideBySide = questionHasAnyPreview(options) && 100 >= 63;
    assert.equal(useSideBySide, false);
  });

  it("PREVIEW_MAX_LINES produces constant side-by-side height", () => {
    const PREVIEW_MAX_LINES = 20;
    // Short and long content both produce exactly PREVIEW_MAX_LINES after cap+pad
    for (const contentLen of [3, 10, 15, 30]) {
      const capped = Math.min(contentLen, PREVIEW_MAX_LINES);
      const padded = Math.max(capped, PREVIEW_MAX_LINES);
      assert.equal(padded, PREVIEW_MAX_LINES, `content ${contentLen} should pad to ${PREVIEW_MAX_LINES}`);
    }
  });

  it("total with PREVIEW_MAX_LINES fits in standard terminal (single-question)", () => {
    const PREVIEW_MAX_LINES = 20;
    const singleHeader = 1;  // bar only
    const footer = 3;        // blank + hints + bar
    const total = singleHeader + PREVIEW_MAX_LINES + footer;
    assert.ok(total <= 24, `single-question total ${total} exceeds 24-row terminal`);
  });
});

// ─── Preview layout constants ─────────────────────────────────────────────────

describe("preview layout constraints", () => {
  const MIN_PREVIEW_WIDTH = 30;
  const MIN_OPTIONS_WIDTH = 30;
  const DIVIDER_WIDTH = 3;
  const PREVIEW_RATIO = 0.60;

  it("minimum terminal width for preview = MIN_OPTIONS + MIN_PREVIEW + DIVIDER", () => {
    const minWidth = MIN_OPTIONS_WIDTH + MIN_PREVIEW_WIDTH + DIVIDER_WIDTH;
    assert.equal(minWidth, 63);
  });

  it("at minimum width, both columns get their floor", () => {
    const width = 63;
    const previewWidth = Math.max(MIN_PREVIEW_WIDTH, Math.floor(width * PREVIEW_RATIO));
    const leftWidth = Math.max(MIN_OPTIONS_WIDTH, width - previewWidth - DIVIDER_WIDTH);
    assert.ok(previewWidth >= MIN_PREVIEW_WIDTH, `preview ${previewWidth} < min ${MIN_PREVIEW_WIDTH}`);
    assert.ok(leftWidth >= MIN_OPTIONS_WIDTH, `options ${leftWidth} < min ${MIN_OPTIONS_WIDTH}`);
  });

  it("at wide terminal, preview ratio is approximately 60%", () => {
    const width = 120;
    const previewWidth = Math.max(MIN_PREVIEW_WIDTH, Math.floor(width * PREVIEW_RATIO));
    const leftWidth = Math.max(MIN_OPTIONS_WIDTH, width - previewWidth - DIVIDER_WIDTH);
    // Preview should be close to 60% of total
    const actualRatio = previewWidth / width;
    assert.ok(actualRatio >= 0.55 && actualRatio <= 0.65, `Ratio ${actualRatio} not near 0.60`);
    assert.ok(leftWidth >= MIN_OPTIONS_WIDTH);
  });

  it("preview disabled when terminal is too narrow", () => {
    const width = 62; // just under threshold
    const canShow = width >= (MIN_OPTIONS_WIDTH + MIN_PREVIEW_WIDTH + DIVIDER_WIDTH);
    assert.equal(canShow, false);
  });

  it("preview enabled when terminal is exactly at threshold", () => {
    const width = 63;
    const canShow = width >= (MIN_OPTIONS_WIDTH + MIN_PREVIEW_WIDTH + DIVIDER_WIDTH);
    assert.equal(canShow, true);
  });
});
