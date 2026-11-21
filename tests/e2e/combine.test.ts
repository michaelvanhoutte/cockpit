import { type Locator, type Page } from '@playwright/test';
import { giveADashboard, giveToAPanel, giveToTheInbox } from './support/arrange';
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
      const board = await inboxWithRows(page, isMobile, [first, second, twoIdeas]);
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

      // Combine on a Panel moves its rows ("Panels: Items put inside a parent stay where they were", issue 1876): each is
      // shown once, under the new parent, and Undo files them back on the Panel.
      const [onPanelOne, onPanelTwo] = [uniqueTitle('Falcon one'), uniqueTitle('Falcon two')] as const;
      const falcon = board.panels[0]!;
      await giveToAPanel(page, falcon, [onPanelOne, onPanelTwo]);
      await page.reload();
      await openDashboard(page, board.name, isMobile);
      const panel = page.getByRole('region', { name: falcon.name });
      if (isMobile) {
        await holdRow(page, onPanelOne, false);
        await tapRow(page, onPanelTwo);
      } else {
        await panel.getByRole('listitem').filter({ hasText: onPanelOne }).click({ modifiers: ['ControlOrMeta'] });
        await panel.getByRole('listitem').filter({ hasText: onPanelTwo }).click({ modifiers: ['ControlOrMeta'] });
      }
      await expect(page.getByText('2 selected')).toBeVisible();
      await combineThem(page, isMobile).then((combine) => combine.getByRole('button', { name: 'Combine' }).click());

      const parent = `Combined: ${onPanelOne} +1`;
      await expect(panel.getByText(parent, { exact: true })).toBeVisible();
      await expect(panel.getByText(onPanelOne, { exact: true })).toHaveCount(1);
      await expect(panel.getByText(onPanelTwo, { exact: true })).toHaveCount(1);
      await page.getByRole('status').getByRole('button', { name: 'Undo' }).click();
      await expect(panel.getByText(parent, { exact: true })).toHaveCount(0);
      await expect(panel.getByText(onPanelOne, { exact: true })).toHaveCount(1);
      await expect(panel.getByText(onPanelTwo, { exact: true })).toHaveCount(1);
    });
  });
});

/** A title far wider than any window, in words so that only the cut-off, not a break, can keep it on one line. */
const longTitle = (label: string) => `${uniqueTitle(label)} ${'and then some more words that run on '.repeat(8)}`.trim();

/** One line ending in an ellipsis: told not to wrap, to hide what overflows and to mark it, and really wider than the box it is cut to. */
async function endsInAnEllipsis(line: Locator): Promise<void> {
  await expect(line).toBeVisible();
  const cut = await line.evaluate((el) => {
    const style = getComputedStyle(el);
    return {
      whiteSpace: style.whiteSpace,
      textOverflow: style.textOverflow,
      overflow: style.overflowX,
      wider: el.scrollWidth > el.clientWidth,
    };
  });
  expect(cut).toEqual({ whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden', wider: true });
}

/** The window keeps to the screen: nothing in it reaches past its own edge, and it is no wider than the viewport. */
async function doesNotScrollSideways(page: Page, dialog: Locator): Promise<void> {
  const { scrolls, width } = await dialog.evaluate((el) => ({ scrolls: el.scrollWidth - el.clientWidth, width: el.getBoundingClientRect().width }));
  expect(scrolls).toBeLessThanOrEqual(0);
  expect(width).toBeLessThanOrEqual(page.viewportSize()!.width);
}

test.describe('Triage', () => {
  test.describe('Combine keeps its width whatever the titles are', () => {
    test('a long title under an existing parent, among the Items combined, in the Combine with list and in the window\'s own title is one line ending in an ellipsis, and the window never scrolls sideways', async ({ page, isMobile }) => {
      const [first, second, parent] = [longTitle('Storm scene'), longTitle('Ferry scene'), longTitle('Harbour plans')] as const;
      await inboxWithRows(page, isMobile, [first, second, parent]);

      // Picked together: the names above the cards and, under an existing parent, the parent picker.
      await pickRows(page, [first.slice(0, 20), second.slice(0, 20)], isMobile);
      const dialog = await combineThem(page, isMobile);
      await dialog.getByRole('radio', { name: /Combine under an existing parent/ }).check();
      // The list shows eight at most, so search for the one wanted.
      await dialog.getByRole('textbox', { name: 'Find the parent Item' }).fill(parent.slice(0, 20));
      const picker = dialog.getByRole('list', { name: 'Items to add them to' });
      await endsInAnEllipsis(picker.getByRole('button', { name: parent.slice(0, 20) }));
      for (const title of [first, second]) await endsInAnEllipsis(dialog.getByRole('listitem').filter({ hasText: title.slice(0, 20) }).first());
      await doesNotScrollSideways(page, dialog);
      await dialog.getByRole('button', { name: 'Cancel' }).click();
      await expect(dialog).toHaveCount(0);

      // From one row's menu: the window's title and the list of Items to combine it with.
      await press(inbox(page).getByRole('button', { name: 'Clear' }), isMobile);
      await press(itemRow(page, first.slice(0, 20)).getByRole('button', { name: 'Item actions' }), isMobile);
      await press(page.getByRole('menuitem', { name: 'Combine with…' }), isMobile);
      const fromARow = page.getByRole('dialog');
      await endsInAnEllipsis(fromARow.getByRole('heading', { name: /^Combine “/ }));
      await fromARow.getByRole('textbox', { name: 'Find the Items to combine with' }).fill(second.slice(0, 20));
      await endsInAnEllipsis(fromARow.getByRole('list', { name: 'Items to combine with' }).getByRole('button', { name: second.slice(0, 20) }));
      await doesNotScrollSideways(page, fromARow);
    });
  });
});
