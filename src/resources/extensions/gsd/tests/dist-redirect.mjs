const ROOT = new URL("../../../../../", import.meta.url);

export function resolve(specifier, context, nextResolve) {
  // 1. Direct redirects to dist/ for specific packages
  if (specifier === "../../packages/pi-coding-agent/src/index.js") {
    specifier = new URL("packages/pi-coding-agent/dist/index.js", ROOT).href;
  } else if (specifier === "@gsd/pi-ai/oauth") {
    specifier = new URL("packages/pi-ai/dist/utils/oauth/index.js", ROOT).href;
  } else if (specifier === "@gsd/pi-ai") {
    specifier = new URL("packages/pi-ai/dist/index.js", ROOT).href;
  } else if (specifier === "@gsd/pi-agent-core") {
    specifier = new URL("packages/pi-agent-core/dist/index.js", ROOT).href;
  } else if (specifier === "@gsd/pi-tui") {
    specifier = new URL("packages/pi-tui/dist/index.js", ROOT).href;
  }
  // 2. Redirect packages/*/dist/ → packages/*/src/ with .js→.ts for strip-types
  else if (specifier.endsWith('.js') && (specifier.startsWith('./') || specifier.startsWith('../'))) {
    if (context.parentURL && context.parentURL.includes('/src/')) {
      if (specifier.includes('/dist/')) {
        specifier = specifier.replace('/dist/', '/src/').replace(/\.js$/, '.ts');
      } else {
        specifier = specifier.replace(/\.js$/, '.ts');
      }
    }
  }

  return nextResolve(specifier, context);
}
