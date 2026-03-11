/**
 * GitHub API layer — wraps `gh` CLI with fallback to GITHUB_TOKEN + fetch.
 *
 * All GitHub communication goes through this module.
 * Prefers `gh api` when the CLI is available and authenticated.
 * Falls back to raw REST API with GITHUB_TOKEN env var.
 */

import { execSync, spawnSync, type SpawnSyncReturns } from "node:child_process";

// ─── Auth detection ───────────────────────────────────────────────────────────

let _useGhCli: boolean | null = null;

let ghSpawnImpl = (args: string[], input?: string, cwd?: string): SpawnSyncReturns<string> =>
	spawnSync("gh", args, {
		cwd,
		encoding: "utf8",
		stdio: ["pipe", "pipe", "pipe"],
		input,
	});

function ghSpawn(args: string[], input?: string, cwd?: string): SpawnSyncReturns<string> {
	return ghSpawnImpl(args, input, cwd);
}

export function resetGhCliDetectionForTests(): void {
	_useGhCli = null;
	ghSpawnImpl = (args: string[], input?: string, cwd?: string): SpawnSyncReturns<string> =>
		spawnSync("gh", args, {
			cwd,
			encoding: "utf8",
			stdio: ["pipe", "pipe", "pipe"],
			input,
		});
}

export function setGhSpawnForTests(fn: (args: string[], input?: string, cwd?: string) => SpawnSyncReturns<string>): void {
	ghSpawnImpl = fn;
	_useGhCli = null;
}

export function hasGhCli(): boolean {
	if (_useGhCli !== null) return _useGhCli;
	const result = ghSpawn(["auth", "token"]);
	_useGhCli = result.status === 0 && !result.error && !!result.stdout?.trim();
	return _useGhCli;
}

function getToken(): string | undefined {
	return process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
}

export function isAuthenticated(): boolean {
	return hasGhCli() || !!getToken();
}

export function authMethod(): string {
	if (hasGhCli()) return "gh CLI";
	if (getToken()) return "GITHUB_TOKEN";
	return "none";
}

// ─── Repo detection ───────────────────────────────────────────────────────────

export interface RepoInfo {
	owner: string;
	repo: string;
	fullName: string;
}

export function detectRepo(cwd: string): RepoInfo | null {
	try {
		const remote = execSync("git remote get-url origin", {
			cwd,
			encoding: "utf8",
			stdio: ["pipe", "pipe", "pipe"],
		}).trim();

		// Handle SSH: git@github.com:owner/repo.git
		// Handle HTTPS: https://github.com/owner/repo.git
		const sshMatch = remote.match(/github\.com[:/]([^/]+)\/([^/.]+)/);
		if (sshMatch) {
			return { owner: sshMatch[1], repo: sshMatch[2], fullName: `${sshMatch[1]}/${sshMatch[2]}` };
		}

		return null;
	} catch {
		return null;
	}
}

export function getCurrentBranch(cwd: string): string | null {
	try {
		return execSync("git rev-parse --abbrev-ref HEAD", {
			cwd,
			encoding: "utf8",
			stdio: ["pipe", "pipe", "pipe"],
		}).trim();
	} catch {
		return null;
	}
}

export function getDefaultBranch(cwd: string): string {
	try {
		const result = execSync("git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null || echo refs/remotes/origin/main", {
			cwd,
			encoding: "utf8",
			stdio: ["pipe", "pipe", "pipe"],
		}).trim();
		return result.replace("refs/remotes/origin/", "");
	} catch {
		return "main";
	}
}

// ─── API calls ────────────────────────────────────────────────────────────────

/**
 * Call the GitHub REST API. Returns parsed JSON.
 *
 * When method is GET and params are provided, they're appended as query params.
 * When method is POST/PUT/PATCH/DELETE, params are sent as JSON body.
 */
export async function ghApi<T = unknown>(
	endpoint: string,
	options: {
		method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
		params?: Record<string, string | number | boolean | string[] | undefined>;
		body?: Record<string, unknown>;
		cwd?: string;
	} = {},
): Promise<T> {
	const method = options.method ?? "GET";

	if (hasGhCli()) {
		return ghCliApi<T>(endpoint, method, options.params, options.body, options.cwd);
	}

	const token = getToken();
	if (!token) throw new Error("Not authenticated. Install gh CLI or set GITHUB_TOKEN.");

	return fetchApi<T>(endpoint, method, options.params, options.body, token);
}

function ghCliApi<T>(
	endpoint: string,
	method: string,
	params?: Record<string, string | number | boolean | string[] | undefined>,
	body?: Record<string, unknown>,
	cwd?: string,
): T {
	const args = ["api", endpoint, "--method", method];

	if (params) {
		for (const [key, val] of Object.entries(params)) {
			if (val === undefined) continue;
			if (Array.isArray(val)) {
				for (const v of val) {
					args.push("-f", `${key}[]=${v}`);
				}
			} else {
				args.push("-f", `${key}=${String(val)}`);
			}
		}
	}

	if (body) {
		args.push("--input", "-");
	}

	const result = ghSpawn(args, body ? JSON.stringify(body) : undefined, cwd ?? process.cwd());

	const stdout = result.stdout?.trim() ?? "";
	const stderr = result.stderr?.trim() ?? "";

	if (result.status !== 0) {
		throw new Error(`gh api error: ${stderr || stdout || result.error?.message || `exit code ${result.status}`}`);
	}

	if (!stdout) return {} as T;
	return JSON.parse(stdout) as T;
}

async function fetchApi<T>(
	endpoint: string,
	method: string,
	params?: Record<string, string | number | boolean | string[] | undefined>,
	body?: Record<string, unknown>,
	token?: string,
): Promise<T> {
	let url = endpoint.startsWith("http") ? endpoint : `https://api.github.com${endpoint}`;

	if (method === "GET" && params) {
		const qs = new URLSearchParams();
		for (const [key, val] of Object.entries(params)) {
			if (val === undefined) continue;
			if (Array.isArray(val)) {
				for (const v of val) qs.append(key, v);
			} else {
				qs.set(key, String(val));
			}
		}
		const qsStr = qs.toString();
		if (qsStr) url += `?${qsStr}`;
	}

	const headers: Record<string, string> = {
		Accept: "application/vnd.github+json",
		"X-GitHub-Api-Version": "2022-11-28",
	};
	if (token) headers.Authorization = `Bearer ${token}`;

	const res = await fetch(url, {
		method,
		headers,
		body: method !== "GET" && body ? JSON.stringify(body) : undefined,
	});

	if (!res.ok) {
		const text = await res.text();
		throw new Error(`GitHub API ${res.status}: ${text}`);
	}

	const text = await res.text();
	if (!text.trim()) return {} as T;
	return JSON.parse(text) as T;
}

// ─── Typed API wrappers ───────────────────────────────────────────────────────

export interface GhIssue {
	number: number;
	title: string;
	state: string;
	body: string | null;
	user: { login: string };
	labels: { name: string; color: string }[];
	assignees: { login: string }[];
	milestone: { title: string; number: number } | null;
	created_at: string;
	updated_at: string;
	closed_at: string | null;
	comments: number;
	html_url: string;
	pull_request?: { url: string };
}

export interface GhPullRequest {
	number: number;
	title: string;
	state: string;
	body: string | null;
	user: { login: string };
	labels: { name: string; color: string }[];
	assignees: { login: string }[];
	milestone: { title: string; number: number } | null;
	head: { ref: string; sha: string };
	base: { ref: string };
	created_at: string;
	updated_at: string;
	merged_at: string | null;
	closed_at: string | null;
	comments: number;
	review_comments: number;
	draft: boolean;
	mergeable: boolean | null;
	mergeable_state: string;
	html_url: string;
	diff_url: string;
	requested_reviewers: { login: string }[];
}

export interface GhComment {
	id: number;
	body: string;
	user: { login: string };
	created_at: string;
	updated_at: string;
	html_url: string;
}

export interface GhLabel {
	name: string;
	color: string;
	description: string | null;
}

export interface GhMilestone {
	number: number;
	title: string;
	description: string | null;
	state: string;
	open_issues: number;
	closed_issues: number;
	due_on: string | null;
}

export interface GhReview {
	id: number;
	user: { login: string };
	state: string;
	body: string | null;
	submitted_at: string;
	html_url: string;
}

export interface GhCheckRun {
	name: string;
	status: string;
	conclusion: string | null;
	html_url: string;
}

// ─── Issues ───────────────────────────────────────────────────────────────────

export async function listIssues(
	repo: RepoInfo,
	options: {
		state?: "open" | "closed" | "all";
		labels?: string;
		assignee?: string;
		milestone?: string;
		sort?: "created" | "updated" | "comments";
		direction?: "asc" | "desc";
		per_page?: number;
		page?: number;
	} = {},
): Promise<GhIssue[]> {
	const params: Record<string, string | number | undefined> = {
		state: options.state ?? "open",
		sort: options.sort ?? "updated",
		direction: options.direction ?? "desc",
		per_page: String(options.per_page ?? 30),
		page: String(options.page ?? 1),
	};
	if (options.labels) params.labels = options.labels;
	if (options.assignee) params.assignee = options.assignee;
	if (options.milestone) params.milestone = options.milestone;

	const issues = await ghApi<GhIssue[]>(`/repos/${repo.fullName}/issues`, { params });
	// Filter out PRs (GitHub API returns PRs in issues endpoint)
	return issues.filter((i) => !i.pull_request);
}

export async function getIssue(repo: RepoInfo, number: number): Promise<GhIssue> {
	return ghApi<GhIssue>(`/repos/${repo.fullName}/issues/${number}`);
}

export async function createIssue(
	repo: RepoInfo,
	data: { title: string; body?: string; labels?: string[]; assignees?: string[]; milestone?: number },
): Promise<GhIssue> {
	return ghApi<GhIssue>(`/repos/${repo.fullName}/issues`, {
		method: "POST",
		body: data,
	});
}

export async function updateIssue(
	repo: RepoInfo,
	number: number,
	data: { title?: string; body?: string; state?: string; labels?: string[]; assignees?: string[]; milestone?: number | null },
): Promise<GhIssue> {
	return ghApi<GhIssue>(`/repos/${repo.fullName}/issues/${number}`, {
		method: "PATCH",
		body: data,
	});
}

export async function addComment(repo: RepoInfo, number: number, body: string): Promise<GhComment> {
	return ghApi<GhComment>(`/repos/${repo.fullName}/issues/${number}/comments`, {
		method: "POST",
		body: { body },
	});
}

export async function listComments(repo: RepoInfo, number: number): Promise<GhComment[]> {
	return ghApi<GhComment[]>(`/repos/${repo.fullName}/issues/${number}/comments`);
}

// ─── Pull Requests ────────────────────────────────────────────────────────────

export async function listPullRequests(
	repo: RepoInfo,
	options: {
		state?: "open" | "closed" | "all";
		sort?: "created" | "updated" | "popularity" | "long-running";
		direction?: "asc" | "desc";
		per_page?: number;
		page?: number;
		head?: string;
		base?: string;
	} = {},
): Promise<GhPullRequest[]> {
	const params: Record<string, string | number | undefined> = {
		state: options.state ?? "open",
		sort: options.sort ?? "updated",
		direction: options.direction ?? "desc",
		per_page: String(options.per_page ?? 30),
		page: String(options.page ?? 1),
	};
	if (options.head) params.head = options.head;
	if (options.base) params.base = options.base;

	return ghApi<GhPullRequest[]>(`/repos/${repo.fullName}/pulls`, { params });
}

export async function getPullRequest(repo: RepoInfo, number: number): Promise<GhPullRequest> {
	return ghApi<GhPullRequest>(`/repos/${repo.fullName}/pulls/${number}`);
}

export async function createPullRequest(
	repo: RepoInfo,
	data: { title: string; body?: string; head: string; base: string; draft?: boolean },
): Promise<GhPullRequest> {
	return ghApi<GhPullRequest>(`/repos/${repo.fullName}/pulls`, {
		method: "POST",
		body: data,
	});
}

export async function updatePullRequest(
	repo: RepoInfo,
	number: number,
	data: { title?: string; body?: string; state?: string; base?: string },
): Promise<GhPullRequest> {
	return ghApi<GhPullRequest>(`/repos/${repo.fullName}/pulls/${number}`, {
		method: "PATCH",
		body: data,
	});
}

export async function getPullRequestDiff(repo: RepoInfo, number: number): Promise<string> {
	if (hasGhCli()) {
		try {
			return execSync(`gh pr diff ${number} --repo ${repo.fullName}`, {
				encoding: "utf8",
				stdio: ["pipe", "pipe", "pipe"],
			}).trim();
		} catch (e: unknown) {
			const err = e as { stderr?: string; message?: string };
			throw new Error(err.stderr?.trim() || err.message || String(e));
		}
	}

	const token = getToken();
	const headers: Record<string, string> = {
		Accept: "application/vnd.github.v3.diff",
		"X-GitHub-Api-Version": "2022-11-28",
	};
	if (token) headers.Authorization = `Bearer ${token}`;

	const res = await fetch(`https://api.github.com/repos/${repo.fullName}/pulls/${number}`, { headers });
	if (!res.ok) throw new Error(`GitHub API ${res.status}: ${await res.text()}`);
	return res.text();
}

export async function listPullRequestFiles(
	repo: RepoInfo,
	number: number,
): Promise<{ filename: string; status: string; additions: number; deletions: number; changes: number }[]> {
	return ghApi(`/repos/${repo.fullName}/pulls/${number}/files`);
}

// ─── Reviews ──────────────────────────────────────────────────────────────────

export async function listReviews(repo: RepoInfo, number: number): Promise<GhReview[]> {
	return ghApi<GhReview[]>(`/repos/${repo.fullName}/pulls/${number}/reviews`);
}

export async function createReview(
	repo: RepoInfo,
	number: number,
	data: { body?: string; event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT" },
): Promise<GhReview> {
	return ghApi<GhReview>(`/repos/${repo.fullName}/pulls/${number}/reviews`, {
		method: "POST",
		body: data,
	});
}

export async function requestReviewers(
	repo: RepoInfo,
	number: number,
	reviewers: string[],
): Promise<GhPullRequest> {
	return ghApi<GhPullRequest>(`/repos/${repo.fullName}/pulls/${number}/requested_reviewers`, {
		method: "POST",
		body: { reviewers },
	});
}

// ─── Checks ───────────────────────────────────────────────────────────────────

export async function listCheckRuns(repo: RepoInfo, ref: string): Promise<{ check_runs: GhCheckRun[] }> {
	return ghApi(`/repos/${repo.fullName}/commits/${ref}/check-runs`);
}

// ─── Labels & Milestones ──────────────────────────────────────────────────────

export async function listLabels(repo: RepoInfo): Promise<GhLabel[]> {
	return ghApi<GhLabel[]>(`/repos/${repo.fullName}/labels`, {
		params: { per_page: "100" },
	});
}

export async function createLabel(
	repo: RepoInfo,
	data: { name: string; color: string; description?: string },
): Promise<GhLabel> {
	return ghApi<GhLabel>(`/repos/${repo.fullName}/labels`, {
		method: "POST",
		body: data,
	});
}

export async function listMilestones(repo: RepoInfo): Promise<GhMilestone[]> {
	return ghApi<GhMilestone[]>(`/repos/${repo.fullName}/milestones`, {
		params: { state: "all", per_page: "100" },
	});
}

export async function createMilestone(
	repo: RepoInfo,
	data: { title: string; description?: string; due_on?: string },
): Promise<GhMilestone> {
	return ghApi<GhMilestone>(`/repos/${repo.fullName}/milestones`, {
		method: "POST",
		body: data,
	});
}

// ─── Search ───────────────────────────────────────────────────────────────────

export interface GhSearchResult<T> {
	total_count: number;
	items: T[];
}

export async function searchIssues(
	query: string,
	options: { per_page?: number; page?: number } = {},
): Promise<GhSearchResult<GhIssue>> {
	return ghApi<GhSearchResult<GhIssue>>("/search/issues", {
		params: {
			q: query,
			per_page: String(options.per_page ?? 30),
			page: String(options.page ?? 1),
		},
	});
}
