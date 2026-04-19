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
	/** Set by await_job when results are consumed. Suppresses follow-up delivery. */
	awaited?: boolean;
	/**
	 * Handle for the pending follow-up delivery timer (set by deliverResult).
	 * Stored so suppressFollowUp() can cancel it before the notification fires,
	 * even when await_job is called after the job has already completed (#3787).
	 */
	deliveryTimer?: ReturnType<typeof setTimeout>;
}

export interface JobManagerOptions {
	maxRunning?: number;       // default 15
	maxTotal?: number;         // default 100
	evictionMs?: number;       // default 5 minutes
	onJobComplete?: (job: Job) => void;
}

// ── Manager ────────────────────────────────────────────────────────────────

export class AsyncJobManager {
	private jobs = new Map<string, Job>();
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
	 * Cleanup all timers and resources.
	 */
	shutdown(): void {
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

	/**
	 * Suppress follow-up notification for a job — cancels any pending delivery
	 * timer and marks the job as awaited. Safe to call at any time, including
	 * before or after the job completes (#3787).
	 */
	suppressFollowUp(id: string): void {
		const job = this.jobs.get(id);
		if (!job) return;
		job.awaited = true;
		if (job.deliveryTimer !== undefined) {
			clearTimeout(job.deliveryTimer);
			job.deliveryTimer = undefined;
		}
	}

	private deliverResult(job: Job): void {
		if (!this.onJobComplete) return;
		// Use setTimeout(0) instead of queueMicrotask so the handle is cancellable.
		// suppressFollowUp() can clear this timer even when await_job is called in
		// a later LLM turn (after the job already completed). queueMicrotask ran
		// immediately and could not be cancelled (#2762, #3787).
		const cb = this.onJobComplete;
		job.deliveryTimer = setTimeout(() => {
			job.deliveryTimer = undefined;
			if (!job.awaited) cb(job);
		}, 0);
		// Allow process to exit even if timer is pending
		if (typeof job.deliveryTimer === "object" && "unref" in job.deliveryTimer) {
			(job.deliveryTimer as NodeJS.Timeout).unref();
		}
	}

	private scheduleEviction(id: string): void {
		const existing = this.evictionTimers.get(id);
		if (existing) clearTimeout(existing);

		const timer = setTimeout(() => {
			this.evictionTimers.delete(id);
			this.jobs.delete(id);
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
		}
	}
}
