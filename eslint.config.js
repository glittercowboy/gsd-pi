import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // Ignore vendor and build artifacts
  { ignores: ['packages/pi-*/**', 'packages/native/**', 'dist/**', 'dist-test/**', 'node_modules/**'] },

  // GSD packages: strict typed linting (exclude test files — not in tsconfig project)
  {
    files: [
      'packages/gsd-agent-core/src/**/*.ts',
      'packages/gsd-agent-modes/src/**/*.ts',
      'packages/gsd-agent-types/src/**/*.ts',
      'src/**/*.ts',
    ],
    ignores: [
      '**/*.test.ts',
      '**/*.test.mjs',
      // Excluded from root tsconfig.json — covered by tsconfig.extensions.json
      'src/resources/**',
      'src/tests/**',
      'src/web/**',
    ],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      parserOptions: {
        project: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/explicit-function-return-type': ['error', {
        allowExpressions: true,
        allowTypedFunctionExpressions: true,
        allowHigherOrderFunctions: true,
      }],
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/ban-ts-comment': [
        'error',
        {
          'ts-ignore': 'allow-with-description',
          'ts-expect-error': 'allow-with-description',
          minimumDescriptionLength: 15,
        },
      ],
    },
  },
);
