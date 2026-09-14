import { expect, expectNoSidewaysScroll, openInbox, press, test, uniqueTitle } from './support/app';

/**
 * F3, for the same reason `routing-summary.test.ts` beside this file is: the
 * header's menu, opened by a tap or a mouse, leads to a window drawn over
 * the workspace, and a rule saved in it has to still be there once the
 * window is closed and reopened ("Show what Cockpit is told, and say how
 * you want it changed", issue 398).
 *
 * It is not re-proving the write rules, which
 * apps/api/tests/integration/http/note-cleanup.test.ts and
 * apps/api/tests/unit/ai/prompts/clean-up-a-note.v7.test.ts own against a
 * real store and the prompt itself. One walk for the capability, saying it
 * works for a person.
 */
test.describe('Capture', () => {
  test.describe('what Cockpit is told is read on an account settings screen, and changed with a rule', () => {
    test('keeps what you wrote after closing and reopening the screen', async ({
      page,
      isMobile,
    }) => {
      await openInbox(page, isMobile);

      await press(page.getByRole('button', { name: 'Settings' }), isMobile);
      await press(page.getByRole('menuitem', { name: 'What Cockpit is told' }), isMobile);
      await expect(page.getByRole('dialog', { name: 'What Cockpit is told' })).toBeVisible();
      await expectNoSidewaysScroll(page);

      // The read-only guidance is drawn on the same screen, and offers
      // nothing to edit - the rules box below it is the only control.
      await expect(page.getByText(/does not contain/i).first()).toBeVisible();

      // Unique per run, not a fixed sentence: the desktop and phone projects
      // share one account (support/app.ts, "The register is not rebuilt
      // between the two projects"), so the phone project's own run of this
      // walk finds whatever the desktop project's run already saved here - a
      // fixed rule would already equal what is stored, leaving Save
      // permanently disabled with nothing to save.
      const ruleText = uniqueTitle('Never end a title with a question mark.');

      const rules = page.getByLabel('Your rules');
      await rules.fill(ruleText);
      await press(page.getByRole('button', { name: 'Save' }), isMobile);
      // Saved rather than merely typed: the button that only means something
      // while there is an unsent draft goes back to doing nothing.
      await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled();
      await press(page.getByRole('button', { name: 'Done' }), isMobile);

      await press(page.getByRole('button', { name: 'Settings' }), isMobile);
      await press(page.getByRole('menuitem', { name: 'What Cockpit is told' }), isMobile);
      await expect(page.getByLabel('Your rules')).toHaveValue(ruleText);
      await expectNoSidewaysScroll(page);
    });
  });
});
