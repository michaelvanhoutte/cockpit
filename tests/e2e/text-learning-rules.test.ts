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

  /**
   * "Pin an example of how you want a note written" (issue 397). One walk
   * for add, edit and delete together - they are the same window and the
   * same controls, and the write rules behind each are proved a tier down
   * (apps/api/tests/integration/http/pinned-examples.test.ts). Persisting
   * across a reopen is not walked separately: it is the same read the add
   * step already exercises, the same reasoning that cuts it from the
   * statement list.
   */
  test.describe('a pinned example is added, edited and deleted on the same screen', () => {
    test('each change is visible on the window that made it', async ({ page, isMobile }) => {
      await openInbox(page, isMobile);

      await press(page.getByRole('button', { name: 'Settings' }), isMobile);
      await press(page.getByRole('menuitem', { name: 'What Cockpit is told' }), isMobile);
      await expect(page.getByRole('dialog', { name: 'What Cockpit is told' })).toBeVisible();

      const note = uniqueTitle('bel novy ivm afspraak');
      const title = uniqueTitle('Novy bellen over de afspraak');

      await press(page.getByRole('button', { name: 'Add example' }), isMobile);
      const addForm = page.getByRole('dialog', { name: 'Add example' });
      await addForm.getByLabel('The captured note this example is for').fill(note);
      await addForm.getByLabel('The title you would have written for this note').fill(title);
      await press(addForm.getByRole('button', { name: 'Save' }), isMobile);
      await expect(addForm).not.toBeVisible();
      await expect(page.getByText(title)).toBeVisible();
      await expectNoSidewaysScroll(page);

      const editedTitle = `${title} (edited)`;
      await press(page.getByRole('button', { name: `Actions for the example "${title}"` }), isMobile);
      await press(page.getByRole('menuitem', { name: 'Edit…' }), isMobile);
      const editForm = page.getByRole('dialog', { name: `Edit ${title}` });
      const titleBox = editForm.getByLabel('The title you would have written for this note');
      await titleBox.fill(editedTitle);
      await press(editForm.getByRole('button', { name: 'Save' }), isMobile);
      await expect(editForm).not.toBeVisible();
      await expect(page.getByText(editedTitle)).toBeVisible();

      await press(page.getByRole('button', { name: `Actions for the example "${editedTitle}"` }), isMobile);
      await press(page.getByRole('menuitem', { name: 'Delete' }), isMobile);
      await press(page.getByRole('button', { name: `Yes, delete the example "${editedTitle}"` }), isMobile);
      // Scoped to the row's own control rather than a bare text match, which
      // would still match the delete question's own heading while it closes.
      await expect(page.getByRole('button', { name: `Actions for the example "${editedTitle}"` })).not.toBeVisible();
    });
  });
});
