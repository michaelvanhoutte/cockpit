import { type Page } from '@playwright/test';
import {
  ADA,
  capture,
  dashboardBar,
  expect,
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
 * go", issue 169).
 *
 * What a click on a tick means is proved in apps/web/tests/unit/selection.test.ts,
 * the orders a filing of several carries in apps/web/tests/unit/filing.test.ts,
 * and what choosing a panel sends in
 * apps/web/tests/unit/components/ItemList.test.tsx. **What is only true in a
 * browser is the tick appearing at all** - it is revealed by CSS, and jsdom has
 * no hover - and that three rows really do leave one list and arrive on another
 * together.
 *
 * **Desktop only, and that is the feature rather than the test.** The tick is
 * revealed by hovering, which a finger cannot do; the way in on a phone is a
 * long press, and it is "Start a selection with a long press, so a phone can do
 * it too" (issue 170). The walk under the phone project is that issue's to add.
 */

/** An empty dashboard of this walk's own, with one panel on it, already open. */
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

  await press(page.getByRole('button', { name: 'Add a panel' }), isMobile);
  await page.getByLabel('Name of the new panel').fill(panel);
  await page.getByLabel('Name of the new panel').press('Enter');
  await expect(page.getByRole('region', { name: panel })).toBeVisible();
  return { dashboard, panel };
}

/** The tick at the head of a row, which is what picks it out. */
function tickOn(page: Page, title: string) {
  return itemRow(page, title).getByRole('checkbox');
}

test.describe('Selection', () => {
  test.describe('rows picked out of the Inbox are filed together, and can be put back together', () => {
    test('picks three out and files them onto a panel, then takes it back', async ({
      page,
      isMobile,
    }) => {
      // The way in is a hover, and a finger has none. Issue 170 brings the long
      // press and the walk that proves it.
      test.skip(isMobile, 'selecting starts with a hover until the long press lands (issue 170)');

      const { panel } = await ownDashboardWithAPanel(page, isMobile);
      const first = uniqueTitle('Reply to Bart');
      const second = uniqueTitle('Renew the domain');
      const third = uniqueTitle('Chase the purchase order');
      for (const title of [first, second, third]) await capture(page, title, isMobile);

      // **The half that only exists in a browser.** At rest the tick is there
      // to be reached by Tab and invisible; hovering the row is what brings it
      // out, which is the whole reason the column is not a column of ticks.
      await expect(tickOn(page, first)).toHaveCSS('opacity', '0');
      // And out of the way of anything aimed at the row. A tick nobody can see
      // still catches what lands on it, which was eating the start of a swipe
      // in the leading pixels of every row on a phone.
      await expect(tickOn(page, first)).toHaveCSS('pointer-events', 'none');
      await itemRow(page, first).hover();
      await expect(tickOn(page, first)).toHaveCSS('opacity', '1');

      await tickOn(page, first).click();
      // Once one row is picked, every row shows its tick without being hovered.
      await expect(tickOn(page, third)).toHaveCSS('opacity', '1');
      await tickOn(page, third).click({ modifiers: ['Shift'] });
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
      await expect
        .poll(() => itemsOn(page, panel))
        .toEqual([first, second, third]);

      // One way back for the whole filing, not three.
      await expect(page.getByText(`3 items moved to ${panel}`)).toBeVisible();
      await page.getByRole('button', { name: 'Undo' }).click();

      await expect.poll(() => itemsOn(page, panel)).toEqual([]);
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
      test.skip(isMobile, 'selecting starts with a hover until the long press lands (issue 170)');

      const { panel } = await ownDashboardWithAPanel(page, isMobile);
      const titles = [uniqueTitle('Reply to Bart'), uniqueTitle('Renew the domain')];
      for (const title of titles) await capture(page, title, isMobile);

      await itemRow(page, titles[0]!).hover();
      await tickOn(page, titles[0]!).click();
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
