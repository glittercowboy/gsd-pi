import type { TUI } from "../tui.js";
import { Text } from "./text.js";

/**
 * Loader component that updates every 80ms with spinning animation.
 * Frame rotation is isolated from message text to avoid invalidating
 * Text's render cache (wrapTextWithAnsi, visibleWidth) on every tick.
 */
export class Loader extends Text {
	private frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
	private currentFrame = 0;
	private intervalId: NodeJS.Timeout | null = null;
	private ui: TUI | null = null;
	private _lastMessage: string = "";

	constructor(
		ui: TUI,
		private spinnerColorFn: (str: string) => string,
		private messageColorFn: (str: string) => string,
		private message: string = "Loading...",
	) {
		super("", 1, 0);
		this.ui = ui;
		this.start();
	}

	render(width: number): string[] {
		// Only update Text content when message actually changes —
		// frame rotation is prepended below without touching the cache
		if (this.message !== this._lastMessage) {
			this.setText(this.messageColorFn(this.message));
			this._lastMessage = this.message;
		}
		const messageLines = super.render(width);
		// Shallow copy so we don't mutate cachedLines from Text
		const result = ["", ...messageLines];
		// Prepend spinner frame to first content line
		if (result.length > 1) {
			const frame = this.frames[this.currentFrame];
			result[1] = this.spinnerColorFn(frame) + " " + result[1];
		}
		return result;
	}

	start() {
		if (this.intervalId) {
			clearInterval(this.intervalId);
		}
		this.currentFrame = 0;
		this.intervalId = setInterval(() => {
			this.currentFrame = (this.currentFrame + 1) % this.frames.length;
			if (this.ui) {
				this.ui.requestRender();
			}
		}, 80);
		// Trigger initial render
		if (this.ui) {
			this.ui.requestRender();
		}
	}

	stop() {
		if (this.intervalId) {
			clearInterval(this.intervalId);
			this.intervalId = null;
		}
	}

	dispose() {
		this.stop();
		this.ui = null;
	}

	setMessage(message: string) {
		this.message = message;
		if (this.ui) {
			this.ui.requestRender();
		}
	}
}
