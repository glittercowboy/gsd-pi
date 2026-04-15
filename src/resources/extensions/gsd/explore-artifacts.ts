import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { gsdRoot } from "./paths.js";

export function toSlug(topic: string): string {
  const slug = topic
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 60);
  return slug || "untitled";
}

export function writeExploreNote(basePath: string, topic: string, content: string): string {
  const notesDir = join(gsdRoot(basePath), "notes");
  mkdirSync(notesDir, { recursive: true });
  const slug = toSlug(topic);
  const filename = `${slug}.md`;
  writeFileSync(join(notesDir, filename), content, "utf-8");
  return `.gsd/notes/${filename}`;
}

export function writeExploreTodo(basePath: string, topic: string, content: string): string {
  const todosDir = join(gsdRoot(basePath), "todos");
  mkdirSync(todosDir, { recursive: true });
  const slug = toSlug(topic);
  const filename = `${slug}.md`;
  writeFileSync(join(todosDir, filename), content, "utf-8");
  return `.gsd/todos/${filename}`;
}

export function writeExploreSeed(basePath: string, topic: string, content: string): string {
  const seedsDir = join(gsdRoot(basePath), "seeds");
  mkdirSync(seedsDir, { recursive: true });
  const slug = toSlug(topic);
  const filename = `${slug}.md`;
  writeFileSync(join(seedsDir, filename), content, "utf-8");
  return `.gsd/seeds/${filename}`;
}

export function appendExploreResearchQuestion(basePath: string, question: string, context: string): void {
  const researchDir = join(gsdRoot(basePath), "research");
  mkdirSync(researchDir, { recursive: true });
  const filePath = join(researchDir, "questions.md");
  const timestamp = new Date().toISOString();
  const entry = [
    `### ${question}`,
    `**Context:** ${context}`,
    `**Added:** ${timestamp}`,
    "",
  ].join("\n");

  if (existsSync(filePath)) {
    const existing = readFileSync(filePath, "utf-8");
    writeFileSync(filePath, existing.trimEnd() + "\n\n" + entry, "utf-8");
  } else {
    writeFileSync(filePath, `# Research Questions\n\n${entry}`, "utf-8");
  }
}
