import type { Component, TUI } from "@gsd/pi-tui";
import { visibleWidth } from "@gsd/pi-tui";
import { theme } from "../theme/theme.js";

/**
 * Dynamic border component that adjusts to viewport width.
 * Supports an optional animated spinner in the label area.
 *
 * Note: When used from extensions loaded via jiti, the global `theme` may be undefined
 * because jiti creates a separate module cache. Always pass an explicit color
 * function when using DynamicBorder in components exported for extension use.
 */
export class DynamicBorder implements Component {
	private color: (str: string) => string;
	private label?: string;
	private spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
	private spinnerIndex = 0;
	private spinnerInterval: NodeJS.Timeout | null = null;
	private spinnerColorFn?: (str: string) => string;
	private lastExternalRender = 0;

	constructor(color: (str: string) => string = (str) => {
		try { return theme.fg("border", str); } catch { return str; }
	}, label?: string) {
		this.color = color;
		this.label = label;
	}

	setLabel(label: string | undefined): void {
		this.label = label;
	}

	/**
	 * Start an animated spinner that prepends to the label.
	 * The spinner rotates every 200ms and triggers a re-render via the TUI.
	 */
	startSpinner(ui: TUI, colorFn: (str: string) => string): void {
		this.stopSpinner();
		this.spinnerColorFn = colorFn;
		this.spinnerIndex = 0;
		this.spinnerInterval = setInterval(() => {
			this.spinnerIndex = (this.spinnerIndex + 1) % this.spinnerFrames.length;
			// Only trigger standalone render if no other source rendered recently.
			// During active streaming, message_update already calls requestRender().
			if (Date.now() - this.lastExternalRender > 200) {
				ui.requestRender();
			}
		}, 200);
		ui.requestRender();
	}

	/**
	 * Stop the spinner animation. The border reverts to a static label.
	 */
	stopSpinner(): void {
		if (this.spinnerInterval) {
			clearInterval(this.spinnerInterval);
			this.spinnerInterval = null;
		}
		this.spinnerColorFn = undefined;
	}

	get isSpinning(): boolean {
		return this.spinnerInterval !== null;
	}

	invalidate(): void {
		// No cached state to invalidate currently
	}

	render(width: number): string[] {
		this.lastExternalRender = Date.now();
		const spinnerPrefix = this.spinnerInterval && this.spinnerColorFn
			? this.spinnerColorFn(this.spinnerFrames[this.spinnerIndex]) + " "
			: "";

		if (this.label) {
			const labelText = ` ${spinnerPrefix}${this.label} `;
			const labelVisible = visibleWidth(labelText);
			const leading = "── ";
			const remaining = Math.max(0, width - labelVisible - leading.length);
			const trailing = "─".repeat(Math.max(1, remaining));
			// Color leading and trailing separately so embedded ANSI in the
			// spinner/label doesn't bleed into the trailing dashes.
			return [this.color(leading) + labelText + this.color(trailing)];
		}
		return [this.color("─".repeat(Math.max(1, width)))];
	}
}
