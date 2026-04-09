import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();

function readFile(relativePath: string): string {
  const full = resolve(root, relativePath);
  assert.ok(existsSync(full), `expected ${relativePath} to exist`);
  return readFileSync(full, "utf-8");
}

// ── Dockerfile.sandbox ──

test("docker/Dockerfile.sandbox exists and uses Node 24 base", () => {
  const content = readFile("docker/Dockerfile.sandbox");
  assert.match(content, /FROM node:24/);
});

test("docker/Dockerfile.sandbox installs gsd-pi globally", () => {
  const content = readFile("docker/Dockerfile.sandbox");
  assert.match(content, /npm install -g gsd-pi/);
});

test("docker/Dockerfile.sandbox creates a non-root user", () => {
  const content = readFile("docker/Dockerfile.sandbox");
  assert.match(content, /useradd/);
});

test("docker/Dockerfile.sandbox exposes port 3000", () => {
  const content = readFile("docker/Dockerfile.sandbox");
  assert.match(content, /EXPOSE 3000/);
});

test("docker/Dockerfile.sandbox installs git", () => {
  const content = readFile("docker/Dockerfile.sandbox");
  assert.match(content, /git/);
});

// ── docker-compose.yaml (minimal) ──

test("docker/docker-compose.yaml exists and defines gsd service", () => {
  const content = readFile("docker/docker-compose.yaml");
  assert.match(content, /services:/);
  assert.match(content, /gsd:/);
});

test("docker/docker-compose.yaml mounts workspace volume", () => {
  const content = readFile("docker/docker-compose.yaml");
  assert.match(content, /\/workspace/);
});

test("docker/docker-compose.yaml references Dockerfile.sandbox", () => {
  const content = readFile("docker/docker-compose.yaml");
  assert.match(content, /Dockerfile\.sandbox/);
});

test("docker/docker-compose.yaml maps port 3000", () => {
  const content = readFile("docker/docker-compose.yaml");
  assert.match(content, /3000:3000/);
});

test("docker/docker-compose.yaml has no hardcoded user directive", () => {
  const content = readFile("docker/docker-compose.yaml");
  assert.doesNotMatch(content, /^\s+user:/m);
});

// ── docker-compose.full.yaml (reference) ──

test("docker/docker-compose.full.yaml exists with health check", () => {
  const content = readFile("docker/docker-compose.full.yaml");
  assert.match(content, /healthcheck:/);
});

test("docker/docker-compose.full.yaml documents PUID/PGID", () => {
  const content = readFile("docker/docker-compose.full.yaml");
  assert.match(content, /PUID/);
  assert.match(content, /PGID/);
});

// ── .env.example ──

test("docker/.env.example exists and lists ANTHROPIC_API_KEY", () => {
  const content = readFile("docker/.env.example");
  assert.match(content, /ANTHROPIC_API_KEY/);
});

test("docker/.env.example lists OPENAI_API_KEY", () => {
  const content = readFile("docker/.env.example");
  assert.match(content, /OPENAI_API_KEY/);
});

// ── .dockerignore ──

test(".dockerignore exists at project root", () => {
  const content = readFile(".dockerignore");
  assert.match(content, /node_modules/);
  assert.match(content, /\.env/);
  assert.match(content, /dist/);
});

// ── README ──

test("docker/README.md exists and documents sandbox usage", () => {
  const content = readFile("docker/README.md");
  assert.match(content, /Docker Sandbox/i);
  assert.match(content, /docker sandbox create/);
  assert.match(content, /Network Allowlisting/i);
});
