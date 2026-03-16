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
  type ProgressFilter,
} from "./visualizer-views.js";
import { writeExportFile } from "./export.js";

const TAB_COUNT = 7;
const TAB_LABELS = [
  "1 Progress",
  "2 Deps",
  "3 Metrics",
  "4 Timeline",
  "5 Agent",
  "6 Changes",
  "7 Export",
];

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

  // Filter state (Progress tab)
  filterMode = false;
  filterText = "";
  filterField: "all" | "status" | "risk" | "keyword" = "all";

  // Export state
  lastExportPath?: string;
  exportStatus?: string;

  constructor(
    tui: { requestRender: () => void },
    theme: Theme,
    onClose: () => void,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.onClose = onClose;
    this.basePath = process.cwd();

    loadVisualizerData(this.basePath).then((d) => {
      this.data = d;
      this.loading = false;
      this.tui.requestRender();
    });

    this.refreshTimer = setInterval(() => {
      loadVisualizerData(this.basePath).then((d) => {
        if (this.disposed) return;
        this.data = d;
        this.invalidate();
        this.tui.requestRender();
      });
    }, 2000);
  }

  handleInput(data: string): void {
    // Filter mode input routing
    if (this.filterMode) {
      if (matchesKey(data, Key.escape)) {
        this.filterMode = false;
        this.filterText = "";
        this.invalidate();
        this.tui.requestRender();
        return;
      }
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

    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      this.dispose();
      this.onClose();
      return;
    }

    if (matchesKey(data, Key.tab)) {
      this.activeTab = (this.activeTab + 1) % TAB_COUNT;
      this.invalidate();
      this.tui.requestRender();
      return;
    }

    if ("1234567".includes(data) && data.length === 1) {
      this.activeTab = parseInt(data, 10) - 1;
      this.invalidate();
      this.tui.requestRender();
      return;
    }

    // "/" enters filter mode on Progress tab
    if (data === "/" && this.activeTab === 0) {
      this.filterMode = true;
      this.filterText = "";
      this.invalidate();
      this.tui.requestRender();
      return;
    }

    // "f" cycles filter field on Progress tab (when not in filter mode)
    if (data === "f" && this.activeTab === 0) {
      const fields: Array<"all" | "status" | "risk" | "keyword"> = ["all", "status", "risk", "keyword"];
      const idx = fields.indexOf(this.filterField);
      this.filterField = fields[(idx + 1) % fields.length];
      this.invalidate();
      this.tui.requestRender();
      return;
    }

    // Export tab key handling
    if (this.activeTab === 6 && this.data) {
      if (data === "m" || data === "j" || data === "s") {
        this.handleExportKey(data);
        return;
      }
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
      const { writeFileSync, mkdirSync } = require("node:fs");
      const { join } = require("node:path");
      const { gsdRoot } = require("./paths.js");
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
        return renderProgressView(this.data, th, width, filter);
      }
      case 1:
        return renderDepsView(this.data, th, width);
      case 2:
        return renderMetricsView(this.data, th, width);
      case 3:
        return renderTimelineView(this.data, th, width);
      case 4:
        return renderAgentView(this.data, th, width);
      case 5:
        return renderChangelogView(this.data, th, width);
      case 6:
        return renderExportView(this.data, th, width, this.lastExportPath);
      default:
        return [];
    }
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) {
      return this.cachedLines;
    }

    const th = this.theme;
    const innerWidth = width - 4;
    const content: string[] = [];

    // Tab bar
    const tabs = TAB_LABELS.map((label, i) => {
      let displayLabel = label;
      // Show filter indicator on Progress tab
      if (i === 0 && this.filterText) {
        displayLabel += " ✱";
      }
      if (i === this.activeTab) {
        return th.fg("accent", `[${displayLabel}]`);
      }
      return th.fg("dim", `[${displayLabel}]`);
    });
    content.push(" " + tabs.join(" "));
    content.push("");

    // Filter bar (when in filter mode)
    if (this.filterMode && this.activeTab === 0) {
      content.push(
        th.fg("accent", `Filter (${this.filterField}): ${this.filterText}█`),
      );
      content.push("");
    }

    if (this.loading) {
      const loadingText = "Loading…";
      const vis = visibleWidth(loadingText);
      const leftPad = Math.max(0, Math.floor((innerWidth - vis) / 2));
      content.push(" ".repeat(leftPad) + loadingText);
    } else if (this.data) {
      const viewLines = this.renderTabContent(this.activeTab, innerWidth);

      // Show export status message if present
      if (this.exportStatus && this.activeTab === 6) {
        content.push(th.fg("success", this.exportStatus));
        content.push("");
        this.exportStatus = undefined;
      }

      content.push(...viewLines);
    }

    // Apply scroll
    const viewportHeight = Math.max(5, process.stdout.rows ? process.stdout.rows - 8 : 24);
    const chromeHeight = 2;
    const visibleContentRows = Math.max(1, viewportHeight - chromeHeight);
    const maxScroll = Math.max(0, content.length - visibleContentRows);
    this.scrollOffsets[this.activeTab] = Math.min(this.scrollOffsets[this.activeTab], maxScroll);
    const offset = this.scrollOffsets[this.activeTab];
    const visibleContent = content.slice(offset, offset + visibleContentRows);

    const lines = this.wrapInBox(visibleContent, width);

    // Footer hint
    const hint = th.fg("dim", "Tab/1-7 switch · / filter · ↑↓ scroll · g/G top/end · esc close");
    const hintVis = visibleWidth(hint);
    const hintPad = Math.max(0, Math.floor((width - hintVis) / 2));
    lines.push(" ".repeat(hintPad) + hint);

    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  private wrapInBox(inner: string[], width: number): string[] {
    const th = this.theme;
    const border = (s: string) => th.fg("borderAccent", s);
    const innerWidth = width - 4;
    const lines: string[] = [];
    lines.push(border("╭" + "─".repeat(width - 2) + "╮"));
    for (const line of inner) {
      const truncated = truncateToWidth(line, innerWidth);
      const padWidth = Math.max(0, innerWidth - visibleWidth(truncated));
      lines.push(border("│") + " " + truncated + " ".repeat(padWidth) + " " + border("│"));
    }
    lines.push(border("╰" + "─".repeat(width - 2) + "╯"));
    return lines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  dispose(): void {
    this.disposed = true;
    clearInterval(this.refreshTimer);
  }
}
