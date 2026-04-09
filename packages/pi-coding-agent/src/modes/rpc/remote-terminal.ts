import type { Terminal } from "@gsd/pi-tui";

export interface RemoteTerminalOptions {
	onWrite: (data: string) => void;
	initialColumns?: number;
	initialRows?: number;
}

/**
 * Browser-backed terminal transport for the bridge-hosted native TUI.
 * It implements the pi-tui Terminal contract but forwards output over the
 * RPC bridge instead of writing to process stdout.
 */
export class RemoteTerminal implements Terminal {
	private inputHandler?: (data: string) => void;
	private resizeHandler?: () => void;
	private _columns: number;
	private _rows: number;

	constructor(private readonly options: RemoteTerminalOptions) {
		this._columns = Math.max(1, options.initialColumns ?? 120);
		this._rows = Math.max(1, options.initialRows ?? 30);
	}

	start(onInput: (data: string) => void, onResize: () => void): void {
		this.inputHandler = onInput;
		this.resizeHandler = onResize;
	}

	stop(): void {
		this.inputHandler = undefined;
		this.resizeHandler = undefined;
	}

	async drainInput(): Promise<void> {
		// Browser transport has no local stdin buffer to drain.
	}

	write(data: string): void {
		if (!data) return;
		this.options.onWrite(data);
	}

	get columns(): number {
		return this._columns;
	}

	get rows(): number {
		return this._rows;
	}

	get isTTY(): boolean {
		// RemoteTerminal renders to a browser-based terminal emulator via
		// the RPC bridge — it behaves like a real TTY for rendering purposes.
		return true;
	}

	get kittyProtocolActive(): boolean {
		return false;
	}

	pushInput(data: string): void {
		if (!data) return;
		this.inputHandler?.(data);
	}

	resize(columns: number, rows: number): void {
		const nextColumns = Math.max(1, Math.floor(columns));
		const nextRows = Math.max(1, Math.floor(rows));
		const changed = nextColumns !== this._columns || nextRows !== this._rows;
		this._columns = nextColumns;
		this._rows = nextRows;
		if (changed) {
			this.resizeHandler?.();
		}
	}

	moveBy(lines: number): void {
		if (lines > 0) {
			this.write(`\x1b[${lines}B`);
		} else if (lines < 0) {
			this.write(`\x1b[${-lines}A`);
		}
	}

	hideCursor(): void {
		this.write("\x1b[?25l");
	}

	showCursor(): void {
		this.write("\x1b[?25h");
	}

	clearLine(): void {
		this.write("\x1b[K");
	}

	clearFromCursor(): void {
		this.write("\x1b[J");
	}

	clearScreen(): void {
		this.write("\x1b[2J\x1b[H");
	}

	setTitle(title: string): void {
		this.write(`\x1b]0;${title}\x07`);
	}
}
