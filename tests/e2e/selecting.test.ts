import { type Page } from '@playwright/test';
import {
  ADA,
  capture,
  captureBox,
  dashboardBar,
  expect,
  holdRow,
  inbox,
  itemRow,
  itemsOn,
  press,
  signIn,
  test,
  uniqueTitle,
} from './support/app';

/**
 * F3: the walk that says picking several rows out of the Inbox and filing them
 * together works for a person ("Select several items, and file them all in one
 * go", issue 169; "Start a selection with a long press, so a phone can do it
 * too", issue 170).
 *
 * What a click on a tick means is proved in apps/web/tests/unit/selection.test.ts,
 * what counts as holding still in apps/web/tests/unit/hold.test.ts, the orders a
 * filing of several carries in apps/web/tests/unit/filing.test.ts, and what
 * choosing a panel sends in apps/web/tests/unit/components/ItemList.test.tsx.
 * **What is only true in a browser is the tick appearing at all** - it is
 * revealed by CSS, and jsdom has no hover - and that three rows really do leave
 * one list and arrive on another together.
 *
 * **Both projects, by different doors.** A tick is revealed by hovering, which
 * a finger cannot do, so a phone starts a selection by resting on a row
 * instead. From the first row on the two are the same gesture: every row shows
 * its tick and the rest are taps. The range stays desktop-only, because a
 * shift-click is not something a phone can make.
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

  await press(page.getByRole('button', { name: '+ Add a panel' }), isMobile);
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
  await expect(captureBox(page)).toBeVisible();
}

async function goToTheDashboard(page: Page, dashboard: string, isMobile: boolean): Promise<void> {
  if (isMobile) await press(dashboardBar(page).getByRole('link', { name: dashboard }), isMobile);
  await expect(page.getByRole('heading', { name: dashboard, level: 2 })).toBeVisible();
}

/** The tick at the head of a row, which is what picks it out. */
function tickOn(page: Page, title: string) {
  return itemRow(page, title).getByRole('checkbox');
}

/**
 * The first row picked, by whichever door this device has: a finger rests on
 * the row, a pointer hovers it and clicks the tick that appears.
 */
async function startSelecting(page: Page, title: string, isMobile: boolean): Promise<void> {
  if (isMobile) {
    await holdRow(page, title);
    return;
  }
  await itemRow(page, title).hover();
  // Asserted here rather than left to the click: Playwright only needs the tick
  // to be reachable, so a tick that stayed invisible would still be clicked and
  // the walk would pass while nobody could see what they were aiming at.
  await expect(tickOn(page, title)).toHaveCSS('opacity', '1');
  await tickOn(page, title).click();
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

      // **The half that only exists in a browser.** At rest the tick is there
      // to be reached by Tab and invisible; what brings it out is hovering the
      // row - the whole reason the column is not a column of ticks - and on a
      // phone, where nothing hovers, resting on the row instead.
      await expect(tickOn(page, first)).toHaveCSS('opacity', '0');
      // And out of the way of anything aimed at the row. A tick nobody can see
      // still catches what lands on it, which was eating the start of a swipe
      // in the leading pixels of every row - which is the very gesture a finger
      // uses to reach this feature at all.
      await expect(tickOn(page, first)).toHaveCSS('pointer-events', 'none');
      await startSelecting(page, first, isMobile);
      await expect(tickOn(page, first)).toBeChecked();

      // Once one row is picked, every row shows its tick untouched.
      await expect(tickOn(page, third)).toHaveCSS('opacity', '1');
      // A range is a shift-click, which a phone cannot make; there, each row is
      // one more tap.
      if (isMobile) await tickOn(page, second).click();
      await tickOn(page, third).click(isMobile ? {} : { modifiers: ['Shift'] });
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
      await tickOn(page, titles[1]!).click();
      await page.getByRole('button', { name: 'Move to…' }).click();
      const picker = page.getByRole('dialog');
      await picker.getByRole('button', { name: panel, exact: true }).click();
      await expect(picker).toHaveCount(0);

      const onThePanel = page.getByRole('region', { name: panel });
      await expect(onThePanel.getByText(titles[0]!)).toBeVisible();
      await onThePanel.getByText(titles[0]!).hover();
      await onThePanel.getByRole('checkbox').first().click();

      await expect(onThePanel.getByText('1 selected')).toBeInViewport();
      await expect(onThePanel.getByRole('button', { name: 'Move to…' })).toBeInViewport();
    });
  });
});
