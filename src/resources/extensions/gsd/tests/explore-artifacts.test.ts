import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Wir importieren direkt die .ts-Quelldatei (Node unterstützt das via --import tsx oder ts-node)
// Da die Tests im Projekt bereits mit TypeScript laufen, nutzen wir den gleichen Mechanismus

import {
  toSlug,
  writeExploreNote,
  writeExploreTodo,
  writeExploreSeed,
  appendExploreResearchQuestion,
} from "../explore-artifacts.ts";

function makeTempDir(prefix: string): string {
  const dir = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ─── toSlug ──────────────────────────────────────────────────────────────────

test("explore-artifacts: toSlug konvertiert Topic zu Dateinamen-Slug", () => {
  assert.strictEqual(toSlug("Hello World!"), "hello-world");
  assert.strictEqual(toSlug("Distributed Systems"), "distributed-systems");
  assert.strictEqual(toSlug("  spaces  "), "spaces");
});

test("explore-artifacts: toSlug schneidet nach 60 Zeichen ab", () => {
  const long = "a".repeat(100);
  assert.ok(toSlug(long).length <= 60, "Slug sollte max 60 Zeichen haben");
});

test("explore-artifacts: toSlug gibt 'untitled' zurück wenn Topic nur Sonderzeichen hat", () => {
  assert.strictEqual(toSlug("!!!@@@###"), "untitled");
  assert.strictEqual(toSlug("   "), "untitled");
  assert.strictEqual(toSlug(""), "untitled");
});

// ─── writeExploreNote ────────────────────────────────────────────────────────

test("explore-artifacts: writeExploreNote erstellt .gsd/notes/<slug>.md", (t) => {
  const tmp = makeTempDir("note");
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const relPath = writeExploreNote(tmp, "Test Topic", "# Test\n\nContent");
  assert.ok(existsSync(join(tmp, ".gsd", "notes", "test-topic.md")));
  assert.strictEqual(relPath, ".gsd/notes/test-topic.md");
  const content = readFileSync(join(tmp, ".gsd", "notes", "test-topic.md"), "utf-8");
  assert.ok(content.includes("# Test"));
});

test("explore-artifacts: writeExploreNote erstellt notes-Verzeichnis wenn nötig", (t) => {
  const tmp = makeTempDir("note-create");
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  assert.ok(!existsSync(join(tmp, ".gsd", "notes")));
  writeExploreNote(tmp, "My Topic", "content");
  assert.ok(existsSync(join(tmp, ".gsd", "notes")));
});

// ─── writeExploreTodo ────────────────────────────────────────────────────────

test("explore-artifacts: writeExploreTodo erstellt .gsd/todos/<slug>.md", (t) => {
  const tmp = makeTempDir("todo");
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const relPath = writeExploreTodo(tmp, "Fix the bug", "# Todo\n\nDo this.");
  assert.ok(existsSync(join(tmp, ".gsd", "todos", "fix-the-bug.md")));
  assert.strictEqual(relPath, ".gsd/todos/fix-the-bug.md");
  const content = readFileSync(join(tmp, ".gsd", "todos", "fix-the-bug.md"), "utf-8");
  assert.ok(content.includes("# Todo"), "Inhalt sollte geschrieben sein");
  assert.ok(content.includes("Do this."), "Inhalt sollte den Todo-Text enthalten");
});

// ─── writeExploreSeed ────────────────────────────────────────────────────────

test("explore-artifacts: writeExploreSeed erstellt .gsd/seeds/<slug>.md", (t) => {
  const tmp = makeTempDir("seed");
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const relPath = writeExploreSeed(tmp, "New Idea", "# Seed\n\nIdea content.");
  assert.ok(existsSync(join(tmp, ".gsd", "seeds", "new-idea.md")));
  assert.strictEqual(relPath, ".gsd/seeds/new-idea.md");
  const content = readFileSync(join(tmp, ".gsd", "seeds", "new-idea.md"), "utf-8");
  assert.ok(content.includes("# Seed"), "Inhalt sollte geschrieben sein");
  assert.ok(content.includes("Idea content."), "Inhalt sollte den Seed-Text enthalten");
});

// ─── appendExploreResearchQuestion ───────────────────────────────────────────

test("explore-artifacts: appendExploreResearchQuestion erstellt questions.md wenn nicht vorhanden", (t) => {
  const tmp = makeTempDir("rq");
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  appendExploreResearchQuestion(tmp, "Was ist die Frage?", "Context here");

  const filePath = join(tmp, ".gsd", "research", "questions.md");
  assert.ok(existsSync(filePath));
  const content = readFileSync(filePath, "utf-8");
  assert.ok(content.includes("# Research Questions"));
  assert.ok(content.includes("Was ist die Frage?"));
  assert.ok(content.includes("Context here"));
  assert.ok(content.includes("**Added:**"), "Entry sollte Added-Timestamp haben");
});

test("explore-artifacts: appendExploreResearchQuestion appendet zu existierender Datei", (t) => {
  const tmp = makeTempDir("rq-append");
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  appendExploreResearchQuestion(tmp, "Erste Frage", "Kontext A");
  appendExploreResearchQuestion(tmp, "Zweite Frage", "Kontext B");

  const content = readFileSync(join(tmp, ".gsd", "research", "questions.md"), "utf-8");
  assert.ok(content.includes("Erste Frage"));
  assert.ok(content.includes("Zweite Frage"));
  const headerCount = (content.match(/# Research Questions/g) || []).length;
  assert.strictEqual(headerCount, 1, "Header sollte nur einmal vorkommen");
});
