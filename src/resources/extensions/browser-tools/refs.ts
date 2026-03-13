/**
 * browser-tools — ref snapshot and resolution
 *
 * Builds deterministic element snapshots and resolves ref targets.
 * Uses window.__pi.* utilities injected via addInitScript (from
 * evaluate-helpers.ts) instead of redeclaring functions inline.
 *
 * Functions kept inline (not shared/duplicated):
 *   - matchesMode, computeNearestHeading, computeFormOwnership
 */

import type { Frame, Page } from "playwright";
import type { RefNode } from "./state.js";
import { getSnapshotModeConfig } from "./core.js";

// ---------------------------------------------------------------------------
// buildRefSnapshot
// ---------------------------------------------------------------------------

export async function buildRefSnapshot(
	target: Page | Frame,
	options: { selector?: string; interactiveOnly: boolean; limit: number; mode?: string },
): Promise<Array<Omit<RefNode, "ref">>> {
	// Resolve mode config in Node context and serialize it as plain data for the evaluate callback
	const modeConfig = options.mode ? getSnapshotModeConfig(options.mode) : null;
	return await target.evaluate(({ selector, interactiveOnly, limit, modeConfig: mc }) => {
		const root = selector ? document.querySelector(selector) : document.body;
		if (!root) {
			throw new Error(`Selector scope not found: ${selector}`);
		}

		// Use injected window.__pi utilities
		const pi = (window as any).__pi;
		const simpleHash = pi.simpleHash;
		const isVisible = pi.isVisible;
		const isEnabled = pi.isEnabled;
		const inferRole = pi.inferRole;
		const accessibleName = pi.accessibleName;
		const isInteractiveEl = pi.isInteractiveEl;
		const cssPath = pi.cssPath;
		const domPath = pi.domPath;
		const selectorHints = pi.selectorHints;

		// Mode-based element matching — used when a snapshot mode config is provided
		const matchesMode = (el: Element, cfg: { tags: string[]; roles: string[]; selectors: string[]; ariaAttributes: string[] }): boolean => {
			const tag = el.tagName.toLowerCase();
			if (cfg.tags.length > 0 && cfg.tags.includes(tag)) return true;
			const role = inferRole(el);
			if (cfg.roles.length > 0 && cfg.roles.includes(role)) return true;
			for (const sel of cfg.selectors) {
				try { if (el.matches(sel)) return true; } catch { /* invalid selector, skip */ }
			}
			for (const attr of cfg.ariaAttributes) {
				if (el.hasAttribute(attr)) return true;
			}
			return false;
		};

		let elements = Array.from(root.querySelectorAll("*"));

		if (mc) {
			// Mode takes precedence over interactiveOnly
			if (mc.visibleOnly) {
				// visible_only mode: include all elements that are visible
				elements = elements.filter((el) => isVisible(el));
			} else if (mc.useInteractiveFilter) {
				// interactive mode: reuse existing isInteractiveEl
				elements = elements.filter((el) => isInteractiveEl(el));
			} else if (mc.containerExpand) {
				// Container-expanding modes (dialog, errors): match containers, then include
				// all interactive children of those containers, plus the containers themselves
				const containers: Element[] = [];
				const directMatches: Element[] = [];
				for (const el of elements) {
					if (matchesMode(el, mc)) {
						// Check if this is a container element (has children)
						const childEls = el.querySelectorAll("*");
						if (childEls.length > 0) {
							containers.push(el);
						} else {
							directMatches.push(el);
						}
					}
				}
				// Collect container elements + all interactive children inside containers
				const result = new Set<Element>(directMatches);
				for (const container of containers) {
					result.add(container);
					const children = Array.from(container.querySelectorAll("*"));
					for (const child of children) {
						if (isInteractiveEl(child)) result.add(child);
					}
				}
				elements = Array.from(result);
			} else {
				// Standard mode filtering by tag/role/selector/ariaAttribute
				elements = elements.filter((el) => matchesMode(el, mc));
			}
		} else if (!interactiveOnly) {
			if (root instanceof Element) elements.unshift(root);
		} else {
			elements = elements.filter((el) => isInteractiveEl(el));
		}

		const seen = new Set<Element>();
		const unique = elements.filter((el) => {
			if (seen.has(el)) return false;
			seen.add(el);
			return true;
		});

		// Fingerprint helpers — computed for each element in the snapshot
		const computeNearestHeading = (el: Element): string => {
			const headingTags = new Set(["H1", "H2", "H3", "H4", "H5", "H6"]);
			// Walk up ancestors looking for heading or preceding-sibling heading
			let current: Element | null = el;
			while (current && current !== document.body) {
				// Check preceding siblings of current
				let sib: Element | null = current.previousElementSibling;
				while (sib) {
					if (headingTags.has(sib.tagName) || sib.getAttribute("role") === "heading") {
						return (sib.textContent || "").trim().replace(/\s+/g, " ").slice(0, 80);
					}
					sib = sib.previousElementSibling;
				}
				// Check if the parent itself is a heading (unlikely but possible)
				const parent = current.parentElement;
				if (parent && (headingTags.has(parent.tagName) || parent.getAttribute("role") === "heading")) {
					return (parent.textContent || "").trim().replace(/\s+/g, " ").slice(0, 80);
				}
				current = parent;
			}
			return "";
		};

		const computeFormOwnership = (el: Element): string => {
			// Check form attribute (explicit form association)
			const formAttr = el.getAttribute("form");
			if (formAttr) return formAttr;
			// Walk up ancestors looking for <form>
			let current: Element | null = el.parentElement;
			while (current && current !== document.body) {
				if (current.tagName === "FORM") {
					return (current as HTMLFormElement).id || (current as HTMLFormElement).name || "form";
				}
				current = current.parentElement;
			}
			return "";
		};

		return unique.slice(0, limit).map((el) => {
			const tag = el.tagName.toLowerCase();
			const role = inferRole(el);
			const textContent = (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 200);
			const childTags = Array.from(el.children).map((c) => c.tagName.toLowerCase());

			return {
				tag,
				role,
				name: accessibleName(el),
				selectorHints: selectorHints(el),
				isVisible: isVisible(el),
				isEnabled: isEnabled(el),
				xpathOrPath: cssPath(el),
				href: el.getAttribute("href") || undefined,
				type: el.getAttribute("type") || undefined,
				path: domPath(el),
				contentHash: simpleHash(textContent),
				structuralSignature: simpleHash(`${tag}|${role}|${childTags.join(",")}`),
				nearestHeading: computeNearestHeading(el),
				formOwnership: computeFormOwnership(el),
			};
		});
	}, { ...options, modeConfig });
}

// ---------------------------------------------------------------------------
// resolveRefTarget
// ---------------------------------------------------------------------------

export async function resolveRefTarget(
	target: Page | Frame,
	node: RefNode,
): Promise<{ ok: true; selector: string } | { ok: false; reason: string }> {
	return await target.evaluate((refNode) => {
		// Use injected window.__pi utilities
		const pi = (window as any).__pi;
		const cssPath = pi.cssPath;
		const simpleHash = pi.simpleHash;

		const byPath = (): Element | null => {
			let current: Element | null = document.documentElement;
			for (const idx of refNode.path || []) {
				if (!current || idx < 0 || idx >= current.children.length) return null;
				current = current.children[idx] as Element;
			}
			return current;
		};

		const nodeName = (el: Element): string => {
			return (
				el.getAttribute("aria-label")?.trim() ||
				(el as HTMLInputElement).value?.trim() ||
				el.getAttribute("placeholder")?.trim() ||
				(el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 80)
			);
		};

		// Tier 1: path-based resolution
		const pathEl = byPath();
		if (pathEl && pathEl.tagName.toLowerCase() === refNode.tag) {
			return { ok: true as const, selector: cssPath(pathEl) };
		}

		// Tier 2: selector hints
		for (const hint of refNode.selectorHints || []) {
			try {
				const el = document.querySelector(hint);
				if (!el) continue;
				if (el.tagName.toLowerCase() !== refNode.tag) continue;
				return { ok: true as const, selector: cssPath(el) };
			} catch {
				// ignore malformed selector hint
			}
		}

		// Tier 3: role + name match
		const candidates = Array.from(document.querySelectorAll(refNode.tag));
		const matchTarget = candidates.find((el) => {
			const role = el.getAttribute("role") || "";
			const name = nodeName(el);
			const roleMatch = !refNode.role || role === refNode.role;
			const nameMatch = !!refNode.name && name.toLowerCase() === refNode.name.toLowerCase();
			return roleMatch && nameMatch;
		});
		if (matchTarget) {
			return { ok: true as const, selector: cssPath(matchTarget) };
		}

		// Tier 4: structural signature + content hash fingerprint matching
		if (refNode.contentHash && refNode.structuralSignature) {
			const fpMatches: Element[] = [];
			for (const candidate of candidates) {
				const tag = candidate.tagName.toLowerCase();
				const role = candidate.getAttribute("role") || "";
				const textContent = (candidate.textContent || "").trim().replace(/\s+/g, " ").slice(0, 200);
				const childTags = Array.from(candidate.children).map((c) => c.tagName.toLowerCase());
				const candidateContentHash = simpleHash(textContent);
				const candidateStructSig = simpleHash(`${tag}|${role}|${childTags.join(",")}`);
				if (candidateContentHash === refNode.contentHash && candidateStructSig === refNode.structuralSignature) {
					fpMatches.push(candidate);
				}
			}
			if (fpMatches.length === 1) {
				return { ok: true as const, selector: cssPath(fpMatches[0]) };
			}
			if (fpMatches.length > 1) {
				return { ok: false as const, reason: "multiple fingerprint matches — ambiguous" };
			}
		}

		return { ok: false as const, reason: "element not found in current DOM" };
	}, node);
}
