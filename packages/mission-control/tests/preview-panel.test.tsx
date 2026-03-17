/**
 * Tests for PreviewPanel component tree (PREV-02, PREV-03, PREV-04, POLISH-04..06).
 *
 * Pattern: Static source-text inspection for components that use hooks
 * (PreviewPanel uses useState so cannot be called directly in test environment).
 * Direct function calls only for pure components (ViewportSwitcher, DeviceFrame).
 *
 * Components tested:
 * - ViewportSwitcher: four buttons (Desktop/Tablet/Mobile/Dual)
 * - DeviceFrame: CSS frame shells for iPhone/Pixel in Dual mode
 * - PreviewPanel: source assertions — slide animation, header, server selector, iframes, error boundary
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { ViewportSwitcher } from "../src/components/preview/ViewportSwitcher";
import { DeviceFrame, DEVICE_FRAMES } from "../src/components/preview/DeviceFrame";

const PANEL_PATH = join(import.meta.dir, "../src/components/preview/PreviewPanel.tsx");
const WITH_STATE_PATH = join(import.meta.dir, "../src/components/preview/PreviewPanelWithState.tsx");
const DEVICE_FRAME_PATH = join(import.meta.dir, "../src/components/preview/DeviceFrame.tsx");

// -- ViewportSwitcher --

describe("ViewportSwitcher", () => {
  test("renders Desktop viewport button", () => {
    const html = JSON.stringify(ViewportSwitcher({
      viewport: "desktop",
      onViewportChange: () => {},
    }));
    expect(html).toContain("Desktop");
  });

  test("renders Tablet viewport button", () => {
    const html = JSON.stringify(ViewportSwitcher({
      viewport: "desktop",
      onViewportChange: () => {},
    }));
    expect(html).toContain("Tablet");
  });

  test("renders Mobile viewport button", () => {
    const html = JSON.stringify(ViewportSwitcher({
      viewport: "desktop",
      onViewportChange: () => {},
    }));
    expect(html).toContain("Mobile");
  });

  test("renders Dual viewport button", () => {
    const html = JSON.stringify(ViewportSwitcher({
      viewport: "desktop",
      onViewportChange: () => {},
    }));
    expect(html).toContain("Dual");
  });

  test("active Desktop button has different styling when viewport is desktop", () => {
    const activeHtml = JSON.stringify(ViewportSwitcher({
      viewport: "desktop",
      onViewportChange: () => {},
    }));
    const inactiveHtml = JSON.stringify(ViewportSwitcher({
      viewport: "tablet",
      onViewportChange: () => {},
    }));
    // They should differ (active state class changes)
    expect(activeHtml).not.toBe(inactiveHtml);
  });
});

// -- DeviceFrame --

describe("DeviceFrame", () => {
  test("DEVICE_FRAMES contains iphone and pixel entries", () => {
    expect(DEVICE_FRAMES.iphone).toBeDefined();
    expect(DEVICE_FRAMES.pixel).toBeDefined();
  });

  test("DEVICE_FRAMES iphone has correct dimensions", () => {
    expect(DEVICE_FRAMES.iphone.width).toBe(390);
    expect(DEVICE_FRAMES.iphone.height).toBe(750);
    expect(DEVICE_FRAMES.iphone.radius).toBe(47);
    expect(DEVICE_FRAMES.iphone.label).toBe("iPhone 14");
  });

  test("DEVICE_FRAMES pixel has correct dimensions", () => {
    expect(DEVICE_FRAMES.pixel.width).toBe(412);
    expect(DEVICE_FRAMES.pixel.height).toBe(750);
    expect(DEVICE_FRAMES.pixel.radius).toBe(17);
    expect(DEVICE_FRAMES.pixel.label).toBe("Pixel 7");
  });

  test("DeviceFrame renders iframe inside", () => {
    const html = JSON.stringify(DeviceFrame({
      device: "iphone",
      src: "http://localhost:5173/",
      iframeId: "preview-iframe-iphone",
    }));
    expect(html).toContain("iframe");
  });

  test("DeviceFrame iphone renders with id preview-iframe-iphone", () => {
    const html = JSON.stringify(DeviceFrame({
      device: "iphone",
      src: "http://localhost:5173/",
      iframeId: "preview-iframe-iphone",
    }));
    expect(html).toContain("preview-iframe-iphone");
  });

  test("DeviceFrame pixel renders with id preview-iframe-pixel", () => {
    const html = JSON.stringify(DeviceFrame({
      device: "pixel",
      src: "http://localhost:5173/",
      iframeId: "preview-iframe-pixel",
    }));
    expect(html).toContain("preview-iframe-pixel");
  });

  test("DeviceFrame imports and uses ErrorBoundaryFrame (source check)", () => {
    const src = readFileSync(DEVICE_FRAME_PATH, "utf-8");
    expect(src).toContain("ErrorBoundaryFrame");
    expect(src).toContain('from "./ErrorBoundaryFrame"');
  });
});

// -- PreviewPanel source assertions --

describe("PreviewPanel animation", () => {
  test("panel root has animate-in slide-in-from-right duration-200 classes", () => {
    const src = readFileSync(PANEL_PATH, "utf-8");
    expect(src).toContain("animate-in");
    expect(src).toContain("slide-in-from-right");
    expect(src).toContain("duration-200");
  });
});

describe("PreviewPanel header", () => {
  test("renders Live Preview title", () => {
    const src = readFileSync(PANEL_PATH, "utf-8");
    expect(src).toContain("Live Preview");
  });

  test("contains Scan for servers button for empty state", () => {
    const src = readFileSync(PANEL_PATH, "utf-8");
    expect(src).toContain("Scan for servers");
  });

  test("contains manual port input for empty state", () => {
    const src = readFileSync(PANEL_PATH, "utf-8");
    // Manual port input has number type
    expect(src).toContain("type=\"number\"");
  });

  test("contains Scanning... text for loading state", () => {
    const src = readFileSync(PANEL_PATH, "utf-8");
    expect(src).toContain("Scanning...");
  });

  test("contains Select server... option in dropdown", () => {
    const src = readFileSync(PANEL_PATH, "utf-8");
    expect(src).toContain("Select server...");
  });
});

describe("PreviewPanel props interface", () => {
  test("contains servers: DetectedServer[] prop", () => {
    const src = readFileSync(PANEL_PATH, "utf-8");
    expect(src).toContain("servers: DetectedServer[]");
  });

  test("contains activeFrontendPort prop", () => {
    const src = readFileSync(PANEL_PATH, "utf-8");
    expect(src).toContain("activeFrontendPort");
  });

  test("contains scanning prop", () => {
    const src = readFileSync(PANEL_PATH, "utf-8");
    expect(src).toContain("scanning");
  });

  test("contains onScan prop", () => {
    const src = readFileSync(PANEL_PATH, "utf-8");
    expect(src).toContain("onScan");
  });

  test("contains dualLeftPort and dualRightPort props", () => {
    const src = readFileSync(PANEL_PATH, "utf-8");
    expect(src).toContain("dualLeftPort");
    expect(src).toContain("dualRightPort");
  });
});

describe("PreviewPanel viewport modes", () => {
  test("uses http://localhost:PORT/ format for iframe src (direct, interactive)", () => {
    const src = readFileSync(PANEL_PATH, "utf-8");
    expect(src).toContain("http://localhost:");
  });

  test("renders DeviceFrame for iphone in dual mode", () => {
    const src = readFileSync(PANEL_PATH, "utf-8");
    expect(src).toContain('"iphone"');
    expect(src).toContain("preview-iframe-iphone");
  });

  test("renders DeviceFrame for pixel in dual mode", () => {
    const src = readFileSync(PANEL_PATH, "utf-8");
    expect(src).toContain('"pixel"');
    expect(src).toContain("preview-iframe-pixel");
  });

  test("contains tablet width 768px", () => {
    const src = readFileSync(PANEL_PATH, "utf-8");
    expect(src).toContain("768px");
  });

  test("contains mobile width 375px", () => {
    const src = readFileSync(PANEL_PATH, "utf-8");
    expect(src).toContain("375px");
  });
});

describe("PreviewPanel native app empty state", () => {
  test("contains no web preview message for native apps", () => {
    const src = readFileSync(PANEL_PATH, "utf-8");
    expect(src).toContain("No web preview available for native apps");
  });
});

describe("PreviewPanel callbacks wiring", () => {
  test("close button has aria-label Close preview", () => {
    const src = readFileSync(PANEL_PATH, "utf-8");
    expect(src).toContain("Close preview");
  });
});

describe("PreviewPanel ErrorBoundaryFrame usage", () => {
  test("PreviewPanel source imports ErrorBoundaryFrame", () => {
    const src = readFileSync(PANEL_PATH, "utf-8");
    expect(src).toContain("ErrorBoundaryFrame");
    expect(src).toContain('from "./ErrorBoundaryFrame"');
  });

  test("PreviewPanel source wraps iframes in ErrorBoundaryFrame", () => {
    const src = readFileSync(PANEL_PATH, "utf-8");
    expect(src).toContain("<ErrorBoundaryFrame>");
    expect(src).toContain("</ErrorBoundaryFrame>");
  });
});

describe("PreviewPanel sub-tabs", () => {
  test("contains desktop sub-tab rendering logic", () => {
    const src = readFileSync(PANEL_PATH, "utf-8");
    // Sub-tabs are rendered when servers.length > 1 in desktop mode
    expect(src).toContain("servers.length > 1");
  });
});

// -- PreviewPanelWithState --

describe("PreviewPanelWithState exports", () => {
  test("PreviewPanelWithState is exported from the wrapper file", async () => {
    const mod = await import("../src/components/preview/PreviewPanelWithState");
    expect(typeof mod.PreviewPanelWithState).toBe("function");
  });

  test("PreviewPanelWithState source calls usePreview() internally", () => {
    const src = readFileSync(WITH_STATE_PATH, "utf-8");
    expect(src).toContain("usePreview()");
  });

  test("PreviewPanelWithState source does not accept initialPort prop", () => {
    const src = readFileSync(WITH_STATE_PATH, "utf-8");
    expect(src).not.toContain("initialPort");
  });

  test("PreviewPanelWithState passes servers, scanning, triggerScan to PreviewPanel", () => {
    const src = readFileSync(WITH_STATE_PATH, "utf-8");
    expect(src).toContain("servers=");
    expect(src).toContain("scanning=");
    expect(src).toContain("onScan=");
  });
});
