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
 * against a real store. One walk for the capability, saying it works for a
 * person.
 *
 * **There is one thing on this screen now.** A generated paragraph was drawn
 * above the box and read back by nothing, and it is gone ("Drop the nightly
 * filing summary, keep the sentence you wrote", issue 392) - so what is left
 * to walk is the sentence a person writes, which was always the interactive
 * half.
 */
test.describe('Capture', () => {
  test.describe('what Cockpit has learned is read on a workspace settings screen, and corrected in a sentence', () => {
    test('keeps what you wrote after closing and reopening the screen', async ({
      page,
      isMobile,
    }) => {
      await openInbox(page, isMobile);

      await press(page.getByRole('button', { name: 'Settings' }), isMobile);
      await press(page.getByRole('menuitem', { name: 'What Cockpit has learned' }), isMobile);
      await expect(page.getByRole('dialog', { name: 'What Cockpit has learned' })).toBeVisible();
      await expectNoSidewaysScroll(page);

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
