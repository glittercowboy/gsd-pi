import type { Theme } from "@gsd/pi-coding-agent";
import { truncateToWidth, visibleWidth, matchesKey, Key } from "@gsd/pi-tui";
import { loadVisualizerData, type VisualizerData } from "./visualizer-data.js";
import {
  renderProgressView,
  renderDepsView,
  renderMetricsView,
  renderTimelineView,
  renderAgentView,
  renderChangelogView,
  renderExportView,
  renderKnowledgeView,
  renderCapturesView,
  renderHealthView,
  type ProgressFilter,
} from "./visualizer-views.js";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { writeExportFile } from "./export.js";
import { gsdRoot } from "./paths.js";
import { stripAnsi } from "../shared/mod.js";

const TAB_COUNT = 10;
const TAB_LABELS = [
  "1 Progress",
  "2 Timeline",
  "3 Deps",
  "4 Metrics",
  "5 Health",
  "6 Agent",
  "7 Changes",
  "8 Knowledge",
  "9 Captures",
  "0 Export",
];

type TabBarEntry = { label: string; width: number };

function buildTabBarEntries(activeTab: number, filterText: string, capturesPendingCount?: number): TabBarEntry[] {
  return TAB_LABELS.map((label, i) => {
    let displayLabel = label;
    if (i === activeTab && filterText) {
      displayLabel += " \u2731";
    }
    if (i === 8 && capturesPendingCount) {
      displayLabel += ` (${capturesPendingCount})`;
    }
    return {
      label: displayLabel,
      width: visibleWidth(displayLabel) + 2,
    };
  });
}

export class GSDVisualizerOverlay {
  private tui: { requestRender: () => void };
  private theme: Theme;
  private onClose: () => void;

  activeTab = 0;
  scrollOffsets: number[] = new Array(TAB_COUNT).fill(0);
  loading = true;
  disposed = false;
  cachedWidth?: number;
  cachedLines?: string[];
  refreshTimer: ReturnType<typeof setInterval>;
  data: VisualizerData | null = null;
  basePath: string;

  // Filter state
  filterMode = false;
  filterText = "";
  filterField: "all" | "status" | "risk" | "keyword" = "all";

  // Export state
  lastExportPath?: string;
  exportStatus?: string;

  // New state
  private lastVisibleRows = 20;
  collapsedMilestones = new Set<string>();
  showHelp = false;
  private resizeHandler: (() => void) | null = null;

  constructor(
    tui: { requestRender: () => void },
    theme: Theme,
    onClose: () => void,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.onClose = onClose;
    this.basePath = process.cwd();

    // Enable SGR mouse tracking
    process.stdout.write("\x1b[?1003h\x1b[?1006h");

    // Invalidate cache on terminal resize
    this.resizeHandler = () => {
      if (this.disposed) return;
      this.invalidate();
      this.tui.requestRender();
    };
    process.stdout.on("resize", this.resizeHandler);

    loadVisualizerData(this.basePath).then((d) => {
      this.data = d;
      this.loading = false;
      this.tui.requestRender();
    }).catch(() => {
      this.loading = false;
      this.tui.requestRender();
    });

    this.refreshTimer = setInterval(() => {
      loadVisualizerData(this.basePath).then((d) => {
        if (this.disposed) return;
        this.data = d;
        this.invalidate();
        this.tui.requestRender();
      }).catch(() => {}); // retry on next interval
    }, 5000);
  }

  private parseSGRMouse(data: string): { button: number; x: number; y: number; press: boolean } | null {
    const match = data.match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/);
    if (!match) return null;
    return {
      button: parseInt(match[1], 10),
      x: parseInt(match[2], 10),
      y: parseInt(match[3], 10),
      press: match[4] === "M",
    };
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      this.dispose();
      this.onClose();
      return;
    }

    // Filter mode input routing
    if (this.filterMode) {
      if (matchesKey(data, Key.enter)) {
        this.filterMode = false;
        this.invalidate();
        this.tui.requestRender();
        return;
      }
      if (matchesKey(data, Key.backspace)) {
        this.filterText = this.filterText.slice(0, -1);
        this.invalidate();
        this.tui.requestRender();
        return;
      }
      // Append printable characters
      if (data.length === 1 && data.charCodeAt(0) >= 32) {
        this.filterText += data;
        this.invalidate();
        this.tui.requestRender();
        return;
      }
      return;
    }

    // Help overlay dismissal
    if (this.showHelp) {
      if (matchesKey(data, Key.escape) || data === "?") {
        this.showHelp = false;
        this.invalidate();
        this.tui.requestRender();
        return;
      }
      return;
    }

    // Mouse handling (before keyboard checks)
    const mouse = this.parseSGRMouse(data);
    if (mouse) {
      if (mouse.button === 64) {
        // Wheel up
        this.scrollOffsets[this.activeTab] = Math.max(0, this.scrollOffsets[this.activeTab] - 3);
        this.invalidate();
        this.tui.requestRender();
        return;
      }
      if (mouse.button === 65) {
        // Wheel down
        this.scrollOffsets[this.activeTab] += 3;
        this.invalidate();
        this.tui.requestRender();
        return;
      }
      if (mouse.button === 0 && mouse.press) {
        // Left click — check if on tab bar row
        if (mouse.y === 2) {
          let xPos = 3;
          const tabs = buildTabBarEntries(this.activeTab, this.filterText, this.data?.captures?.pendingCount);
          for (let i = 0; i < tabs.length; i++) {
            const tabWidth = tabs[i]!.width;
            if (mouse.x >= xPos && mouse.x < xPos + tabWidth) {
              this.activeTab = i;
              this.invalidate();
              this.tui.requestRender();
              return;
            }
            xPos += tabWidth + 1;
          }
        }
      }
      return;
    }

    if (matchesKey(data, Key.shift("tab"))) {
      this.activeTab = (this.activeTab - 1 + TAB_COUNT) % TAB_COUNT;
      this.invalidate();
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, Key.tab)) {
      this.activeTab = (this.activeTab + 1) % TAB_COUNT;
      this.invalidate();
      this.tui.requestRender();
      return;
    }

    if ("1234567890".includes(data) && data.length === 1) {
      const idx = data === "0" ? 9 : parseInt(data, 10) - 1;
      this.activeTab = idx;
      this.invalidate();
      this.tui.requestRender();
      return;
    }

    // "/" enters filter mode on any tab
    if (data === "/") {
      this.filterMode = true;
      this.filterText = "";
      this.invalidate();
      this.tui.requestRender();
      return;
    }

    // "f" cycles filter field (limit to all/keyword on non-Progress tabs)
    if (data === "f") {
      if (this.activeTab === 0) {
        const fields: Array<"all" | "status" | "risk" | "keyword"> = ["all", "status", "risk", "keyword"];
        const idx = fields.indexOf(this.filterField);
        this.filterField = fields[(idx + 1) % fields.length];
      } else {
        this.filterField = this.filterField === "all" ? "keyword" : "all";
      }
      this.invalidate();
      this.tui.requestRender();
      return;
    }

    // "?" toggles help overlay
    if (data === "?") {
      this.showHelp = true;
      this.invalidate();
      this.tui.requestRender();
      return;
    }

    // Enter/Space toggles collapse on Progress tab
    if ((matchesKey(data, Key.enter) || data === " ") && this.activeTab === 0 && this.data) {
      const viewLines = this.renderTabContent(0, 80);
      const offset = this.scrollOffsets[0];
      for (const ms of this.data.milestones) {
        const lineIdx = viewLines.findIndex(l => stripAnsi(l).includes(`${ms.id}:`));
        if (lineIdx >= offset && lineIdx < offset + this.lastVisibleRows) {
          if (this.collapsedMilestones.has(ms.id)) {
            this.collapsedMilestones.delete(ms.id);
          } else {
            this.collapsedMilestones.add(ms.id);
          }
          this.invalidate();
          this.tui.requestRender();
          return;
        }
      }
      return;
    }

    // Export tab key handling
    if (this.activeTab === 9 && this.data) {
      if (data === "m" || data === "j" || data === "s") {
        this.handleExportKey(data);
        return;
      }
    }

    // Page Up/Down
    if (matchesKey(data, Key.pageUp)) {
      const amount = Math.max(1, this.lastVisibleRows - 2);
      this.scrollOffsets[this.activeTab] = Math.max(0, this.scrollOffsets[this.activeTab] - amount);
      this.invalidate();
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, Key.pageDown)) {
      const amount = Math.max(1, this.lastVisibleRows - 2);
      this.scrollOffsets[this.activeTab] += amount;
      this.invalidate();
      this.tui.requestRender();
      return;
    }

    // Half-page scroll: Ctrl+U / Ctrl+D
    if (matchesKey(data, Key.ctrl("u"))) {
      const amount = Math.max(1, Math.floor(this.lastVisibleRows / 2));
      this.scrollOffsets[this.activeTab] = Math.max(0, this.scrollOffsets[this.activeTab] - amount);
      this.invalidate();
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, Key.ctrl("d"))) {
      const amount = Math.max(1, Math.floor(this.lastVisibleRows / 2));
      this.scrollOffsets[this.activeTab] += amount;
      this.invalidate();
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
      this.scrollOffsets[this.activeTab]++;
      this.invalidate();
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
      this.scrollOffsets[this.activeTab] = Math.max(0, this.scrollOffsets[this.activeTab] - 1);
      this.invalidate();
      this.tui.requestRender();
      return;
    }

    if (data === "g") {
      this.scrollOffsets[this.activeTab] = 0;
      this.invalidate();
      this.tui.requestRender();
      return;
    }

    if (data === "G") {
      this.scrollOffsets[this.activeTab] = 999;
      this.invalidate();
      this.tui.requestRender();
      return;
    }
  }

  private handleExportKey(key: "m" | "j" | "s"): void {
    if (!this.data) return;

    const format = key === "m" ? "markdown" : key === "j" ? "json" : "snapshot";

    if (format === "snapshot") {
      // Capture current active tab's rendered lines as snapshot
      const snapshotLines = this.renderTabContent(this.activeTab, 80);
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const exportDir = gsdRoot(this.basePath);
      mkdirSync(exportDir, { recursive: true });
      const outPath = join(exportDir, `snapshot-${timestamp}.txt`);
      writeFileSync(outPath, snapshotLines.join("\n") + "\n", "utf-8");
      this.lastExportPath = outPath;
      this.exportStatus = "Snapshot saved";
    } else {
      const result = writeExportFile(this.basePath, format, this.data);
      if (result) {
        this.lastExportPath = result;
        this.exportStatus = `${format} export saved`;
      }
    }

    this.invalidate();
    this.tui.requestRender();
  }

  private renderTabContent(tab: number, width: number): string[] {
    if (!this.data) return [];
    const th = this.theme;
    switch (tab) {
      case 0: {
        const filter: ProgressFilter | undefined =
          this.filterText ? { text: this.filterText, field: this.filterField } : undefined;
        return renderProgressView(this.data, th, width, filter, this.collapsedMilestones);
      }
      case 1:
        return renderTimelineView(this.data, th, width);
      case 2:
        return renderDepsView(this.data, th, width);
      case 3:
        return renderMetricsView(this.data, th, width);
      case 4:
        return renderHealthView(this.data, th, width);
      case 5:
        return renderAgentView(this.data, th, width);
      case 6:
        return renderChangelogView(this.data, th, width);
      case 7:
        return renderKnowledgeView(this.data, th, width);
      case 8:
        return renderCapturesView(this.data, th, width);
      case 9:
        return renderExportView(this.data, th, width, this.lastExportPath);
      default:
        return [];
    }
  }

  private renderHelpContent(width: number): string[] {
    const th = this.theme;
    const lines: string[] = [];
    lines.push(th.fg("accent", th.bold("Keyboard Shortcuts")));
    lines.push("");
    const bindings: [string, string][] = [
      ["Tab/Shift+Tab", "Next/Previous tab"],
      ["1-9, 0", "Jump to tab"],
      ["j/k, Up/Down", "Scroll line"],
      ["PgUp/PgDn", "Scroll page"],
      ["Ctrl+U/Ctrl+D", "Scroll half-page"],
      ["g/G", "Top/Bottom"],
      ["/", "Search/filter"],
      ["f", "Cycle filter field"],
      ["Enter/Space", "Toggle collapse (Progress)"],
      ["Mouse wheel", "Scroll"],
      ["Click tab", "Switch tab"],
      ["?", "Toggle help"],
      ["Esc", "Close"],
    ];
    for (const [key, desc] of bindings) {
      const keyStr = th.fg("accent", key.padEnd(20));
      lines.push(`  ${keyStr} ${desc}`);
    }
    lines.push("");
    lines.push(th.fg("dim", "Press ? or Esc to dismiss"));
    return lines;
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) {
      return this.cachedLines;
    }

    const th = this.theme;
    const innerWidth = width - 4;
    const content: string[] = [];

    // Tab bar
    const tabEntries = buildTabBarEntries(this.activeTab, this.filterText, this.data?.captures?.pendingCount);
    const tabs = tabEntries.map((entry, i) => {
      if (i === this.activeTab) {
        return th.fg("accent", `[${entry.label}]`);
      }
      return th.fg("dim", `[${entry.label}]`);
    });
    content.push(" " + tabs.join(" "));
    content.push("");

    // Filter bar (when in filter mode on any tab)
    if (this.filterMode) {
      content.push(
        th.fg("accent", `Filter (${this.filterField}): ${this.filterText}\u2588`),
      );
      content.push("");
    }

    if (this.showHelp) {
      content.push(...this.renderHelpContent(innerWidth));
    } else if (this.loading) {
      const loadingText = "Loading\u2026";
      const vis = visibleWidth(loadingText);
      const leftPad = Math.max(0, Math.floor((innerWidth - vis) / 2));
      content.push(" ".repeat(leftPad) + loadingText);
    } else if (this.data) {
      let viewLines = this.renderTabContent(this.activeTab, innerWidth);

      // Show export status message if present
      if (this.exportStatus && this.activeTab === 9) {
        content.push(th.fg("success", this.exportStatus));
        content.push("");
        this.exportStatus = undefined;
      }

      // Apply cross-tab filter for non-Progress tabs
      if (this.filterText && this.activeTab !== 0) {
        const lowerFilter = this.filterText.toLowerCase();
        viewLines = viewLines.filter(line => stripAnsi(line).toLowerCase().includes(lowerFilter));
      }

      content.push(...viewLines);
    }

    // Apply scroll
    const viewportHeight = Math.max(5, process.stdout.rows ? process.stdout.rows - 8 : 24);
    const chromeHeight = 2;
    const visibleContentRows = Math.max(1, viewportHeight - chromeHeight);
    this.lastVisibleRows = visibleContentRows;
    const totalLines = content.length;
    const maxScroll = Math.max(0, content.length - visibleContentRows);
    this.scrollOffsets[this.activeTab] = Math.min(this.scrollOffsets[this.activeTab], maxScroll);
    const offset = this.scrollOffsets[this.activeTab];
    const visibleContent = content.slice(offset, offset + visibleContentRows);

    const lines = this.wrapInBox(visibleContent, width, offset, visibleContentRows, totalLines);

    // Footer hint
    const hint = th.fg("dim", "Tab/Shift+Tab/1-9,0 switch \u00b7 / filter \u00b7 PgUp/PgDn scroll \u00b7 ? help \u00b7 esc close");
    const hintVis = visibleWidth(hint);
    const hintPad = Math.max(0, Math.floor((width - hintVis) / 2));
    lines.push(" ".repeat(hintPad) + hint);

    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  private wrapInBox(inner: string[], width: number, offset?: number, visibleRows?: number, totalLines?: number): string[] {
    const th = this.theme;
    const border = (s: string) => th.fg("borderAccent", s);
    const innerWidth = width - 4;
    const lines: string[] = [];
    lines.push(border("\u256d" + "\u2500".repeat(width - 2) + "\u256e"));

    // Compute scroll indicator positions
    const scrollable = totalLines !== undefined && visibleRows !== undefined && totalLines > visibleRows;
    let thumbStart = -1;
    let thumbLen = 0;
    const innerRows = inner.length;
    if (scrollable && innerRows > 0 && totalLines! > 0) {
      thumbStart = Math.round(((offset ?? 0) / totalLines!) * innerRows);
      thumbLen = Math.max(1, Math.round((visibleRows! / totalLines!) * innerRows));
    }

    for (let i = 0; i < inner.length; i++) {
      const line = inner[i];
      const truncated = truncateToWidth(line, innerWidth);
      const padWidth = Math.max(0, innerWidth - visibleWidth(truncated));
      const rightBorder = scrollable && i >= thumbStart && i < thumbStart + thumbLen
        ? border("\u2503")
        : border("\u2502");
      lines.push(border("\u2502") + " " + truncated + " ".repeat(padWidth) + " " + rightBorder);
    }
    lines.push(border("\u2570" + "\u2500".repeat(width - 2) + "\u256f"));
    return lines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  dispose(): void {
    this.disposed = true;
    clearInterval(this.refreshTimer);
    if (this.resizeHandler) {
      process.stdout.removeListener("resize", this.resizeHandler);
      this.resizeHandler = null;
    }
    // Disable SGR mouse tracking
    process.stdout.write("\x1b[?1003l\x1b[?1006l");
  }
}
