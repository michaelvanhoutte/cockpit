//
// The lint layer, run against text ("Add the lint layer the code is already
// written against", issue 282).
//
// What can go wrong in `eslint.config.mjs` is not the rules - those are the
// React team's and ESLint's own - but which files they reach. Every case here
// is a `files` glob: the hooks rules only under `apps/web`, the focused-test
// ban in every runner's test files, the dependency table under a unit folder
// and not one level up. `pnpm lint` is the sixth case in the issue's list, the
// repository itself coming back clean, and it is the CI job rather than a test.
//
// At the root rather than in a package, for the reason `tests/e2e` is: the
// config belongs to no package. Not in `scripts/lib`, whose CI job is
// checkout-only and could not import ESLint.
//

import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { before, describe, it } from 'node:test';

import { ESLint } from 'eslint';

const repo = join(dirname(fileURLToPath(import.meta.url)), '../..');

/** One instance for every case: constructing it reads and resolves the config. */
let eslint;
before(() => {
  eslint = new ESLint({ cwd: repo });
});

/** The rule ids reported for `code` had it been saved at `filePath`. */
async function rulesFiredOn(code, filePath) {
  const [result] = await eslint.lintText(code, { filePath: join(repo, filePath) });
  return result.messages.map((m) => m.ruleId ?? m.message);
}

const EFFECT_MISSING_A_DEPENDENCY = [
  "import { useEffect } from 'react';",
  'export function Panel({ name }: { name: string }) {',
  '  useEffect(() => {',
  '    console.log(name);',
  '  }, []);',
  '  return null;',
  '}',
].join('\n');

describe('the lint layer', () => {
  it('objects to a hook with a missing dependency', async () => {
    assert.deepEqual(await rulesFiredOn(EFFECT_MISSING_A_DEPENDENCY, 'apps/web/src/Panel.tsx'), [
      'react-hooks/exhaustive-deps',
    ]);
  });

  it('lets a suppression suppress, which is what the five already written do', async () => {
    const suppressed = EFFECT_MISSING_A_DEPENDENCY.replace(
      '  }, []);',
      '    // eslint-disable-next-line react-hooks/exhaustive-deps\n  }, []);',
    );
    assert.deepEqual(await rulesFiredOn(suppressed, 'apps/web/src/Panel.tsx'), []);
  });

  it('objects to a suppression the rule no longer needs, so each stays a decision', async () => {
    const stale = [
      "import { useEffect } from 'react';",
      'export function Panel() {',
      '  useEffect(() => {',
      '    // eslint-disable-next-line react-hooks/exhaustive-deps',
      '  }, []);',
      '  return null;',
      '}',
    ].join('\n');
    const fired = await rulesFiredOn(stale, 'apps/web/src/Panel.tsx');
    assert.equal(fired.length, 1);
    assert.match(fired[0], /Unused eslint-disable directive/);
  });

  it('objects to a hook called inside a condition', async () => {
    const conditional = [
      "import { useEffect } from 'react';",
      'export function Panel({ open }: { open: boolean }) {',
      '  if (open) useEffect(() => {}, []);',
      '  return null;',
      '}',
    ].join('\n');
    assert.deepEqual(await rulesFiredOn(conditional, 'apps/web/src/Panel.tsx'), [
      'react-hooks/rules-of-hooks',
    ]);
  });

  it('leaves the hooks rules inside apps/web, which is the only React there is', async () => {
    // Both paths are linted by another block, so an empty result is the hooks
    // rules staying silent rather than the file not being reached at all - the
    // way an unmatched path would answer.
    for (const filePath of ['apps/api/tests/unit/Panel.tsx', 'tests/e2e/panel.test.ts']) {
      assert.deepEqual(await rulesFiredOn(EFFECT_MISSING_A_DEPENDENCY, filePath), [], filePath);
    }
  });

  it('objects to a focused test, in whichever shape it is written', async () => {
    const shapes = [
      ["it.only('x', () => {});", 'apps/api/tests/unit/focused.test.ts'],
      ["describe.only('x', () => {});", 'packages/shared/tests/unit/focused.test.ts'],
      ["test.describe.only('x', () => {});", 'tests/e2e/focused.test.ts'],
      ["it.only.each([1])('x', () => {});", 'apps/web/tests/unit/focused.test.tsx'],
      ["it.only('x', () => {});", 'scripts/lib/focused.test.mjs'],
      // Not a `.test.` file: the browser tier's support folder, where a helper
      // wrapping `test.describe` narrows the suite just as a walk would.
      ["test.describe.only('x', () => {});", 'tests/e2e/support/app.ts'],
    ];
    for (const [code, filePath] of shapes) {
      assert.deepEqual(await rulesFiredOn(code, filePath), ['no-restricted-syntax'], filePath);
    }
  });

  it('leaves an unfocused test alone', async () => {
    const code = ["it('x', () => {});", "describe.each([1])('y', () => {});"].join('\n');
    assert.deepEqual(await rulesFiredOn(code, 'apps/api/tests/unit/ordinary.test.ts'), []);
  });

  it('objects to a database import under a unit folder', async () => {
    const reachesTheDatabase = [
      ["import { env } from 'cloudflare:test';", 'apps/api/tests/unit/db.test.ts'],
      ["import { drizzle } from 'drizzle-orm/d1';", 'apps/api/tests/unit/db.test.ts'],
      ["import { readFileSync } from 'node:fs';", 'apps/api/tests/unit/db.test.ts'],
      ["import { request } from 'node:https';", 'apps/web/tests/unit/db.test.ts'],
      // A unit folder written in JavaScript is still a unit folder, which is
      // what `tools/*/tests/unit` is.
      ["import { readFileSync } from 'node:fs';", 'tools/test-explorer/tests/unit/db.test.js'],
    ];
    for (const [code, filePath] of reachesTheDatabase) {
      assert.deepEqual(await rulesFiredOn(code, filePath), ['no-restricted-imports'], code);
    }
  });

  it('lets the same import through one level up, where the level allows it', async () => {
    const code = "import { env } from 'cloudflare:test';";
    assert.deepEqual(await rulesFiredOn(code, 'apps/api/tests/integration/db.test.ts'), []);
  });

  it("leaves a unit test's own source imports alone, however the folders are named", async () => {
    // The restricted names are matched exactly, not as patterns: written as a
    // pattern, a bare `http` in the list is matched gitignore-style and reaches
    // `src/http/app.js`, which is the Worker's own routing module and the entry
    // point of an L1 test that already exists.
    const code = [
      "import { app } from '../../../src/http/app.js';",
      "import { CommandRefused } from '../../../src/api/client';",
    ].join('\n');
    assert.deepEqual(await rulesFiredOn(code, 'apps/api/tests/unit/http/app.test.ts'), []);
  });
});
