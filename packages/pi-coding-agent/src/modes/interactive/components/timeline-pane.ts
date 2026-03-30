/**
 * TimelinePane - transparent wrapper that merges chatContainer, pendingMessagesContainer,
 * and statusContainer into a single ScrollableContainer.
 *
 * This is a transparent wrapper: the three containers are exposed as public properties
 * so interactive-mode.ts can continue adding/removing children to them identically.
 * TimelinePane just renders all three in sequence inside a scrollable viewport.
 */

import type { MouseEvent } from "@gsd/pi-tui";
import { Container, ScrollableContainer } from "@gsd/pi-tui";
import type { Component } from "@gsd/pi-tui";

export class TimelinePane implements Component {
	readonly wantsMouse = true as const;

	/** Chat messages — callers add/remove children here directly */
	readonly chatContainer: Container;
	/** Queued follow-up messages — callers add/remove children here directly */
	readonly pendingMessagesContainer: Container;
	/** Working/compacting loaders — callers add/remove children here directly */
	readonly statusContainer: Container;

	private scrollable: ScrollableContainer;

	/**
	 * If the three containers are provided, they are used as-is (transparent wrapper).
	 * If omitted, new Containers are created.
	 */
	constructor(
		chatContainer?: Container,
		pendingMessagesContainer?: Container,
		statusContainer?: Container,
	) {
		this.chatContainer = chatContainer ?? new Container();
		this.pendingMessagesContainer = pendingMessagesContainer ?? new Container();
		this.statusContainer = statusContainer ?? new Container();

		// One outer container that holds all three in order: chat → pending → status
		const outer = new Container();
		outer.addChild(this.chatContainer);
		outer.addChild(this.pendingMessagesContainer);
		outer.addChild(this.statusContainer);

		// ScrollableContainer wraps the outer container's content.
		// We bypass ScrollableContainer's own addChild API here because we need the
		// three inner containers to be the canonical objects (transparent wrapper).
		// ScrollableContainer delegates to an internal Container; we replace that by
		// adding outer as a child so all three containers participate in scroll math.
		this.scrollable = new ScrollableContainer();
		this.scrollable.addChild(outer);
	}

	render(width: number, height?: number): string[] {
		return this.scrollable.render(width, height);
	}

	invalidate(): void {
		this.scrollable.invalidate();
	}

	handleMouse(event: MouseEvent): void {
		this.scrollable.handleMouse(event);
	}
}
