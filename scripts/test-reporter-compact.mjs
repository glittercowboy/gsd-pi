/**
 * Compact test reporter: silent on pass, prints failures + final summary.
 * Usage: --test-reporter=./scripts/test-reporter-compact.mjs
 */
import { Transform } from 'node:stream';

export default class CompactReporter extends Transform {
  #pass = 0;
  #fail = 0;
  #skip = 0;
  #failures = [];

  constructor() {
    super({ objectMode: true });
  }

  _transform(event, _enc, cb) {
    switch (event.type) {
      case 'test:pass':
        if (!event.data.skip) this.#pass++;
        else this.#skip++;
        break;
      case 'test:fail': {
        this.#fail++;
        const { name, details } = event.data;
        const err = details?.error;
        const msg = err?.message ?? String(err ?? 'unknown');
        const loc = err?.cause?.stack?.split('\n')[1]?.trim() ?? '';
        this.#failures.push(`  ✖ ${name}\n    ${msg}${loc ? `\n    ${loc}` : ''}`);
        break;
      }
    }
    cb();
  }

  _flush(cb) {
    if (this.#failures.length) {
      this.push(`\n✖ failing tests:\n${this.#failures.join('\n\n')}\n`);
    }
    const status = this.#fail === 0 ? '✔' : '✖';
    this.push(`\n${status} ${this.#pass} passed, ${this.#fail} failed, ${this.#skip} skipped\n`);
    cb();
  }
}
