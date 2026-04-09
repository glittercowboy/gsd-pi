/**
 * message-batcher.ts — Rate-limit-aware message batcher for Discord.
 *
 * Accumulates FormattedEvent payloads and flushes them to a Discord channel
 * respecting the 5 msg/5s rate limit. Supports:
 *   - Timer-based periodic flush (default 1.5s)
 *   - Capacity-based flush when buffer hits maxBatchSize
 *   - Immediate priority flush for blockers (bypasses batching)
 *   - Combining multiple embeds into a single send() call
 *   - Error isolation: send() failures are logged, never crash the batcher
 */

import type { FormattedEvent } from './types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Payload passed to the send callback — matches Discord TextChannel.send() shape. */
export interface SendPayload {
  content: string;
  embeds: unknown[];
  components: unknown[];
}

/** Send callback abstraction. Returns void or a promise. */
export type SendFn = (payload: SendPayload) => Promise<void> | void;

/** Logger interface — just needs error/warn/debug. */
export interface BatcherLogger {
  error(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  debug(msg: string, data?: Record<string, unknown>): void;
}

/** MessageBatcher configuration options. */
export interface BatcherOptions {
  /** Interval between timed flushes in ms. Default: 1500 */
  flushIntervalMs?: number;
  /** Max events before triggering an immediate capacity flush. Default: 4 */
  maxBatchSize?: number;
}

// ---------------------------------------------------------------------------
// Default no-op logger
// ---------------------------------------------------------------------------

const noopLogger: BatcherLogger = {
  error() {},
  warn() {},
  debug() {},
};

// ---------------------------------------------------------------------------
// MessageBatcher
// ---------------------------------------------------------------------------

export class MessageBatcher {
  private readonly send: SendFn;
  private readonly logger: BatcherLogger;
  private readonly flushIntervalMs: number;
  private readonly maxBatchSize: number;

  private buffer: FormattedEvent[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private flushing = false;
  private destroyed = false;

  constructor(send: SendFn, logger?: BatcherLogger, options?: BatcherOptions) {
    this.send = send;
    this.logger = logger ?? noopLogger;
    this.flushIntervalMs = options?.flushIntervalMs ?? 1500;
    this.maxBatchSize = options?.maxBatchSize ?? 4;
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /** Start the periodic flush timer. */
  start(): void {
    if (this.timer) return; // already running
    this.timer = setInterval(() => {
      void this.flush();
    }, this.flushIntervalMs);
    // Don't hold the process open for the timer
    if (this.timer && typeof this.timer === 'object' && 'unref' in this.timer) {
      this.timer.unref();
    }
    this.logger.debug('Batcher started', { flushIntervalMs: this.flushIntervalMs });
  }

  /** Stop the periodic flush timer without flushing. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.logger.debug('Batcher stopped');
  }

  /** Flush remaining buffer and stop. Safe to call multiple times. */
  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    this.stop();
    await this.flush();
    this.logger.debug('Batcher destroyed');
  }

  /**
   * Enqueue a formatted event for batched sending.
   * Triggers an immediate capacity flush if buffer reaches maxBatchSize.
   */
  enqueue(formatted: FormattedEvent): void {
    if (this.destroyed) return;
    this.buffer.push(formatted);
    if (this.buffer.length >= this.maxBatchSize) {
      void this.flush();
    }
  }

  /**
   * Immediately send a high-priority event (e.g. blocker).
   * Flushes any pending buffer first, then sends the priority event alone.
   */
  async enqueueImmediate(formatted: FormattedEvent): Promise<void> {
    if (this.destroyed) return;
    // Flush pending buffer first so ordering is preserved
    await this.flush();
    // Send the priority event immediately, alone
    await this.doSend([formatted]);
  }

  /** Current number of events in the buffer (for testing/diagnostics). */
  get pending(): number {
    return this.buffer.length;
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  /**
   * Flush the current buffer as a single Discord message.
   * Multiple embeds are combined into one send() call (Discord supports up to 10).
   * No-op if buffer is empty.
   */
  private async flush(): Promise<void> {
    if (this.buffer.length === 0) return;
    if (this.flushing) return; // prevent re-entrant flush

    this.flushing = true;
    const batch = this.buffer.splice(0); // take all
    try {
      await this.doSend(batch);
    } finally {
      this.flushing = false;
    }
  }

  /**
   * Build a SendPayload from a batch of FormattedEvents and invoke the send callback.
   * Catches and logs errors — never throws.
   *
   * For batched messages (2+ events), we send content-only to avoid duplication
   * between content text and embed descriptions, and to stay under Discord's
   * 10-embed limit. Single-event sends include the embed for rich formatting.
   */
  private async doSend(batch: FormattedEvent[]): Promise<void> {
    if (batch.length === 0) return;

    // Combine content lines
    const content = batch.map((e) => e.content).join('\n');

    // For single events, include the embed for rich formatting.
    // For batches, skip embeds — the content lines are self-descriptive and
    // embeds would duplicate the information + risk hitting Discord's 10-embed cap.
    const embeds: unknown[] = [];
    if (batch.length === 1 && batch[0].embed) {
      embeds.push(batch[0].embed);
    }

    // Collect all component rows (only from the last event with components —
    // Discord only supports one set of components per message)
    let components: unknown[] = [];
    for (const e of batch) {
      if (e.components && e.components.length > 0) {
        components = e.components;
      }
    }

    const payload: SendPayload = { content, embeds, components };

    try {
      await this.send(payload);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error('Batcher send failed', { error: message, batchSize: batch.length });

      // Retry once after a short delay
      try {
        await new Promise((r) => setTimeout(r, 1000));
        await this.send(payload);
        this.logger.debug('Batcher retry succeeded');
      } catch (retryErr) {
        const retryMessage = retryErr instanceof Error ? retryErr.message : String(retryErr);
        this.logger.warn('Batcher retry also failed, dropping batch', {
          error: retryMessage,
          batchSize: batch.length,
        });
        // Drop the batch — don't re-enqueue to prevent infinite loops
      }
    }
  }
}
