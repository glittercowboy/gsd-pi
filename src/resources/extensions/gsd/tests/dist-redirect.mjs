import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

const ROOT = new URL("../../../../../", import.meta.url);

export function resolve(specifier, context, nextResolve) {
  // 1. Redirect all workspace package bare imports to source.
  //    CI portability runs don't build any packages/ dist artifacts, so every
  //    @gsd/* specifier (including transitive ones pulled in by pi-coding-agent
  //    source itself) must resolve to the TypeScript source entrypoint.
  if (specifier === "../../packages/pi-coding-agent/src/index.js") {
    specifier = new URL("packages/pi-coding-agent/src/index.ts", ROOT).href;
  } else if (specifier === "@gsd/pi-coding-agent") {
    specifier = new URL("packages/pi-coding-agent/src/index.ts", ROOT).href;
  } else if (specifier === "@gsd/pi-ai/oauth") {
    specifier = new URL("packages/pi-ai/src/utils/oauth/index.ts", ROOT).href;
  } else if (specifier === "@gsd/pi-ai") {
    specifier = new URL("packages/pi-ai/src/index.ts", ROOT).href;
  } else if (specifier === "@gsd/pi-agent-core") {
    specifier = new URL("packages/pi-agent-core/src/index.ts", ROOT).href;
  } else if (specifier === "@gsd/pi-tui") {
    specifier = new URL("packages/pi-tui/src/index.ts", ROOT).href;
  } else if (specifier === "@gsd/native") {
    specifier = new URL("packages/native/src/index.ts", ROOT).href;
  } else if (specifier.startsWith("@gsd/native/")) {
    // Sub-path imports like @gsd/native/fd, @gsd/native/text, etc.
    const subpath = specifier.slice("@gsd/native/".length);
    specifier = new URL(`packages/native/src/${subpath}/index.ts`, ROOT).href;
  }
  // 2. Redirect packages/*/dist/ → packages/*/src/ with .js→.ts for strip-types
  //    Also handles local imports — skip rewrite for dist/ paths that are real compiled artifacts.

  else if (specifier.endsWith('.js') && (specifier.startsWith('./') || specifier.startsWith('../'))) {
    if (context.parentURL && context.parentURL.includes('/src/')) {
      if (specifier.includes('/dist/')) {
        specifier = specifier.replace('/dist/', '/src/').replace(/\.js$/, '.ts');
      } else {
        specifier = specifier.replace(/\.js$/, '.ts');
      }
    }
  }
  // 3. Extensionless relative imports from web/ (Next.js convention).
  //    Transpiled .tsx files emit extensionless imports — try .ts then .tsx.
  else if (
    (specifier.startsWith('./') || specifier.startsWith('../')) &&
    !specifier.match(/\.\w+$/) &&
    context.parentURL &&
    context.parentURL.includes('/web/')
  ) {
    const baseUrl = new URL(specifier, context.parentURL);
    for (const ext of ['.ts', '.tsx']) {
      const candidate = fileURLToPath(baseUrl) + ext;
      if (existsSync(candidate)) {
        specifier = baseUrl.href + ext;
        break;
      }

    }
  }

  return nextResolve(specifier, context);
}

export function load(url, context, nextLoad) {
  // Node's --experimental-strip-types handles plain .ts but not .tsx and not
  // all TypeScript syntax used by workspace packages (parameter properties,
  // decorators, etc.). Transpile all workspace package source files and .tsx
  // files through TypeScript's transpileModule to avoid those crashes.
  const shouldTranspileWithTypeScript =
    url.endsWith('.tsx') ||
    (url.endsWith('.ts') && url.includes('/packages/') && url.includes('/src/'));

  if (shouldTranspileWithTypeScript) {
    const ts = require('typescript');
    const source = readFileSync(fileURLToPath(url), 'utf-8');
    const { outputText } = ts.transpileModule(source, {
      fileName: fileURLToPath(url),
      compilerOptions: {
        jsx: ts.JsxEmit.ReactJSX,
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ESNext,
        esModuleInterop: true,
        experimentalDecorators: true,
        emitDecoratorMetadata: true,
      },
    });
    // Inject CJS-compatible globals (__dirname, __filename, require) so that
    // workspace packages compiled as ESM can still use them.  This avoids the
    // need for import.meta.url behind indirect invocation patterns that fail in
    // CJS and in dynamically-created scopes.
    // Only inject globals that the source file doesn't already declare itself.
    const preambleLines = [
      'import { fileURLToPath as __preamble_fUTP } from "node:url";',
      'import { dirname as __preamble_dn } from "node:path";',
      'import { createRequire as __preamble_cR } from "node:module";',
    ];
    if (!outputText.includes('const __filename') && !outputText.includes('let __filename')) {
      preambleLines.push('const __filename = __preamble_fUTP(import.meta.url);');
    }
    if (!outputText.includes('const __dirname') && !outputText.includes('let __dirname')) {
      preambleLines.push('const __dirname = __preamble_dn(__preamble_fUTP(import.meta.url));');
    }
    if (!outputText.includes('const require') && !outputText.includes('let require')) {
      preambleLines.push('const require = __preamble_cR(import.meta.url);');
    }
    return { format: 'module', source: preambleLines.join('\n') + '\n' + outputText, shortCircuit: true };
  }
  return nextLoad(url, context);
}
