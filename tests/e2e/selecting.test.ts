import { type Page } from '@playwright/test';
import {
  ADA,
  capture,
  dashboardBar,
  expect,
  holdRow,
  inbox,
  itemRow,
  itemsOn,
  openDashboard,
  press,
  signIn,
  tapRow,
  test,
  uniqueTitle,
} from './support/app';

/**
 * F3: the walk that says picking several rows out of the Inbox and filing them
 * together works for a person ("Select several items, and file them all in one
 * go", issue 169; "Start a selection with a long press, so a phone can do it
 * too", issue 170; "Pick a row by ctrl/shift-click instead of aiming for a
 * checkbox, and suspend single-row actions while a selection is held", issue
 * 438).
 *
 * What a click on a row *means* is proved in
 * apps/web/tests/unit/components/ItemRow.test.tsx, which rows a shift-click's
 * span covers is apps/web/tests/unit/selection.test.ts's, what counts as
 * holding still is apps/web/tests/unit/hold.test.ts's, the orders a filing of
 * several carries is apps/web/tests/unit/filing.test.ts's, and what choosing a
 * panel sends is apps/web/tests/unit/components/ItemList.test.tsx's. **What is
 * only true in a browser** is that a real ctrl/cmd- or shift-click on a real
 * row reaches the row as the modifier it is, that a real touch reaches it as a
 * `touch` pointer, and that three rows really do leave one list and arrive on
 * another together.
 *
 * **Both projects, by different doors.** From the first row on the two are the
 * same gesture: a long press starts a selection on either, and every later
 * pick is a ctrl/cmd-click on desktop or a tap on a phone. The range stays
 * desktop-only, because a shift-click is not something a phone can make.
 */

/** An empty dashboard of this walk's own, with one panel on it. */
async function ownDashboardWithAPanel(
  page: Page,
  isMobile: boolean,
): Promise<{ dashboard: string; panel: string }> {
  const dashboard = uniqueTitle('Today');
  const panel = uniqueTitle('Falcon');
  await signIn(page, ADA, isMobile);
  await press(page.getByRole('button', { name: 'Add a dashboard' }), isMobile);
  await page.getByLabel('Name of the new dashboard').fill(dashboard);
  await page.getByLabel('Name of the new dashboard').press('Enter');
  await expect(dashboardBar(page).getByRole('link', { name: dashboard })).toBeVisible();

  await press(page.getByRole('button', { name: '+ Panel' }), isMobile);
  await page.getByLabel('Name of the new panel').fill(panel);
  await page.getByLabel('Name of the new panel').press('Enter');
  await expect(page.getByRole('region', { name: panel })).toBeVisible();
  return { dashboard, panel };
}

/**
 * Where the Inbox and the dashboard are: two columns of one screen with a
 * mouse, two screens with a finger. The same two helpers filing.test.ts keeps,
 * because the walk has to get to both lists to say an item moved between them.
 */
async function goToTheInbox(page: Page, isMobile: boolean): Promise<void> {
  if (isMobile) await press(dashboardBar(page).getByRole('link', { name: 'Inbox' }), isMobile);
  await expect(inbox(page)).toBeVisible();
}

async function goToTheDashboard(page: Page, dashboard: string, isMobile: boolean): Promise<void> {
  await openDashboard(page, dashboard, isMobile);
  await expect(page.getByRole('heading', { name: dashboard, level: 2 })).toBeVisible();
}

/**
 * The first row picked, by whichever door this device has: a finger rests on
 * the row to start a selection, a pointer ctrl/cmd-clicks it - from anywhere on
 * the row, since the checkbox that used to carry this is gone.
 */
async function startSelecting(page: Page, title: string, isMobile: boolean): Promise<void> {
  if (isMobile) {
    await holdRow(page, title);
    return;
  }
  await itemRow(page, title).click({ modifiers: ['ControlOrMeta'] });
}

/**
 * A later row added to a selection already held: a tap on a phone, which is
 * what it has instead of a ctrl/cmd-click; a ctrl/cmd-click on a pointer,
 * unless `withShift` reaches back across the rows between.
 */
async function addToSelection(
  page: Page,
  title: string,
  isMobile: boolean,
  withShift = false,
): Promise<void> {
  if (isMobile) {
    await tapRow(page, title);
    return;
  }
  await itemRow(page, title).click({ modifiers: withShift ? ['Shift'] : ['ControlOrMeta'] });
}

test.describe('Selection', () => {
  test.describe('rows picked out of the Inbox are filed together, and can be put back together', () => {
    test('picks three out and files them onto a panel, then takes it back', async ({
      page,
      isMobile,
    }) => {
      const { dashboard, panel } = await ownDashboardWithAPanel(page, isMobile);
      const first = uniqueTitle('Reply to Bart');
      const second = uniqueTitle('Renew the domain');
      const third = uniqueTitle('Chase the purchase order');
      await goToTheInbox(page, isMobile);
      for (const title of [first, second, third]) await capture(page, title, isMobile);

      await startSelecting(page, first, isMobile);
      await expect(inbox(page).getByText('1 selected')).toBeVisible();

      // A range is a shift-click, which a phone cannot make; there, each row is
      // one more tap.
      await addToSelection(page, second, isMobile);
      await expect(inbox(page).getByText('2 selected')).toBeVisible();
      await addToSelection(page, third, isMobile, true);
      await expect(inbox(page).getByText('3 selected')).toBeVisible();

      await page.getByRole('button', { name: 'Move to…' }).click();
      const picker = page.getByRole('dialog');
      await expect(picker.getByRole('heading', { name: 'Move 3 items to' })).toBeVisible();
      await picker.getByRole('button', { name: panel, exact: true }).click();
      await expect(picker).toHaveCount(0);

      // All three left the Inbox, and arrived on the panel in the order the
      // Inbox was showing them.
      for (const title of [first, second, third]) {
        await expect(inbox(page).getByText(title)).toHaveCount(0);
      }
      await goToTheDashboard(page, dashboard, isMobile);
      await expect.poll(() => itemsOn(page, panel)).toEqual([first, second, third]);

      // One way back for the whole filing, not three.
      await expect(page.getByText(`3 items moved to ${panel}`)).toBeVisible();
      await page.getByRole('button', { name: 'Undo' }).click();

      await expect.poll(() => itemsOn(page, panel)).toEqual([]);
      await goToTheInbox(page, isMobile);
      for (const title of [first, second, third]) {
        await expect(inbox(page).getByText(title)).toBeVisible();
      }
    });

    test('keeps the bar in view when the panel’s rows scroll', async ({ page, isMobile }) => {
      // Found by looking rather than by running anything: a panel's rows scroll
      // inside a box of a fixed height, so a bar placed below them is one you
      // have to scroll to - and what scrolls it away is the row you just
      // picked. Only true in a browser, because nothing below it lays anything
      // out.
      //
      // **Desktop alone, and it is the same rule either way.** The bar sticks
      // to the foot of whatever box the list is drawn in; proving that twice
      // would be the same CSS against a second width.
      test.skip(isMobile, 'the same stickiness, against a second width');

      const { panel } = await ownDashboardWithAPanel(page, isMobile);
      const titles = [uniqueTitle('Reply to Bart'), uniqueTitle('Renew the domain')];
      for (const title of titles) await capture(page, title, isMobile);

      await startSelecting(page, titles[0]!, isMobile);
      await addToSelection(page, titles[1]!, isMobile);
      await page.getByRole('button', { name: 'Move to…' }).click();
      const picker = page.getByRole('dialog');
      await picker.getByRole('button', { name: panel, exact: true }).click();
      await expect(picker).toHaveCount(0);

      const onThePanel = page.getByRole('region', { name: panel });
      await expect(onThePanel.getByText(titles[0]!)).toBeVisible();
      await startSelecting(page, titles[0]!, false);

      await expect(onThePanel.getByText('1 selected')).toBeInViewport();
      await expect(onThePanel.getByRole('button', { name: 'Move to…' })).toBeInViewport();
    });
  });

  test.describe('a selection suspends what a row would otherwise do on its own', () => {
    // Desktop only: the case is a plain click on a mouse specifically, which is
    // what ending a selection is - a phone has no such click, a tap while
    // selecting extends it instead, already proved above.
    test('a plain click while a selection is held clears it, without opening the row it landed on', async ({
      page,
      isMobile,
    }) => {
      // A plain click no longer opens a row on its own ("Require a
      // double-click to open a row again, now that a plain click opens it",
      // issue 456) - a double-click still does.
      test.skip(isMobile, 'a plain click ending a selection is a mouse-only gesture');

      const first = uniqueTitle('Reply to Bart');
      const second = uniqueTitle('Renew the domain');
      await signIn(page, ADA, isMobile);
      await goToTheInbox(page, isMobile);
      for (const title of [first, second]) await capture(page, title, isMobile);

      await startSelecting(page, first, isMobile);
      await expect(inbox(page).getByText('1 selected')).toBeVisible();

      await itemRow(page, second).click();

      await expect(inbox(page).getByText('1 selected')).toHaveCount(0);
      await expect(page.getByRole('dialog')).toHaveCount(0);

      await itemRow(page, second).dblclick();

      await expect(page.getByRole('dialog').getByRole('textbox', { name: 'Title' })).toHaveValue(
        second,
      );
    });

    test('a picked row’s own menu does not open while a selection is held', async ({
      page,
      isMobile,
    }) => {
      const title = uniqueTitle('Reply to Bart');
      await signIn(page, ADA, isMobile);
      await goToTheInbox(page, isMobile);
      await capture(page, title, isMobile);

      await startSelecting(page, title, isMobile);
      await expect(inbox(page).getByText('1 selected')).toBeVisible();

      const menu = itemRow(page, title).getByRole('button', { name: 'Item actions' });
      await expect(menu).toBeDisabled();
      // Pressed, not merely found disabled: a disabled button can still be
      // pressed in a browser, and what matters is that pressing it opens
      // nothing, not that the attribute is there (found in review - this
      // assertion passed even before the press was added, since nothing had
      // opened a menu for it to find). `force` because it is `aria-disabled`
      // rather than natively `disabled` - reachable on purpose, so Playwright's
      // own actionability check refuses the press unless told the control is
      // meant to be pressed anyway.
      if (isMobile) await menu.tap({ force: true });
      else await menu.click({ force: true });
      await expect(page.getByRole('menuitem', { name: 'Mark done' })).toHaveCount(0);
    });
  });
});
