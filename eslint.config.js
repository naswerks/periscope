import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import tseslint from 'typescript-eslint';

// The privileged modules. `host/` may import these; nothing else may.
const PRIVILEGED = ['node:fs', 'node:fs/promises', 'node:child_process', 'node:os'];

// Editor-time half of a two-mechanism boundary. The other half is the tree-walking pin test in
// src/pins/, which survives this file being edited, disabled, or deleted.
const hostBoundary = {
  'no-restricted-imports': [
    'error',
    {
      paths: PRIVILEGED.map((name) => ({
        name,
        message: `${name} is confined to src/host/ — route it through a host/ primitive instead.`,
      })),
    },
  ],
};

export default defineConfig([
  globalIgnores(['dist/**', 'node_modules/**', 'coverage/**', 'reports/**', '.stryker-tmp/**']),
  {
    // The package and the examples each have a tsconfig, so the type-aware rules build a program
    // from the nearest one; the examples are a CONSUMER of the package and are held to the same set.
    files: ['src/**/*.ts', 'examples/**/*.ts'],
    extends: [js.configs.recommended, tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      ...hostBoundary,
      // An identifier that starts with an underscore is declared unused on purpose (a loop variable
      // that only drives iteration, a destructured member being discarded); the rule's own patterns
      // name that convention rather than a rename of every site.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          varsIgnorePattern: '^_',
          argsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
      // node:test's test(), describe() and it() return promises the runner itself awaits; the rule's
      // own allowance for known-safe calls names them so a test declaration is not a dropped promise.
      '@typescript-eslint/no-floating-promises': [
        'error',
        {
          allowForKnownSafeCalls: [
            { from: 'package', package: 'node:test', name: ['test', 'describe', 'it', 'suite'] },
          ],
        },
      ],
    },
  },
  {
    files: ['src/host/**/*.ts'],
    rules: { 'no-restricted-imports': 'off' },
  },
  {
    // src/pins/ reads the source tree to enforce the boundary, so it holds the exemption the
    // boundary exists to grant. Nothing in it reaches a consumer, and reachability.test.ts proves
    // that rather than asserting it. The examples may open a socket and read a disk — that is what
    // a controller does — so the confinement rule does not apply to them either.
    files: ['src/pins/**/*.ts', 'src/test-support/**/*.ts', 'src/**/*.test.ts', 'examples/**/*.ts'],
    rules: { 'no-restricted-imports': 'off' },
  },
  {
    // A test fake of an async interface is written `async () => value` so its shape matches the
    // interface it stands in for; it has nothing to await, and rewriting hundreds of stubs as
    // `() => Promise.resolve(value)` would trade a readable fake for the rule. Shipped code keeps
    // the rule.
    files: ['src/pins/**/*.ts', 'src/test-support/**/*.ts', 'src/**/*.test.ts'],
    rules: { '@typescript-eslint/require-await': 'off' },
  },
  {
    // The scripts and this file are plain JavaScript with no program behind them.
    files: ['**/*.{js,mjs}'],
    extends: [js.configs.recommended, tseslint.configs.disableTypeChecked],
    languageOptions: { globals: { process: 'readonly', console: 'readonly', URL: 'readonly' } },
  },
]);
