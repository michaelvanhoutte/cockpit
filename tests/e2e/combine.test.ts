import { type Page } from '@playwright/test';
import { giveADashboard, giveToTheInbox } from './support/arrange';
import {
  ADA,
  dashboardBar,
  expect,
  holdRow,
  inbox,
  itemRow,
  openDashboard,
  press,
  signIn,
  tapRow,
  test,
  uniqueTitle,
} from './support/app';

/**
 * F3: the walk that says combining rows picked out of the Inbox works for a
 * person ("Brainstorming: related loose notes can't be brought together", issue
 * 1826). What each of the three actions writes - the Additions, files and places
 * a Merge carries over, what Undo puts back, where a new parent is filed - is
 * proved against a real store in
 * apps/api/tests/integration/http/combine.test.ts; what the dialog offers and
 * sends is apps/web/tests/unit/components/ItemList.test.tsx's. **What is only
 * true in a browser** is that rows really picked with ctrl/cmd-clicks (or a
 * finger) reach Edit ▾ ▸ Combine…, on a desk and on a phone, which is why this is
 * one walk rather than one per action.
 *
 * **Every walk arranges its rows through the API** and drives only the
 * selection and the dialog through the UI (`./support/arrange`).
 */

/** The Inbox's rows picked: a long press starts a selection on a phone, a ctrl/cmd-click on a desk, and each later row is one more tap or click. */
async function pickRows(page: Page, titles: string[], isMobile: boolean): Promise<void> {
  const [first, ...rest] = titles;
  if (isMobile) await holdRow(page, first!, false);
  else await itemRow(page, first!).click({ modifiers: ['ControlOrMeta'] });
  for (const title of rest) {
    if (isMobile) await tapRow(page, title);
    else await itemRow(page, title).click({ modifiers: ['ControlOrMeta'] });
  }
  await expect(inbox(page).getByText(`${titles.length} selected`)).toBeVisible();
}

/** Edit ▾ ▸ Combine…, the dialog it opens. */
async function combineThem(page: Page, isMobile: boolean) {
  await press(page.getByRole('button', { name: 'Edit ▾' }), isMobile);
  await press(page.getByRole('menuitem', { name: 'Combine…' }), isMobile);
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: /^Combine \d+ Items$/ })).toBeVisible();
  return dialog;
}

/** A dashboard of this walk's own with one empty panel, and the rows given to the Inbox, opened with the Inbox on screen. */
async function inboxWithRows(page: Page, isMobile: boolean, titles: string[]) {
  await signIn(page, ADA, isMobile);
  const board = await giveADashboard(page, uniqueTitle('Gather'), [uniqueTitle('Falcon')]);
  await giveToTheInbox(page, titles);
  await page.reload();
  await openDashboard(page, board.name, isMobile);
  if (isMobile) await press(dashboardBar(page).getByRole('link', { name: 'Inbox' }), isMobile);
  await expect(inbox(page)).toBeVisible();
  return board;
}

test.describe('Triage', () => {
  test.describe('rows picked in the Inbox are combined', () => {
    test('merges them into one new Item in the Inbox, and Undo puts the originals back', async ({ page, isMobile }) => {
      const [first, second] = [uniqueTitle('Storm scene'), uniqueTitle('Ferry scene')] as const;
      await inboxWithRows(page, isMobile, [first, second]);
      await pickRows(page, [first, second], isMobile);

      const dialog = await combineThem(page, isMobile);
      await dialog.getByRole('radio', { name: /Merge into one new Item/ }).check();
      await dialog.getByRole('button', { name: 'Combine' }).click();

      const merged = `Combined: ${first} +1`;
      await expect(inbox(page).getByText(merged, { exact: true })).toBeVisible();
      for (const title of [first, second]) await expect(inbox(page).getByText(title, { exact: true })).toHaveCount(0);

      await page.getByRole('status').getByRole('button', { name: 'Undo' }).click();

      for (const title of [first, second]) await expect(inbox(page).getByText(title, { exact: true })).toBeVisible();
      await expect(inbox(page).getByText(merged, { exact: true })).toHaveCount(0);
    });
  });
});
