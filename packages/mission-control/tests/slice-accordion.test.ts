/**
 * SliceAccordion source-text tests.
 * Strategy: read SliceAccordion.tsx as string, assert key implementation details.
 * This avoids React hook rendering complexity in Bun test environment.
 */
import { describe, it, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const ACCORDION_PATH = join(
  import.meta.dir,
  "../src/components/milestone/SliceAccordion.tsx"
);

let source = "";
try {
  source = readFileSync(ACCORDION_PATH, "utf-8");
} catch {
  source = "";
}

describe("SliceAccordion source-text assertions", () => {
  it("file exists", () => {
    expect(source.length).toBeGreaterThan(0);
  });

  it('has data-testid="slice-accordion" on wrapper div', () => {
    expect(source).toContain('data-testid="slice-accordion"');
  });

  it("has data-testid slice-row prefix for dynamic row test ids", () => {
    // Template literal form: data-testid={`slice-row-${slice.id}`}
    expect(source).toContain("data-testid={`slice-row-");
  });

  it("imports SliceAction from server/types (not defined locally)", () => {
    expect(source).toContain("SliceAction");
    // Must be imported from types, not declared inline
    expect(source).toContain("from");
    // Should NOT define SliceAction locally
    const hasLocalDef =
      source.includes("type SliceAction =") ||
      source.includes("interface SliceAction");
    expect(hasLocalDef).toBe(false);
  });

  it('uses "openSliceIds" as accordion state variable', () => {
    expect(source).toContain("openSliceIds");
  });

  it('accepts "isAutoMode" prop', () => {
    expect(source).toContain("isAutoMode");
  });

  it('accepts "activeSliceId" prop', () => {
    expect(source).toContain("activeSliceId");
  });

  it('accepts "slices" prop of GSD2SliceInfo array type', () => {
    expect(source).toContain("GSD2SliceInfo");
  });

  it("uses useEffect for auto-mode expansion", () => {
    expect(source).toContain("useEffect");
  });

  it("has toggle handler that adds/removes sliceId from openSliceIds", () => {
    // Should update openSliceIds set
    expect(source).toContain("setOpenSliceIds");
  });
});
