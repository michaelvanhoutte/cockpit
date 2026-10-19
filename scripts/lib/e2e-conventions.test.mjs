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

import {
  STILL_CAPTURING_BY_HAND,
  THE_CAPTURING_AREA,
  THE_SIGN_IN_SPEC,
  THE_WAY,
  capturedThroughTheUi,
  issuerDrivenByHand,
  tabsPressedWithoutWaiting,
} from './e2e-conventions.mjs';

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

describe('issuerDrivenByHand', () => {
  it('names the press of Continue with Google, with its line', () => {
    const found = issuerDrivenByHand(
      [
        "await page.goto('/signin');",
        "await press(page.getByRole('link', { name: 'Continue with Google' }), isMobile);",
      ].join('\n'),
    );
    assert.deepEqual(found, [
      { line: 2, text: "await press(page.getByRole('link', { name: 'Continue with Google' }), isMobile);" },
    ]);
  });

  it('names the link held in a variable, and one pressed over several lines, where it is taken hold of', () => {
    const found = issuerDrivenByHand(
      [
        "const google = page.getByRole('link', { name: 'Continue with Google' });",
        'await press(google, isMobile);',
        'await press(',
        "  page.getByRole('link', { name: 'Continue with Google' }),",
        '  isMobile,',
        ');',
      ].join('\n'),
    );
    assert.deepEqual(
      found.map((f) => f.line),
      [1, 4],
    );
  });

  it('leaves every other press alone, a look at the logon page, and a comment about it', () => {
    const source = [
      "await press(page.getByRole('link', { name: 'Continue as guest' }), isMobile);",
      'await signIn(page, MICHAEL, isMobile);',
      "await expect(page.getByRole('link', { name: 'Continue with Google' })).toBeVisible();",
      '// The logon page offers Continue with Google and nothing else.',
      ' * A walk about the logon page sees Continue with Google and never presses it.',
    ].join('\n');
    assert.deepEqual(issuerDrivenByHand(source), []);
  });
});

describe('the browser walks and the issuer', () => {
  it(`are signed in through signIn, except ${THE_SIGN_IN_SPEC}`, () => {
    const offences = readdirSync(walks, { recursive: true })
      .filter((name) => name.endsWith('.test.ts') && name !== THE_SIGN_IN_SPEC)
      .flatMap((name) =>
        issuerDrivenByHand(readFileSync(join(walks, name), 'utf8')).map(
          (found) => `${name}:${found.line}  ${found.text}`,
        ),
      );
    assert.deepEqual(
      offences,
      [],
      `sign in through signIn (tests/e2e/support/app.ts), which loads the sign-in the run made once per ` +
        `person - only ${THE_SIGN_IN_SPEC} drives the issuer:\n  ${offences.join('\n  ')}`,
    );
  });
});

describe('capturedThroughTheUi', () => {
  it('names a capture outside the walks of Capture, with its line', () => {
    const found = capturedThroughTheUi(
      [
        "test.describe('Triage', () => {",
        "  test('dismisses an item', async ({ page, isMobile }) => {",
        '    await capture(page, thought, isMobile);',
        '  });',
        '});',
      ].join('\n'),
    );
    assert.deepEqual(found, [{ line: 3, text: 'await capture(page, thought, isMobile);' }]);
  });

  it(`allows a capture inside the ${THE_CAPTURING_AREA} area, however deep, and names the next one after it closes`, () => {
    const found = capturedThroughTheUi(
      [
        `test.describe('${THE_CAPTURING_AREA}', () => {`,
        "  test.describe('a note captured is kept', () => {",
        "    test('keeps it', async ({ page, isMobile }) => {",
        '      await capture(page, note, isMobile);',
        '    });',
        '  });',
        '});',
        '',
        "test.describe('Triage', () => {",
        '  await capture(page, note, isMobile);',
        '});',
      ].join('\n'),
    );
    assert.deepEqual(
      found.map((f) => f.line),
      [10],
    );
  });

  it('reads the area from a describe nested inside another, closing at its own indent', () => {
    const found = capturedThroughTheUi(
      [
        "test.describe('Inbox', () => {",
        `  test.describe('${THE_CAPTURING_AREA}', () => {`,
        '    await capture(page, note, isMobile);',
        '  });',
        '  await capture(page, other, isMobile);',
        '});',
      ].join('\n'),
    );
    assert.deepEqual(
      found.map((f) => f.line),
      [5],
    );
  });

  it('leaves the helper’s own definition, its import, and a comment about it alone', () => {
    const source = [
      'export async function capture(page: Page, title: string, isMobile: boolean): Promise<void> {',
      '  capture,',
      '// A walk calls capture(page, title) only inside Capture.',
      ' * Used as arrangement by tests; capture(page, title, isMobile) waits for the Inbox.',
      "  await page.getByRole('button', { name: 'Capture' }).click();",
      '  await expect(capturedLine(page, note)).toBeVisible();',
      '  await page.screenshot();',
    ].join('\n');
    assert.deepEqual(capturedThroughTheUi(source), []);
  });

  it('passes a walk that arranges through the API helpers', () => {
    const source = [
      "test.describe('Selection', () => {",
      "  test('picks three', async ({ page, isMobile }) => {",
      '    await signIn(page, ADA, isMobile);',
      '    await giveToTheInbox(page, [first, second, third]);',
      '    await page.reload();',
      '  });',
      '});',
    ].join('\n');
    assert.deepEqual(capturedThroughTheUi(source), []);
  });
});

describe('the browser walks and capturing', () => {
  const counts = () =>
    Object.fromEntries(
      readdirSync(walks, { recursive: true })
        .filter((name) => name.endsWith('.test.ts'))
        .map((name) => [name, capturedThroughTheUi(readFileSync(join(walks, name), 'utf8'))]),
    );

  it(`capture through the UI only in the ${THE_CAPTURING_AREA} area, except the walks still to be rewritten`, () => {
    const offences = Object.entries(counts())
      .filter(([name]) => !(name in STILL_CAPTURING_BY_HAND))
      .flatMap(([name, found]) => found.map((one) => `${name}:${one.line}  ${one.text}`));
    assert.deepEqual(
      offences,
      [],
      `arrange through the commands API (tests/e2e/support/arrange.ts) rather than capturing through the UI - ` +
        `only the ${THE_CAPTURING_AREA} area captures by hand, because it is what it proves:\n  ${offences.join('\n  ')}`,
    );
  });

  it('hold the walks still to be rewritten to the captures they make today, and no more', () => {
    const found = counts();
    const wrong = Object.entries(STILL_CAPTURING_BY_HAND)
      .filter(([name, { calls }]) => (found[name]?.length ?? 0) !== calls)
      .map(
        ([name, { calls, rewrittenWhen }]) =>
          `${name} captures ${found[name]?.length ?? 0} times through the UI, the list says ${calls} ` +
          `(rewritten at ${rewrittenWhen}): write the number it makes now, and drop the entry at 0`,
      );
    assert.deepEqual(wrong, [], `the list of walks still capturing by hand only shrinks:\n  ${wrong.join('\n  ')}`);
  });
});
