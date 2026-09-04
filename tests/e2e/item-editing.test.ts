import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { capture, itemRow, openInbox, press, uniqueTitle } from './support/app';

/** Opens one row's form the way both devices can: from the row's own menu. */
async function openItem(page: Page, row: string, isMobile: boolean): Promise<void> {
  await press(itemRow(page, row).getByRole('button', { name: 'Item actions' }), isMobile);
  await press(page.getByRole('menuitem', { name: 'Open' }), isMobile);
}

const form = (page: Page) => page.getByRole('dialog');
/** The form's own boxes. Scoped, because the row's mark is also labelled with
 *  the word "description" and a page-wide lookup matches both. */
const titleBox = (page: Page) => form(page).getByRole('textbox', { name: 'Title' });
const descriptionBox = (page: Page) => form(page).getByRole('textbox', { name: 'Description' });

/**
 * F3, because this is the capability: a person opens an item, writes something
 * about it, and finds it again. What a saved text survives is proved against a
 * real database in apps/api/tests/integration/http/item-changes.test.ts, what
 * the form sends in apps/web/tests/unit/components/ItemForm.test.tsx, and what
 * a row's label is in packages/shared/tests/unit/domain/item.test.ts. None of
 * those can say the form opens, takes what is typed, and closes.
 *
 * Both projects, because the two ways in differ by device: a double-click is a
 * mouse gesture and a phone has only the menu, so the menu is what
 * both have in common and what the walk uses.
 */
test.describe('Item editing', () => {
  test.describe('writing something about an item, and finding it again', () => {
    test('keeps the title and the description, and marks the row', async ({ page, isMobile }) => {
      await openInbox(page, isMobile);
      const thought = uniqueTitle('Ask Novy about part 11');
      await capture(page, thought, isMobile);

      await openItem(page, thought, isMobile);

      // The captured message is what the row was showing, and it is behind the
      // disclosure rather than in a box: it can never be edited.
      await expect(titleBox(page)).toHaveValue('');
      await press(form(page).getByText('What was captured'), isMobile);
      await expect(form(page).getByText(thought)).toBeVisible();

      const named = uniqueTitle('Part 11');
      await titleBox(page).fill(named);
      await descriptionBox(page).fill('Tolerances, and the sign-off date');
      await press(form(page).getByRole('button', { name: 'Save' }), isMobile);

      // The row now reads by its title rather than by what was captured, and
      // says there is something written behind it.
      await expect(itemRow(page, named)).toBeVisible();
      await expect(itemRow(page, named).getByLabel('Has a description')).toBeVisible();

      // And it is still there on the way back in, which is the half a form that
      // only looked right would not have.
      await openItem(page, named, isMobile);
      await expect(titleBox(page)).toHaveValue(named);
      await expect(descriptionBox(page)).toHaveValue('Tolerances, and the sign-off date');
    });

    test('throws away what was typed when the form is cancelled', async ({ page, isMobile }) => {
      await openInbox(page, isMobile);
      const thought = uniqueTitle('Left as it was');
      await capture(page, thought, isMobile);

      await openItem(page, thought, isMobile);
      await descriptionBox(page).fill('Typed and then abandoned');
      await press(form(page).getByRole('button', { name: 'Cancel' }), isMobile);

      // No question asked on the way out, and nothing kept: Cancel means cancel.
      await expect(descriptionBox(page)).toHaveCount(0);
      await expect(itemRow(page, thought).getByLabel('Has a description')).toHaveCount(0);
    });

    test('is opened and closed by the address, so the back button closes it', async ({
      page,
      isMobile,
    }) => {
      await openInbox(page, isMobile);
      const thought = uniqueTitle('Linkable');
      await capture(page, thought, isMobile);

      await openItem(page, thought, isMobile);
      await expect(page).toHaveURL(/[?&]item=/);
      const openAt = page.url();

      await page.goBack();
      await expect(titleBox(page)).toHaveCount(0);

      // The address on its own opens it, which is what makes it a link rather
      // than a state only this tab knows about.
      await page.goto(openAt);
      await expect(titleBox(page)).toBeVisible();
    });
  });
});
