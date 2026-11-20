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
 * The same walk then takes one Item apart with Split ("Brainstorming: a note
 * holding several ideas can't be taken apart", issue 1828), folded in rather than
 * walked alone because the area's walks are at their ceiling and both are the
 * same screen's two directions. What a Split writes and what Undo puts back is
 * apps/api/tests/integration/http/split.test.ts; what the dialog draws and sends
 * is apps/web/tests/unit/components/SplitDialog.test.tsx. **What is only true in
 * a browser** is that a block really drags onto another card (a desk), that a
 * finger moves one by the tag instead, and where the cards sit (right of the
 * blocks on a desk, under them on a phone).
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
  test.describe('rows picked in the Inbox are combined, and one is taken apart', () => {
    test('merges them into one new Item and Undo puts the originals back; a note of two ideas is split by dragging a block, and Undo puts it back', async ({ page, isMobile }) => {
      const [first, second] = [uniqueTitle('Storm scene'), uniqueTitle('Ferry scene')] as const;
      const [rent, ferry] = [uniqueTitle('Pay the rent'), uniqueTitle('Book the ferry')] as const;
      const twoIdeas = `${rent}\n\n${ferry}`;
      await inboxWithRows(page, isMobile, [first, second, twoIdeas]);
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

      // Split: the note of two ideas, opened from its row's menu. Claude cannot be asked in this stack, so one card holds both blocks.
      await press(itemRow(page, rent).getByRole('button', { name: 'Item actions' }), isMobile);
      await press(page.getByRole('menuitem', { name: 'Split…' }), isMobile);
      const split = page.getByRole('dialog');
      await expect(split.getByRole('heading', { name: /^Split “/ })).toBeVisible();
      const blocks = split.locator('[data-block]');
      await expect(blocks).toHaveCount(2);
      await expect(blocks.first()).toContainText(rent);
      await expect(blocks.last()).toContainText(ferry);
      await expect(split.getByRole('status')).toContainText('Claude could not propose a split');
      await split.getByRole('button', { name: '+ Another Item' }).click();
      const [one, two] = [split.locator('[data-proposal="1"]'), split.locator('[data-proposal="2"]')];

      // Blocks left and cards right on a desk; cards under the blocks, full width, on a phone.
      const [blockBox, cardBox] = [await blocks.first().boundingBox(), await two.boundingBox()];
      if (isMobile) {
        expect(cardBox!.y).toBeGreaterThan(blockBox!.y + blockBox!.height);
        expect(cardBox!.width).toBeGreaterThan(blockBox!.width * 0.9);
      } else {
        expect(cardBox!.x).toBeGreaterThan(blockBox!.x + blockBox!.width);
      }

      // A mouse drags the second block onto the new card; a finger cannot drag, and moves it by the tag.
      if (isMobile) await blocks.last().getByRole('combobox').selectOption({ label: 'Item 2' });
      else await blocks.last().dragTo(two);
      await expect(two).toContainText(ferry);
      await expect(one).not.toContainText(ferry);
      await two.getByRole('textbox', { name: 'Title of Item 2' }).fill('Ferry');
      await one.getByRole('textbox', { name: 'Title of Item 1' }).fill('Rent');
      await split.getByRole('button', { name: 'Split' }).click();

      // Two new Items are inside it, so only the original is in the Inbox, now holding them.
      await expect(page.getByRole('status').filter({ hasText: 'split into 2 Items' })).toBeVisible();
      await expect(itemRow(page, rent)).toContainText('0 of 2 done');
      await expect(inbox(page).getByText('Ferry', { exact: true })).toHaveCount(0);
      await page.getByRole('status').getByRole('button', { name: 'Undo' }).click();
      await expect(itemRow(page, rent)).not.toContainText('of 2 done');
    });
  });
});
