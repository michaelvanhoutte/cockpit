//
// Two halves, and both are needed. The first proves the matcher can tell a
// press of a workspace tab from every other press, against text written here.
// The second runs it over the walks themselves, which is the half that actually
// gates: a new walk pressing the tab directly turns this red in seconds rather
// than turning CI red once a fortnight.
//

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { THE_WAY, tabsPressedWithoutWaiting } from './e2e-conventions.mjs';

const walks = join(dirname(fileURLToPath(import.meta.url)), '../../tests/e2e');

describe('tabsPressedWithoutWaiting', () => {
  it('catches the tab pressed where it is found', () => {
    const found = tabsPressedWithoutWaiting('await press(workspaceTab(page, name), isMobile);');
    assert.equal(found.length, 1);
    assert.equal(found[0].line, 1);
  });

  it('catches the tab held in a variable first, which is the shape that shipped', () => {
    const found = tabsPressedWithoutWaiting(
      ['const mine = workspaceTab(page, workspace);', 'await expect(mine).toBeVisible();', 'await press(mine, isMobile);'].join('\n'),
    );
    assert.equal(found.length, 1);
    assert.equal(found[0].line, 3);
  });

  it('leaves every other press alone', () => {
    const source = [
      'const tab = dashboardBar(page).getByRole("link", { name });',
      'await press(tab, isMobile);',
      'await press(page.getByRole("button", { name: "Capture" }), isMobile);',
      `await ${THE_WAY}(page, workspace, isMobile);`,
      'await expect(workspaceTab(page, workspace)).toBeVisible();',
    ].join('\n');
    assert.deepEqual(tabsPressedWithoutWaiting(source), []);
  });
});

describe('the browser walks', () => {
  it(`change workspace only through ${THE_WAY}`, () => {
    // Recursive, because Playwright's `testMatch` is (`**/*.test.ts`, against
    // `testDir: 'tests/e2e'`): a walk in a subdirectory would run and go
    // unscanned, which is the one case this gate exists for. `.test.ts` rather
    // than every file, which also keeps `support/app.ts` out - it is where the
    // press belongs.
    const offences = readdirSync(walks, { recursive: true })
      .filter((name) => name.endsWith('.test.ts'))
      .flatMap((name) =>
        tabsPressedWithoutWaiting(readFileSync(join(walks, name), 'utf8')).map(
          (found) => `${name}:${found.line}  ${found.text}`,
        ),
      );
    assert.deepEqual(
      offences,
      [],
      `press a workspace tab through ${THE_WAY} (tests/e2e/support/app.ts), which waits for the ` +
        `switch to land - otherwise the walk acts on the workspace it just left:\n  ${offences.join('\n  ')}`,
    );
  });
});
