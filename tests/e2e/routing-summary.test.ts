import { expect, expectNoSidewaysScroll, openInbox, press, test, uniqueTitle } from './support/app';

/**
 * F3, for the same reason `item-types.test.ts` beside this file is: the
 * header's menu, opened by a tap or a mouse, leads to a window drawn over
 * the workspace, and a correction saved in it has to still be there once the
 * window is closed and reopened ("Show what the system learned, in a
 * sentence you can correct", issue 301).
 *
 * It is not re-proving the write rules, which
 * apps/api/tests/integration/http/routing-summary-correction.test.ts owns
 * against a real store, nor what a live model would say, which
 * apps/api/tests/contract/summarize-filing-patterns.v1.test.ts owns. One
 * walk for the capability, saying it works for a person.
 *
 * **No decision history to summarize here.** Local dev and this suite run
 * with no `ANTHROPIC_API_KEY` (docs/testing-strategy.md, "A credential on
 * disk reaches every tier"), so the nightly job never runs and the summary
 * itself always reads as the empty state - which is exactly the state this
 * walk exercises, alongside the one thing that is genuinely interactive
 * here: writing and saving a correction.
 */
test.describe('Capture', () => {
  test.describe('what Cockpit has learned is read on a workspace settings screen, and corrected in a sentence', () => {
    test('shows the empty state with nothing filed yet, and keeps a correction after closing and reopening', async ({
      page,
      isMobile,
    }) => {
      await openInbox(page, isMobile);

      await press(page.getByRole('button', { name: 'Settings' }), isMobile);
      await press(page.getByRole('menuitem', { name: 'What Cockpit has learned' }), isMobile);
      await expect(page.getByRole('dialog', { name: 'What Cockpit has learned' })).toBeVisible();
      await expectNoSidewaysScroll(page);
      await expect(page.getByText('Not enough has been filed here yet')).toBeVisible();

      // Unique per run, not a fixed sentence: the desktop and phone projects
      // share one database and one Workspace (support/app.ts, "The register
      // is not rebuilt between the two projects"), so the phone project's own
      // run of this walk finds whatever the desktop project's run already
      // saved here - a fixed correction would already equal what is stored,
      // leaving Save permanently disabled with nothing to save.
      const correctionText = uniqueTitle('Sign-off questions go to Laurens, not Compliance questions.');

      const correction = page.getByLabel('Your correction');
      await correction.fill(correctionText);
      await press(page.getByRole('button', { name: 'Save' }), isMobile);
      // Saved rather than merely typed: the button that only means something
      // while there is an unsent draft goes back to doing nothing.
      await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled();
      await press(page.getByRole('button', { name: 'Done' }), isMobile);

      await press(page.getByRole('button', { name: 'Settings' }), isMobile);
      await press(page.getByRole('menuitem', { name: 'What Cockpit has learned' }), isMobile);
      await expect(page.getByLabel('Your correction')).toHaveValue(correctionText);
      await expectNoSidewaysScroll(page);
    });
  });
});
