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
    // outside this too. `.claude/` is on the CI-skip classifier's non-product
    // allowlist (scripts/lib/what-changed.mjs, "Skip the mechanical checks on
    // a pull request that touches nothing they cover", issue 345), which holds
    // only because a documentation-only diff never reaches `Lint` - a `.js`
    // file added there later would otherwise match one of the `files:` globs
    // below (flat config lints dot-directories by default) and be read by a
    // job the allowlist says cannot see it.
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
      '.claude/**',
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
    // Every runner's test files: vitest under the packages and `tools`,
    // node:test under `scripts/lib`, Playwright under `tests/e2e` - and the
    // browser tier's support files too, since a `.only` on a wrapper of
    // `test.describe` there narrows the suite exactly as one in a walk does.
    files: ['**/*.test.{ts,tsx,mts,mjs,js}', 'tests/e2e/**/*.ts'],
    languageOptions,
    rules: { 'no-restricted-syntax': ['error', ...focusedTest] },
  },

  {
    // The testing strategy's dependency table for L1/F1, as the one part of it
    // a rule can hold: "L1/F1 may not touch: filesystem, network, database". A
    // folder is what gets policed, which is why the levels are folders. Why the
    // API client is not on the list, and what this misses that a runner-level
    // block would catch, are in testing-strategy.md under "Enforcement".
    //
    // `.js` as well as `.ts`, because `tools/*/tests/unit` is JavaScript and is
    // a unit folder like any other.
    files: ['**/tests/unit/**/*.{ts,tsx,js,mjs}'],
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
