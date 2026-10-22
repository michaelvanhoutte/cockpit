import { giveAWorkspace, giveToTheInbox } from './support/arrange';
import {
  captureBox,
  closeCapture,
  expect,
  inbox,
  itemRow,
  openFirstWorkspace,
  switchTo,
  test,
  uniqueTitle,
} from './support/app';

/**
 * F3, because the keys are heard on the window by listeners in the shell while
 * the docked Item form is mounted in a portal; they only meet in the whole app.
 * Which element and which window hold a key back is
 * apps/web/tests/unit/keyboardShortcuts.test.tsx and
 * apps/web/tests/unit/pages/Layout.test.tsx.
 */
test.describe('Shortcuts', () => {
  test.describe('with an Item form docked, the page keys and ? still work', () => {
    test('I, G, ? and C act from the page and from a button in the form, and typing in its title does not', async ({
      page,
      isMobile,
    }) => {
      test.skip(isMobile, 'a phone has no keys, and docking is a desk presentation');

      const first = uniqueTitle('Keys first');
      const second = uniqueTitle('Keys second');
      await openFirstWorkspace(page, isMobile);
      const workspace = await giveAWorkspace(page, uniqueTitle('Keys walk'));
      await giveToTheInbox(page, [first, second], workspace);
      await page.reload();
      await switchTo(page, workspace.name, isMobile);

      // J on a row opens the form docked on the next one, whatever the
      // account's own presentation is, and leaves the keyboard on the list.
      await itemRow(page, first).click();
      await page.keyboard.press('j');
      const form = page.locator('[data-docked-form]');
      await expect(form).toBeVisible();

      // From the page: I collapses the Inbox and opens it again.
      await page.keyboard.press('i');
      await expect(inbox(page)).toHaveCount(0);
      await page.keyboard.press('i');
      await expect(inbox(page)).toBeVisible();

      // From a button inside the form: G shows Go to panel, and Esc hides it.
      const flag = form.getByRole('button', { name: 'High priority' });
      await flag.focus();
      await page.keyboard.press('g');
      await expect(page.getByRole('complementary', { name: 'Go to panel' })).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByRole('complementary', { name: 'Go to panel' })).toHaveCount(0);
      await expect(form).toBeVisible();

      // ? opens the list of keys over the form, and Esc gives the keyboard back.
      await flag.focus();
      await page.keyboard.press('?');
      const keys = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
      await expect(keys).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(keys).toHaveCount(0);
      await expect(flag).toBeFocused();

      // C opens Capture over it.
      await page.keyboard.press('c');
      await expect(captureBox(page)).toBeVisible();
      await closeCapture(page, isMobile);

      // In the form's title the same letters are only letters.
      const title = form.getByRole('textbox', { name: 'Title' });
      await title.fill('');
      await title.pressSequentially('cig?');
      await expect(title).toHaveValue('cig?');
      await expect(keys).toHaveCount(0);
      await expect(captureBox(page)).toHaveCount(0);
      await expect(page.getByRole('complementary', { name: 'Go to panel' })).toHaveCount(0);
    });
  });
});
