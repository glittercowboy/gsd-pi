import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseRemoteUrl,
  createGitHubClient,
  getRepoInfo,
} from "../resources/extensions/gsd/github-client.ts";

describe("parseRemoteUrl — extracts owner/repo from git remote URLs", () => {
  it("parses HTTPS URL with .git suffix", () => {
    const result = parseRemoteUrl("https://github.com/octocat/hello-world.git");
    assert.deepEqual(result, { owner: "octocat", repo: "hello-world" });
  });

  it("parses HTTPS URL without .git suffix", () => {
    const result = parseRemoteUrl("https://github.com/octocat/hello-world");
    assert.deepEqual(result, { owner: "octocat", repo: "hello-world" });
  });

  it("parses SSH URL with .git suffix", () => {
    const result = parseRemoteUrl("git@github.com:octocat/hello-world.git");
    assert.deepEqual(result, { owner: "octocat", repo: "hello-world" });
  });

  it("parses SSH URL without .git suffix", () => {
    const result = parseRemoteUrl("git@github.com:octocat/hello-world");
    assert.deepEqual(result, { owner: "octocat", repo: "hello-world" });
  });

  it("parses ssh:// protocol URL", () => {
    const result = parseRemoteUrl(
      "ssh://git@github.com/octocat/hello-world.git",
    );
    assert.deepEqual(result, { owner: "octocat", repo: "hello-world" });
  });

  it("handles repos with hyphens and underscores", () => {
    const result = parseRemoteUrl(
      "https://github.com/my-org/my_cool-repo.git",
    );
    assert.deepEqual(result, { owner: "my-org", repo: "my_cool-repo" });
  });

  it("returns null for non-GitHub URLs", () => {
    const result = parseRemoteUrl("https://gitlab.com/owner/repo.git");
    assert.equal(result, null);
  });

  it("returns null for malformed URLs", () => {
    assert.equal(parseRemoteUrl("not-a-url"), null);
    assert.equal(parseRemoteUrl(""), null);
  });

  it("returns null for bare paths", () => {
    assert.equal(parseRemoteUrl("/home/user/repo.git"), null);
  });
});

describe("createGitHubClient — Octokit instantiation", () => {
  it("returns null when no token is provided and env vars are unset", () => {
    const origGH = process.env.GITHUB_TOKEN;
    const origGH2 = process.env.GH_TOKEN;
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;

    try {
      const client = createGitHubClient();
      assert.equal(client, null);
    } finally {
      if (origGH !== undefined) process.env.GITHUB_TOKEN = origGH;
      if (origGH2 !== undefined) process.env.GH_TOKEN = origGH2;
    }
  });

  it("creates a client when a token is provided directly", () => {
    const client = createGitHubClient("ghp_test123");
    assert.notEqual(client, null);
    assert.equal(typeof client!.pulls, "object");
    assert.equal(typeof client!.issues, "object");
  });

  it("creates a client from GITHUB_TOKEN env var", () => {
    const origGH = process.env.GITHUB_TOKEN;
    const origGH2 = process.env.GH_TOKEN;
    delete process.env.GH_TOKEN;
    process.env.GITHUB_TOKEN = "ghp_env_test";

    try {
      const client = createGitHubClient();
      assert.notEqual(client, null);
    } finally {
      if (origGH !== undefined) {
        process.env.GITHUB_TOKEN = origGH;
      } else {
        delete process.env.GITHUB_TOKEN;
      }
      if (origGH2 !== undefined) process.env.GH_TOKEN = origGH2;
    }
  });

  it("creates a client from GH_TOKEN env var", () => {
    const origGH = process.env.GITHUB_TOKEN;
    const origGH2 = process.env.GH_TOKEN;
    delete process.env.GITHUB_TOKEN;
    process.env.GH_TOKEN = "ghp_gh_token_test";

    try {
      const client = createGitHubClient();
      assert.notEqual(client, null);
    } finally {
      if (origGH !== undefined) process.env.GITHUB_TOKEN = origGH;
      if (origGH2 !== undefined) {
        process.env.GH_TOKEN = origGH2;
      } else {
        delete process.env.GH_TOKEN;
      }
    }
  });

  it("prefers explicit token over env vars", () => {
    const origGH = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = "ghp_from_env";

    try {
      const client = createGitHubClient("ghp_explicit");
      assert.notEqual(client, null);
    } finally {
      if (origGH !== undefined) {
        process.env.GITHUB_TOKEN = origGH;
      } else {
        delete process.env.GITHUB_TOKEN;
      }
    }
  });
});

describe("getRepoInfo — detects repo from git working directory", () => {
  it("returns owner/repo for the current repository", async () => {
    const info = await getRepoInfo(process.cwd());
    // Verifies getRepoInfo can parse the origin remote — owner varies
    // depending on whether this is the upstream repo or a fork.
    assert.notEqual(info, null);
    assert.ok(info!.owner.length > 0, "owner should be non-empty");
    assert.ok(info!.repo.toLowerCase().includes("gsd-2"), "repo should contain gsd-2");
  });

  it("returns null for a non-git directory", async () => {
    const info = await getRepoInfo("/tmp");
    assert.equal(info, null);
  });
});
