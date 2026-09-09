//
// The lint layer, deliberately small ("Add the lint layer the code is already
// written against", issue 282).
//
// It holds three things and nothing else: the React Hooks rules the code was
// already written against, a ban on a focused test reaching `main`, and the
// testing skill's dependency table for L1/F1 as restricted imports. Everything
// else - formatting, naming, style, the hundreds of rules a recommended preset
// brings - is out, because a lint layer that lands with three hundred findings
// gets switched off and the point is a gate that stays on.
//
// ESLint rather than Biome, which the issue left open: Biome is one dependency
// and faster, but the five suppressions already in `apps/web/src` are written
// as `// eslint-disable-next-line react-hooks/exhaustive-deps`, and the rule
// they name is the React team's own. Biome would mean rewriting each as a
// `biome-ignore` against a reimplementation of the rule - a rewrite of the
// decisions this change exists to make enforceable.
//
// No type-aware linting (no `parserOptions.project`): the parser is here to
// read TypeScript, not to type-check it, which `pnpm typecheck` already does
// across every package. Type-aware rules would put a full program build in
// front of every lint run and buy nothing these three rules need.
//

import reactHooks from 'eslint-plugin-react-hooks';
import tsParser from '@typescript-eslint/parser';

/** Reads TypeScript, TSX and plain ES modules alike; nothing here is type-aware. */
const languageOptions = {
  parser: tsParser,
  ecmaVersion: 'latest',
  sourceType: 'module',
  parserOptions: { ecmaFeatures: { jsx: true } },
};

/**
 * The `.only` shapes, as selectors rather than a plugin: `eslint-plugin-vitest`
 * would be a fourth dependency covering one of the two runners here, and
 * Playwright's `test.describe.only` is not a vitest shape at all.
 *
 * Two levels of member expression, because a focused test is written both ways:
 * `it.only(...)` and `test.describe.only(...)`. `it.only.each(...)` is caught by
 * the first, since `it.only` is still in it.
 */
const FOCUSED = ['it', 'test', 'describe', 'suite', 'bench'].join('|');
const focusedTest = [
  `MemberExpression[object.name=/^(${FOCUSED})$/][property.name='only']`,
  `MemberExpression[object.object.name=/^(${FOCUSED})$/][property.name='only']`,
].map((selector) => ({
  selector,
  message: 'A focused test hides the rest of the suite. Remove `.only` before pushing.',
}));

export default [
  {
    // Build output, runtime scratch and failure artefacts. `poc/` is outside
    // the workspace on purpose (readme.md, "Proofs of concept"), so it is
    // outside this too.
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/dev-dist/**',
      '**/coverage/**',
      '**/.wrangler/**',
      'test-results/**',
      'playwright-report/**',
      'tools/*/out/**',
      'poc/**',
    ],
  },

  {
    // What turns a suppression into a decision that stays true: a
    // `// eslint-disable-next-line react-hooks/exhaustive-deps` over an effect
    // the rule no longer objects to fails, rather than sitting on as a comment
    // nobody can tell from a live one. One of the five already here was that,
    // naming a call the effect had stopped making.
    //
    // No `files`, so it holds for every rule below rather than only the hooks
    // pair, and stated rather than left to a default that has differed between
    // ESLint majors.
    linterOptions: { reportUnusedDisableDirectives: 'error' },
  },

  {
    // The two React Hooks rules, and only those two: the plugin's `recommended`
    // now carries the React Compiler's whole rule set, which is the three
    // hundred findings this layer is sized against.
    files: ['apps/web/**/*.{ts,tsx}'],
    languageOptions,
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
    },
  },

  {
    // Every runner's test files: vitest under the packages, node:test under
    // `scripts/lib`, Playwright under `tests/e2e`.
    files: ['**/*.test.{ts,tsx,mts,mjs,js}'],
    languageOptions,
    rules: { 'no-restricted-syntax': ['error', ...focusedTest] },
  },

  {
    // The testing skill's dependency table for L1/F1, as the one part of it a
    // rule can hold: "L1/F1 may not touch: filesystem, network, database". A
    // folder is what gets policed, which is why the levels are folders.
    //
    // The skill also suggests banning API-client imports under a unit folder.
    // Not done, and not an oversight: what the unit tests here import from
    // `src/api/client` is the refusal error class and the module they then
    // mock, neither of which reaches the network. Banning it would fail ten
    // existing tests that are at the right level.
    files: ['**/tests/unit/**/*.{ts,tsx}'],
    languageOptions,
    rules: {
      'no-restricted-imports': [
        'error',
        {
          // `paths` rather than `patterns` for every name that is a name: a
          // pattern is matched gitignore-style, so a bare `http` in the list
          // matches `../../../src/http/app.js` as well - which it did, on the
          // one L1 test that enters the Worker's own routing module.
          paths: [
            ...['node:fs', 'node:fs/promises', 'fs', 'fs/promises'].map((name) => ({
              name,
              message:
                'A unit test may not touch the filesystem. Move it to tests/integration, or take the file read out of the code under test.',
            })),
            ...[
              'node:http',
              'node:https',
              'node:net',
              'node:tls',
              'node:dgram',
              'http',
              'https',
              'net',
              'tls',
              'dgram',
              'undici',
            ].map((name) => ({
              name,
              message:
                'A unit test may not touch the network. Replace the boundary at its edge, or move the test to tests/integration.',
            })),
            ...['cloudflare:test', 'drizzle-orm', 'node:sqlite', 'better-sqlite3'].map((name) => ({
              name,
              message:
                'A unit test may not touch the database. `cloudflare:test` hands over the real bindings; a test that needs them belongs in tests/integration.',
            })),
          ],
          // The one glob that is needed: drizzle is entered through a subpath
          // (`drizzle-orm/d1`) as often as through its root. A slash in the
          // pattern anchors it, so it reaches nothing but that package.
          patterns: [
            {
              group: ['drizzle-orm/*'],
              message:
                'A unit test may not touch the database. A test that needs a real query belongs in tests/integration.',
            },
          ],
        },
      ],
    },
  },
];
