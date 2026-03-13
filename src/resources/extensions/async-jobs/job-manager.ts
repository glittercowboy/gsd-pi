/**
 * AsyncJobManager — manages background tool call jobs.
 *
 * Each job runs asynchronously and delivers its result via a callback
 * when complete. Jobs are evicted after a configurable TTL.
 */

import { randomUUID } from "node:crypto";

// ── Types ──────────────────────────────────────────────────────────────────

export type JobStatus = "running" | "completed" | "failed" | "cancelled";
export type JobType = "bash";

export interface Job {
	id: string;
	type: JobType;
	status: JobStatus;
	startTime: number;
	label: string;
	abortController: AbortController;
	promise: Promise<void>;
	resultText?: string;
	errorText?: string;
}

export interface JobManagerOptions {
	maxRunning?: number;       // default 15
	maxTotal?: number;         // default 100
	evictionMs?: number;       // default 5 minutes
	onJobComplete?: (job: Job) => void;
}

// ── Delivery Retry ─────────────────────────────────────────────────────────

const DELIVERY_BASE_MS = 500;
const DELIVERY_MAX_MS = 30_000;
const DELIVERY_JITTER_MS = 200;

// ── Manager ────────────────────────────────────────────────────────────────

export class AsyncJobManager {
	private jobs = new Map<string, Job>();
	private deliveryTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private acknowledgedJobs = new Set<string>();
	private evictionTimers = new Map<string, ReturnType<typeof setTimeout>>();

	private maxRunning: number;
	private maxTotal: number;
	private evictionMs: number;
	private onJobComplete?: (job: Job) => void;

	constructor(options: JobManagerOptions = {}) {
		this.maxRunning = options.maxRunning ?? 15;
		this.maxTotal = options.maxTotal ?? 100;
		this.evictionMs = options.evictionMs ?? 5 * 60 * 1000;
		this.onJobComplete = options.onJobComplete;
	}

	/**
	 * Register a new background job.
	 * @returns job ID (prefixed with `bg_`)
	 */
	register(
		type: JobType,
		label: string,
		runFn: (signal: AbortSignal) => Promise<string>,
	): string {
		// Enforce limits
		const running = this.getRunningJobs();
		if (running.length >= this.maxRunning) {
			throw new Error(
				`Maximum concurrent background jobs reached (${this.maxRunning}). ` +
				`Use await_job or cancel_job to free a slot.`,
			);
		}
		if (this.jobs.size >= this.maxTotal) {
			// Evict oldest completed job
			this.evictOldest();
			if (this.jobs.size >= this.maxTotal) {
				throw new Error(
					`Maximum total background jobs reached (${this.maxTotal}). ` +
					`Use cancel_job to remove jobs.`,
				);
			}
		}

		const id = `bg_${randomUUID().slice(0, 8)}`;
		const abortController = new AbortController();

		// Declare job first so the promise callbacks can close over it safely.
		const job: Job = {
			id,
			type,
			status: "running",
			startTime: Date.now(),
			label,
			abortController,
			// promise assigned below
			promise: undefined as unknown as Promise<void>,
		};

		job.promise = runFn(abortController.signal)
			.then((resultText) => {
				job.status = "completed";
				job.resultText = resultText;
				this.scheduleEviction(id);
				this.deliverResult(job);
			})
			.catch((err) => {
				if (job.status === "cancelled") {
					// Already cancelled — don't overwrite
					this.scheduleEviction(id);
					return;
				}
				job.status = "failed";
				job.errorText = err instanceof Error ? err.message : String(err);
				this.scheduleEviction(id);
				this.deliverResult(job);
			});

		this.jobs.set(id, job);
		return id;
	}

	/**
	 * Cancel a running job.
	 */
	cancel(id: string): "cancelled" | "not_found" | "already_completed" {
		const job = this.jobs.get(id);
		if (!job) return "not_found";
		if (job.status !== "running") return "already_completed";

		job.status = "cancelled";
		job.errorText = "Cancelled by user";
		job.abortController.abort();
		this.scheduleEviction(id);
		return "cancelled";
	}

	getJob(id: string): Job | undefined {
		return this.jobs.get(id);
	}

	getRunningJobs(): Job[] {
		return [...this.jobs.values()].filter((j) => j.status === "running");
	}

	getRecentJobs(limit = 10): Job[] {
		return [...this.jobs.values()]
			.sort((a, b) => b.startTime - a.startTime)
			.slice(0, limit);
	}

	getAllJobs(): Job[] {
		return [...this.jobs.values()];
	}

	/**
	 * Mark jobs as acknowledged so delivery retries stop.
	 */
	acknowledgeDeliveries(jobIds: string[]): void {
		for (const id of jobIds) {
			this.acknowledgedJobs.add(id);
			const timer = this.deliveryTimers.get(id);
			if (timer) {
				clearTimeout(timer);
				this.deliveryTimers.delete(id);
			}
		}
	}

	/**
	 * Cleanup all timers and resources.
	 */
	shutdown(): void {
		for (const timer of this.deliveryTimers.values()) {
			clearTimeout(timer);
		}
		this.deliveryTimers.clear();

		for (const timer of this.evictionTimers.values()) {
			clearTimeout(timer);
		}
		this.evictionTimers.clear();

		// Abort all running jobs
		for (const job of this.jobs.values()) {
			if (job.status === "running") {
				job.status = "cancelled";
				job.abortController.abort();
			}
		}
	}

	// ── Private ────────────────────────────────────────────────────────────

	private deliverResult(job: Job, attempt = 0): void {
		if (this.acknowledgedJobs.has(job.id)) return;
		if (!this.onJobComplete) return;

		this.onJobComplete(job);

		// Schedule retry with exponential backoff + jitter
		const delay = Math.min(
			DELIVERY_BASE_MS * Math.pow(2, attempt) + Math.random() * DELIVERY_JITTER_MS,
			DELIVERY_MAX_MS,
		);

		const timer = setTimeout(() => {
			this.deliveryTimers.delete(job.id);
			if (!this.acknowledgedJobs.has(job.id)) {
				this.deliverResult(job, attempt + 1);
			}
		}, delay);

		this.deliveryTimers.set(job.id, timer);
	}

	private scheduleEviction(id: string): void {
		const existing = this.evictionTimers.get(id);
		if (existing) clearTimeout(existing);

		const timer = setTimeout(() => {
			this.evictionTimers.delete(id);
			this.jobs.delete(id);
			this.acknowledgedJobs.delete(id);
		}, this.evictionMs);

		this.evictionTimers.set(id, timer);
	}

	private evictOldest(): void {
		let oldest: Job | undefined;
		for (const job of this.jobs.values()) {
			if (job.status !== "running") {
				if (!oldest || job.startTime < oldest.startTime) {
					oldest = job;
				}
			}
		}
		if (oldest) {
			const timer = this.evictionTimers.get(oldest.id);
			if (timer) clearTimeout(timer);
			this.evictionTimers.delete(oldest.id);
			this.jobs.delete(oldest.id);
			this.acknowledgedJobs.delete(oldest.id);
		}
	}
}
