/**
 * Simple text input component for extensions.
 */

import { Container, type Focusable, getKeybindings, Input, Spacer, Text, type TUI } from "@gsd/pi-tui";

// vendor-seam: dual-module-path -- Input from pi-tui exposes secure/placeholder at runtime
// but the pi-tui type declarations don't include them. Extension interface bridges the gap.
interface GSDInputExtension {
	secure?: boolean;
	placeholder?: string;
}
import { theme } from "../../../theme.js";
import { CountdownTimer } from "./countdown-timer.js";
import { DynamicBorder } from "./dynamic-border.js";
import { keyHint } from "./keybinding-hints.js";

export interface ExtensionInputOptions {
	tui?: TUI;
	timeout?: number;
	secure?: boolean;
}

export class ExtensionInputComponent extends Container implements Focusable {
	private input: Input;
	private onSubmitCallback: (value: string) => void;
	private onCancelCallback: () => void;
	private titleText: Text;
	private baseTitle: string;
	private countdown: CountdownTimer | undefined;

	// Focusable implementation - propagate to input for IME cursor positioning
	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value;
	}

	constructor(
		title: string,
		placeholder: string | undefined,
		onSubmit: (value: string) => void,
		onCancel: () => void,
		opts?: ExtensionInputOptions,
	) {
		super();

		this.onSubmitCallback = onSubmit;
		this.onCancelCallback = onCancel;
		this.baseTitle = title;

		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));

		this.titleText = new Text(theme.fg("accent", title), 1, 0);
		this.addChild(this.titleText);
		this.addChild(new Spacer(1));

		if (opts?.timeout && opts.timeout > 0 && opts.tui) {
			this.countdown = new CountdownTimer(
				opts.timeout,
				opts.tui,
				(s) => this.titleText.setText(theme.fg("accent", `${this.baseTitle} (${s}s)`)),
				() => this.onCancelCallback(),
			);
		}

		this.input = new Input();
		const extInput = this.input as unknown as GSDInputExtension;
		extInput.secure = opts?.secure === true;
		if (placeholder) {
			extInput.placeholder = placeholder;
		}
		this.addChild(this.input);
		this.addChild(new Spacer(1));
		this.addChild(new Text(`${keyHint("tui.select.confirm", "submit")}  ${keyHint("tui.select.cancel", "cancel")}`, 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		if (kb.matches(keyData, "tui.select.confirm") || keyData === "\n") {
			if (this.input.getValue().trim() === "") return;
			this.onSubmitCallback(this.input.getValue());
		} else if (kb.matches(keyData, "tui.select.cancel")) {
			this.onCancelCallback();
		} else {
			this.input.handleInput(keyData);
		}
	}

	dispose(): void {
		this.countdown?.dispose();
	}
}
