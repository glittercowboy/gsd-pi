import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const gsdDir = join(__dirname, "..");

// ─── Prompt-Datei ──────────────────────────────────────────────────────────

test("explore: prompts/explore.md exists", () => {
  const promptPath = join(gsdDir, "prompts", "explore.md");
  assert.ok(existsSync(promptPath), "prompts/explore.md sollte existieren");
});

test("explore: prompt enthält {{topic}} placeholder", () => {
  const promptPath = join(gsdDir, "prompts", "explore.md");
  const prompt = readFileSync(promptPath, "utf-8");
  assert.ok(prompt.includes("{{topic}}"), "Prompt braucht {{topic}} placeholder");
});

test("explore: prompt beschreibt Socratic-Prinzipien", () => {
  const promptPath = join(gsdDir, "prompts", "explore.md");
  const prompt = readFileSync(promptPath, "utf-8");
  assert.ok(
    prompt.toLowerCase().includes("one question") || prompt.toLowerCase().includes("socrat"),
    "Prompt sollte Socratic-Prinzipien beschreiben"
  );
});

test("explore: prompt beschreibt Output-Vorschläge (note, todo, seed)", () => {
  const promptPath = join(gsdDir, "prompts", "explore.md");
  const prompt = readFileSync(promptPath, "utf-8");
  assert.ok(prompt.toLowerCase().includes("note"), "Prompt sollte Note als Output erwähnen");
  assert.ok(prompt.toLowerCase().includes("todo"), "Prompt sollte Todo als Output erwähnen");
  assert.ok(prompt.toLowerCase().includes("seed"), "Prompt sollte Seed als Output erwähnen");
});

test("explore: prompt erwähnt Artifact-Pfade unter .gsd/", () => {
  const promptPath = join(gsdDir, "prompts", "explore.md");
  const prompt = readFileSync(promptPath, "utf-8");
  assert.ok(prompt.includes(".gsd/"), "Prompt sollte .gsd/ Artifact-Pfade nennen");
});

// ─── Handler-Registrierung ─────────────────────────────────────────────────

test("explore: handleExplore ist in commands-handlers.ts exportiert", () => {
  const handlersSrc = readFileSync(join(gsdDir, "commands-handlers.ts"), "utf-8");
  assert.ok(
    handlersSrc.includes("export async function handleExplore"),
    "handleExplore sollte als async function exportiert sein"
  );
});

test("explore: handleExplore akzeptiert (args, ctx, pi) Parameter", () => {
  const handlersSrc = readFileSync(join(gsdDir, "commands-handlers.ts"), "utf-8");
  const fnMatch = handlersSrc.match(/export async function handleExplore\(([^)]+)\)/);
  assert.ok(fnMatch, "handleExplore Signatur sollte gefunden werden");
  assert.ok(fnMatch![1].includes("args"), "sollte args Parameter haben");
  assert.ok(fnMatch![1].includes("ctx"), "sollte ctx Parameter haben");
  assert.ok(fnMatch![1].includes("pi"), "sollte pi Parameter haben");
});

test("explore: handleExplore dispatcht via pi.sendMessage mit triggerTurn: true", () => {
  const handlersSrc = readFileSync(join(gsdDir, "commands-handlers.ts"), "utf-8");
  const fnStart = handlersSrc.indexOf("export async function handleExplore");
  const fnEnd = handlersSrc.indexOf("\nexport ", fnStart + 1);
  const fnBody = fnEnd > 0 ? handlersSrc.slice(fnStart, fnEnd) : handlersSrc.slice(fnStart);
  assert.ok(fnBody.includes("pi.sendMessage"), "handleExplore sollte pi.sendMessage aufrufen");
  assert.ok(fnBody.includes("triggerTurn: true"), "handleExplore sollte triggerTurn: true setzen");
  assert.ok(fnBody.includes('"gsd-explore"'), "handleExplore sollte customType: 'gsd-explore' setzen");
});

test("explore: handleExplore zeigt Usage-Hinweis wenn kein Topic", () => {
  const handlersSrc = readFileSync(join(gsdDir, "commands-handlers.ts"), "utf-8");
  const fnStart = handlersSrc.indexOf("export async function handleExplore");
  const fnEnd = handlersSrc.indexOf("\nexport ", fnStart + 1);
  const fnBody = fnEnd > 0 ? handlersSrc.slice(fnStart, fnEnd) : handlersSrc.slice(fnStart);
  assert.ok(fnBody.includes("Usage"), "handleExplore sollte Usage-Hinweis für leeres Topic ausgeben");
  assert.ok(fnBody.includes("ctx.ui.notify"), "handleExplore sollte ctx.ui.notify für Warnungen nutzen");
});

// ─── Routing (ops.ts) ──────────────────────────────────────────────────────

test("explore: ops.ts importiert handleExplore aus commands-handlers", () => {
  const opsSrc = readFileSync(join(gsdDir, "commands", "handlers", "ops.ts"), "utf-8");
  assert.ok(opsSrc.includes("handleExplore"), "ops.ts sollte handleExplore importieren");
});

test('explore: ops.ts leitet "explore" an handleExplore weiter', () => {
  const opsSrc = readFileSync(join(gsdDir, "commands", "handlers", "ops.ts"), "utf-8");
  assert.ok(
    opsSrc.includes('"explore"') || opsSrc.includes("explore "),
    'ops.ts sollte auf "explore" prüfen'
  );
  assert.ok(opsSrc.includes("handleExplore("), "ops.ts sollte handleExplore aufrufen");
});

// ─── Command-Catalog ───────────────────────────────────────────────────────

test("explore: catalog.ts enthält explore in TOP_LEVEL_SUBCOMMANDS", () => {
  const catalogSrc = readFileSync(join(gsdDir, "commands", "catalog.ts"), "utf-8");
  assert.ok(catalogSrc.includes('"explore"'), 'catalog.ts sollte "explore" enthalten');
});

// ─── explore-artifacts.ts ─────────────────────────────────────────────────

test("explore: explore-artifacts.ts existiert", () => {
  assert.ok(existsSync(join(gsdDir, "explore-artifacts.ts")), "explore-artifacts.ts sollte existieren");
});

test("explore: explore-artifacts.ts exportiert writeExploreNote", () => {
  const src = readFileSync(join(gsdDir, "explore-artifacts.ts"), "utf-8");
  assert.ok(src.includes("writeExploreNote"), "sollte writeExploreNote exportieren");
});

test("explore: explore-artifacts.ts exportiert writeExploreTodo", () => {
  const src = readFileSync(join(gsdDir, "explore-artifacts.ts"), "utf-8");
  assert.ok(src.includes("writeExploreTodo"), "sollte writeExploreTodo exportieren");
});

test("explore: explore-artifacts.ts exportiert writeExploreSeed", () => {
  const src = readFileSync(join(gsdDir, "explore-artifacts.ts"), "utf-8");
  assert.ok(src.includes("writeExploreSeed"), "sollte writeExploreSeed exportieren");
});

test("explore: explore-artifacts.ts exportiert appendExploreResearchQuestion", () => {
  const src = readFileSync(join(gsdDir, "explore-artifacts.ts"), "utf-8");
  assert.ok(src.includes("appendExploreResearchQuestion"), "sollte appendExploreResearchQuestion exportieren");
});

test("explore: writeExploreNote schreibt unter .gsd/notes/", () => {
  const src = readFileSync(join(gsdDir, "explore-artifacts.ts"), "utf-8");
  assert.ok(src.includes("notes"), "sollte .gsd/notes/ Pfad nutzen");
});

test("explore: writeExploreSeed schreibt unter .gsd/seeds/", () => {
  const src = readFileSync(join(gsdDir, "explore-artifacts.ts"), "utf-8");
  assert.ok(src.includes("seeds"), "sollte .gsd/seeds/ Pfad nutzen");
});

test("explore: appendExploreResearchQuestion schreibt in .gsd/research/questions.md", () => {
  const src = readFileSync(join(gsdDir, "explore-artifacts.ts"), "utf-8");
  assert.ok(
    src.includes("research") && src.includes("questions"),
    "sollte .gsd/research/questions.md nutzen"
  );
});
