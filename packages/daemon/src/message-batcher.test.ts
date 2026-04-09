import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { MessageBatcher } from './message-batcher.js';
import type { SendPayload, BatcherLogger } from './message-batcher.js';
import type { FormattedEvent } from './types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a minimal FormattedEvent for testing. */
function fakeEvent(content: string, hasEmbed = false): FormattedEvent {
  const fe: FormattedEvent = { content };
  if (hasEmbed) {
    // Minimal mock embed — just needs to be truthy and pass through
    fe.embed = { data: { title: content } } as any;
  }
  return fe;
}

/** Create a tracking send function. */
function createSend() {
  const calls: SendPayload[] = [];
  const fn = mock.fn(async (payload: SendPayload) => {
    calls.push(payload);
  });
  return { fn, calls };
}

/** Create a logger that captures error/warn calls. */
function createLogger() {
  const errors: string[] = [];
  const warns: string[] = [];
  const debugs: string[] = [];
  const logger: BatcherLogger = {
    error(msg: string) { errors.push(msg); },
    warn(msg: string) { warns.push(msg); },
    debug(msg: string) { debugs.push(msg); },
  };
  return { logger, errors, warns, debugs };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MessageBatcher', () => {
  describe('enqueue + capacity flush', () => {
    it('flushes when buffer reaches maxBatchSize', async () => {
      const { fn, calls } = createSend();
      const batcher = new MessageBatcher(fn, undefined, { maxBatchSize: 3, flushIntervalMs: 60_000 });

      batcher.enqueue(fakeEvent('a'));
      batcher.enqueue(fakeEvent('b'));
      assert.equal(calls.length, 0, 'should not flush yet');

      batcher.enqueue(fakeEvent('c')); // hits capacity
      // flush is async — give it a tick
      await new Promise((r) => setTimeout(r, 10));

      assert.equal(calls.length, 1, 'should have flushed once');
      assert.equal(calls[0].content, 'a\nb\nc');
      assert.equal(batcher.pending, 0);

      await batcher.destroy();
    });

    it('skips embeds for batched messages (only content)', async () => {
      const { fn, calls } = createSend();
      const batcher = new MessageBatcher(fn, undefined, { maxBatchSize: 2, flushIntervalMs: 60_000 });

      batcher.enqueue(fakeEvent('a', true));
      batcher.enqueue(fakeEvent('b', true)); // triggers flush
      await new Promise((r) => setTimeout(r, 10));

      assert.equal(calls.length, 1);
      assert.equal(calls[0].embeds.length, 0, 'batched sends skip embeds to avoid duplication');
      assert.equal(calls[0].content, 'a\nb');

      await batcher.destroy();
    });
  });

  describe('enqueueImmediate', () => {
    it('flushes pending buffer then sends immediately', async () => {
      const { fn, calls } = createSend();
      const batcher = new MessageBatcher(fn, undefined, { maxBatchSize: 10, flushIntervalMs: 60_000 });

      batcher.enqueue(fakeEvent('buffered-1'));
      batcher.enqueue(fakeEvent('buffered-2'));

      await batcher.enqueueImmediate(fakeEvent('blocker!'));

      // First call: the pending buffer flush
      // Second call: the immediate event
      assert.equal(calls.length, 2, 'should have two send calls');
      assert.equal(calls[0].content, 'buffered-1\nbuffered-2');
      assert.equal(calls[1].content, 'blocker!');
      assert.equal(batcher.pending, 0);

      await batcher.destroy();
    });

    it('sends immediately when buffer is empty', async () => {
      const { fn, calls } = createSend();
      const batcher = new MessageBatcher(fn, undefined, { maxBatchSize: 10, flushIntervalMs: 60_000 });

      await batcher.enqueueImmediate(fakeEvent('urgent'));

      assert.equal(calls.length, 1);
      assert.equal(calls[0].content, 'urgent');

      await batcher.destroy();
    });
  });

  describe('timer-based flush', () => {
    it('flushes on interval', async () => {
      const { fn, calls } = createSend();
      const batcher = new MessageBatcher(fn, undefined, { maxBatchSize: 100, flushIntervalMs: 50 });
      batcher.start();

      batcher.enqueue(fakeEvent('timed-1'));
      batcher.enqueue(fakeEvent('timed-2'));

      // Wait longer than flushIntervalMs
      await new Promise((r) => setTimeout(r, 120));

      assert.ok(calls.length >= 1, 'timer should have triggered at least one flush');
      assert.equal(calls[0].content, 'timed-1\ntimed-2');
      assert.equal(batcher.pending, 0);

      await batcher.destroy();
    });

    it('stop prevents further timer flushes', async () => {
      const { fn, calls } = createSend();
      const batcher = new MessageBatcher(fn, undefined, { maxBatchSize: 100, flushIntervalMs: 30 });
      batcher.start();
      batcher.stop();

      batcher.enqueue(fakeEvent('orphan'));
      await new Promise((r) => setTimeout(r, 80));

      assert.equal(calls.length, 0, 'no flush after stop');
      // Cleanup without triggering flush timer
      batcher.stop(); // idempotent
      // Manually drain for cleanup
      await batcher.destroy();
    });
  });

  describe('destroy', () => {
    it('flushes remaining buffer on destroy', async () => {
      const { fn, calls } = createSend();
      const batcher = new MessageBatcher(fn, undefined, { maxBatchSize: 100, flushIntervalMs: 60_000 });

      batcher.enqueue(fakeEvent('leftover-1'));
      batcher.enqueue(fakeEvent('leftover-2'));

      await batcher.destroy();

      assert.equal(calls.length, 1);
      assert.equal(calls[0].content, 'leftover-1\nleftover-2');
    });

    it('is idempotent — second destroy is no-op', async () => {
      const { fn, calls } = createSend();
      const batcher = new MessageBatcher(fn, undefined, { maxBatchSize: 100, flushIntervalMs: 60_000 });

      batcher.enqueue(fakeEvent('once'));
      await batcher.destroy();
      await batcher.destroy(); // second call

      assert.equal(calls.length, 1, 'only flushed once');
    });

    it('enqueue after destroy is silently ignored', async () => {
      const { fn, calls } = createSend();
      const batcher = new MessageBatcher(fn, undefined, { maxBatchSize: 2, flushIntervalMs: 60_000 });
      await batcher.destroy();

      batcher.enqueue(fakeEvent('post-destroy'));
      await new Promise((r) => setTimeout(r, 10));

      assert.equal(calls.length, 0, 'no sends after destroy');
    });
  });

  describe('empty buffer', () => {
    it('flush of empty buffer is no-op', async () => {
      const { fn, calls } = createSend();
      const batcher = new MessageBatcher(fn, undefined, { maxBatchSize: 100, flushIntervalMs: 60_000 });
      batcher.start();

      // Force a timer tick with an empty buffer
      await new Promise((r) => setTimeout(r, 10));
      await batcher.destroy();

      // Only the destroy-triggered flush, which should also be a no-op
      assert.equal(calls.length, 0, 'no sends for empty buffer');
    });
  });

  describe('single-item flush', () => {
    it('handles a single item in buffer at destroy', async () => {
      const { fn, calls } = createSend();
      const batcher = new MessageBatcher(fn, undefined, { maxBatchSize: 100, flushIntervalMs: 60_000 });

      batcher.enqueue(fakeEvent('solo'));
      await batcher.destroy();

      assert.equal(calls.length, 1);
      assert.equal(calls[0].content, 'solo');
      assert.equal(calls[0].embeds.length, 0);
      assert.equal(calls[0].components.length, 0);
    });
  });

  describe('error handling', () => {
    it('logs error and continues when send throws', async () => {
      let attempt = 0;
      const sendFn = async () => {
        attempt++;
        throw new Error('Discord rate limit');
      };
      const { logger, errors, warns } = createLogger();
      const batcher = new MessageBatcher(sendFn, logger, { maxBatchSize: 2, flushIntervalMs: 60_000 });

      batcher.enqueue(fakeEvent('x'));
      batcher.enqueue(fakeEvent('y')); // triggers flush
      // Wait for flush + retry
      await new Promise((r) => setTimeout(r, 1500));

      assert.ok(errors.length >= 1, 'should have logged an error');
      assert.ok(warns.length >= 1, 'should have logged a warning on retry failure');
      assert.equal(batcher.pending, 0, 'buffer cleared even on error');

      // Batcher should still be alive — enqueue more
      batcher.enqueue(fakeEvent('after-error'));
      assert.equal(batcher.pending, 1, 'can still enqueue after error');

      await batcher.destroy();
    });

    it('succeeds on retry if first attempt fails', async () => {
      let attempt = 0;
      const calls: SendPayload[] = [];
      const sendFn = async (payload: SendPayload) => {
        attempt++;
        if (attempt === 1) throw new Error('transient');
        calls.push(payload);
      };
      const { logger, errors } = createLogger();
      const batcher = new MessageBatcher(sendFn, logger, { maxBatchSize: 2, flushIntervalMs: 60_000 });

      batcher.enqueue(fakeEvent('retry-me'));
      batcher.enqueue(fakeEvent('retry-too'));
      // Wait for flush + retry delay
      await new Promise((r) => setTimeout(r, 1500));

      assert.equal(errors.length, 1, 'logged one error on first attempt');
      assert.equal(calls.length, 1, 'retry succeeded');
      assert.equal(calls[0].content, 'retry-me\nretry-too');

      await batcher.destroy();
    });
  });

  describe('buffer at exactly capacity', () => {
    it('flushes at exactly maxBatchSize', async () => {
      const { fn, calls } = createSend();
      const batcher = new MessageBatcher(fn, undefined, { maxBatchSize: 4, flushIntervalMs: 60_000 });

      batcher.enqueue(fakeEvent('1'));
      batcher.enqueue(fakeEvent('2'));
      batcher.enqueue(fakeEvent('3'));
      assert.equal(calls.length, 0, 'not flushed at 3/4');

      batcher.enqueue(fakeEvent('4')); // exactly at capacity
      await new Promise((r) => setTimeout(r, 10));

      assert.equal(calls.length, 1);
      assert.equal(calls[0].content, '1\n2\n3\n4');

      await batcher.destroy();
    });
  });

  describe('components handling', () => {
    it('uses components from the last event that has them', async () => {
      const { fn, calls } = createSend();
      const batcher = new MessageBatcher(fn, undefined, { maxBatchSize: 3, flushIntervalMs: 60_000 });

      const fakeRow = { type: 'ActionRow', components: [] };
      batcher.enqueue(fakeEvent('no-components'));
      batcher.enqueue({ content: 'with-components', components: [fakeRow] } as any);
      batcher.enqueue(fakeEvent('also-no-components')); // triggers flush

      await new Promise((r) => setTimeout(r, 10));

      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0].components, [fakeRow]);

      await batcher.destroy();
    });
  });
});
