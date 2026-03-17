/**
 * Animation component tests (Phase 07 Plans 01 + 03).
 *
 * Tests LogoAnimationView (600ms sequential build), LoadingLogo (scan line),
 * SingleColumnView (fade-in on view switch), ChatMessage (slide-up),
 * and task-advance-pulse CSS availability.
 * Pattern: Direct function call + JSON.stringify inspection.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { LogoAnimationView } from "../src/components/session/LogoAnimation";
import { LoadingLogo } from "../src/components/session/LoadingLogo";
import { SingleColumnView } from "../src/components/layout/SingleColumnView";
import { ChatMessage } from "../src/components/chat/ChatMessage";

// -- LogoAnimationView (pure render, no hooks) --

describe("LogoAnimationView", () => {
  it("renders an img element pointing to the official GSD logo asset", () => {
    const result = LogoAnimationView({});
    const json = JSON.stringify(result);
    expect(json).toContain("img");
    // Plan 20.1-01: logo changed to PNG mission-control asset
    expect(json).toContain("gsd-2-mission-control-logo.png");
  });

  it("applies lg size class by default", () => {
    const result = LogoAnimationView({});
    const json = JSON.stringify(result);
    // Plan 20.1-01: lg uses w-80 h-auto (wide brand asset)
    expect(json).toContain("w-80");
    expect(json).toContain("h-auto");
  });

  it("applies sm size class when specified", () => {
    const result = LogoAnimationView({ size: "sm" });
    const json = JSON.stringify(result);
    expect(json).toContain("h-8");
    expect(json).toContain("w-8");
  });

  it("has alt text for accessibility", () => {
    const result = LogoAnimationView({});
    const json = JSON.stringify(result);
    expect(json).toContain("GSD Logo");
  });
});

// -- LoadingLogo --

describe("LoadingLogo", () => {
  it("renders an img element pointing to the terminal.svg asset", () => {
    const result = LoadingLogo({});
    const json = JSON.stringify(result);
    expect(json).toContain("img");
    expect(json).toContain("terminal.svg");
  });

  it("includes animate-pulse class for loading indication", () => {
    const result = LoadingLogo({});
    const json = JSON.stringify(result);
    expect(json).toContain("animate-pulse");
  });

  it("has alt text for accessibility", () => {
    const result = LoadingLogo({});
    const json = JSON.stringify(result);
    expect(json).toContain("Loading");
  });
});

// -- SingleColumnView (Plan 03: fade-in on view switch) --

describe("SingleColumnView", () => {
  it("wraps content with animate-in fade-in classes and uses activeView.kind as key", () => {
    const result = SingleColumnView({
      activeView: { kind: "chat" },
      planningState: null,
      chatMessages: [],
      onChatSend: () => {},
      isChatProcessing: false,
    });
    const json = JSON.stringify(result);
    expect(json).toContain("animate-in");
    expect(json).toContain("fade-in");
    expect(json).toContain("duration-200");
    // The key should be the view kind for React re-mount
    expect(json).toContain('"key":"chat"');
  });

  it("uses different key for different views", () => {
    const chatResult = SingleColumnView({
      activeView: { kind: "chat" },
      planningState: null,
      chatMessages: [],
      onChatSend: () => {},
      isChatProcessing: false,
    });
    const milestoneResult = SingleColumnView({
      activeView: { kind: "milestone" },
      planningState: null,
      chatMessages: [],
      onChatSend: () => {},
      isChatProcessing: false,
    });
    const chatJson = JSON.stringify(chatResult);
    const milestoneJson = JSON.stringify(milestoneResult);
    expect(chatJson).toContain('"key":"chat"');
    expect(milestoneJson).toContain('"key":"milestone"');
  });
});

// -- ChatMessage (Plan 03: slide-up animation) --

describe("ChatMessage", () => {
  it("has slide-in-from-bottom animation class", () => {
    const result = ChatMessage({
      message: { role: "user", content: "hello", streaming: false },
    });
    const json = JSON.stringify(result);
    expect(json).toContain("animate-in");
    expect(json).toContain("fade-in");
    expect(json).toContain("slide-in-from-bottom");
    expect(json).toContain("duration-75");
  });

  it("applies animation to all message roles", () => {
    for (const role of ["user", "assistant", "system"] as const) {
      const result = ChatMessage({
        message: { role, content: "test", streaming: false },
      });
      const json = JSON.stringify(result);
      expect(json).toContain("slide-in-from-bottom");
    }
  });
});


// -- task-advance-pulse CSS class (Plan 03) --

describe("task-advance-pulse CSS", () => {
  it("task-advance-pulse class is defined in animations.css", () => {
    const cssPath = join(__dirname, "../src/styles/animations.css");
    const css = readFileSync(cssPath, "utf-8");
    expect(css).toContain(".task-advance-pulse");
    expect(css).toContain("amber-pulse");
  });
});
