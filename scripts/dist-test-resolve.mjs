/**
 * Minimal Node.js import hook for running tests from dist-test/.
 *
 * esbuild with bundle:false preserves import specifiers verbatim, so compiled
 * .js files still import '../foo.ts'. This hook redirects those to '.js' so
 * Node can find the compiled output.
 *
 * Also redirects @gsd bare imports to their compiled counterparts in dist-test.
 */

import { fileURLToPath, pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

// dist-test root — everything compiled lands here
const DIST_TEST = new URL('../dist-test/', import.meta.url).href;

// Absolute paths to compiled @gsd/* entry points
const GSD_ALIASES = {
  '@gsd/pi-coding-agent': new URL('../dist-test/packages/pi-coding-agent/src/index.js', import.meta.url).href,
  '@gsd/pi-ai/oauth':     new URL('../dist-test/packages/pi-ai/src/utils/oauth/index.js', import.meta.url).href,
  '@gsd/pi-ai':           new URL('../dist-test/packages/pi-ai/src/index.js', import.meta.url).href,
  '@gsd/pi-agent-core':   new URL('../dist-test/packages/pi-agent-core/src/index.js', import.meta.url).href,
  '@gsd/pi-tui':          new URL('../dist-test/packages/pi-tui/src/index.js', import.meta.url).href,
  '@gsd/native':          new URL('../dist-test/packages/native/src/index.js', import.meta.url).href,
};

export function resolve(specifier, context, nextResolve) {
  // 1. @gsd/* bare imports → compiled dist-test counterpart
  if (specifier in GSD_ALIASES) {
    return nextResolve(GSD_ALIASES[specifier], context);
  }

  // 2. .ts relative imports inside dist-test → .js
  if (
    specifier.endsWith('.ts') &&
    (specifier.startsWith('./') || specifier.startsWith('../')) &&
    context.parentURL &&
    context.parentURL.startsWith(DIST_TEST)
  ) {
    const jsSpecifier = specifier.slice(0, -3) + '.js';
    return nextResolve(jsSpecifier, context);
  }

  return nextResolve(specifier, context);
}
