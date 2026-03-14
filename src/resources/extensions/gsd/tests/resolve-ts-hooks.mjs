// ESM resolve hook: .js → .ts rewriting for test environments.
// Only rewrites relative imports from our own source files — not from node_modules.
//
// Handles two patterns:
// 1. .js → .ts  (pi bundler convention: source files use .js specifiers)
// 2. extensionless → .ts  (some source files omit extensions in relative imports)

export function resolve(specifier, context, nextResolve) {
  const parentURL = context.parentURL || '';
  const isFromNodeModules = parentURL.includes('/node_modules/');
  const isFromDist = parentURL.includes('/dist/');

  if (!isFromNodeModules && !isFromDist && !specifier.startsWith('node:')) {
    // Rewrite .js → .ts
    if (specifier.endsWith('.js')) {
      const tsSpecifier = specifier.replace(/\.js$/, '.ts');
      try {
        return nextResolve(tsSpecifier, context);
      } catch {
        // fall through to default resolution
      }
    }

    // Try adding .ts to extensionless relative imports
    if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) {
      try {
        return nextResolve(specifier + '.ts', context);
      } catch {
        // fall through to default resolution
      }
    }
  }

  return nextResolve(specifier, context);
}
