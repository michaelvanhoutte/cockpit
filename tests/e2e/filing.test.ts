import { expect, test, type Page } from '@playwright/test';
import {
  ADA,
  captureBox,
  dashboardBar,
  inbox,
  itemRow,
  press,
  signIn,
  uniqueTitle,
} from './support/app';

/**
 * F3: the walk that says filing an item works for a person. What a panel holds
 * and what the Inbox holds are queries, proved against a real store in
 * apps/api/tests/integration/http/panel-items.test.ts; which panels the picker
 * offers and what choosing one sends is proved in
 * apps/web/tests/unit/components/ItemList.test.tsx. What is only true in a
 * browser is that the two lists are drawn from one snapshot and really do
 * change together, and that the whole gesture is reachable on both devices.
 *
 * Under both projects, because the route differs: at 1280px the Inbox is a
 * column beside the dashboard, so the item leaves one side of the screen and
 * appears on the other; at 480px they are two screens and the menu is the only
 * way there is.
 *
 * **In the second person's account**, like the panel walks: every spec in a run
 * shares one database, so a walk that filled the first dashboard of Work would
 * leave it filled for whatever ran next.
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

/** Where the Inbox is: a column beside the dashboard, or a screen of its own. */
async function goToTheInbox(page: Page, isMobile: boolean): Promise<void> {
  if (isMobile) await press(dashboardBar(page).getByRole('link', { name: 'Inbox' }), isMobile);
  await expect(captureBox(page)).toBeVisible();
}

async function goToTheDashboard(page: Page, dashboard: string, isMobile: boolean): Promise<void> {
  if (isMobile) await press(dashboardBar(page).getByRole('link', { name: dashboard }), isMobile);
  await expect(page.getByRole('heading', { name: dashboard, level: 2 })).toBeVisible();
}

/** Files one item from its own row, which is the only way there is on a phone. */
async function fileOnto(
  page: Page,
  title: string,
  // The Inbox target says what it holds beside its name, so it is reached by a
  // pattern where a panel is reached by its exact title.
  target: string | RegExp,
  isMobile: boolean,
): Promise<void> {
  await press(itemRow(page, title).getByRole('button', { name: 'Item actions' }), isMobile);
  await press(page.getByRole('menuitem', { name: 'Move to…' }), isMobile);
  const picker = page.getByRole('dialog');
  await expect(picker).toBeVisible();
  await press(
    picker.getByRole('button', { name: target, ...(typeof target === 'string' ? { exact: true } : {}) }),
    isMobile,
  );
  await expect(picker).toHaveCount(0);
}

test.describe('Panels', () => {
  test.describe('an item filed onto a panel leaves the Inbox and is drawn on that panel', () => {
    test('files it from the row’s own menu, and it is still there after a reload', async ({
      page,
      isMobile,
    }) => {
      const { dashboard, panel } = await ownDashboardWithAPanel(page, isMobile);
      const title = uniqueTitle('Reply to Bart');

      await goToTheInbox(page, isMobile);
      await captureBox(page).fill(title);
      await press(page.getByRole('button', { name: 'Capture' }), isMobile);
      await expect(inbox(page).getByText(title)).toBeVisible();

      await fileOnto(page, title, panel, isMobile);

      // Out of the Inbox, which is the whole of what filing it does to that
      // list: nothing about its status changed.
      await expect(inbox(page).getByText(title)).toHaveCount(0);

      await goToTheDashboard(page, dashboard, isMobile);
      await expect(page.getByRole('region', { name: panel }).getByText(title)).toBeVisible();

      // And it is really stored, rather than only drawn: the same two lists
      // after the page has been thrown away and read again.
      await page.reload();
      await goToTheDashboard(page, dashboard, isMobile);
      await expect(page.getByRole('region', { name: panel }).getByText(title)).toBeVisible();
      await goToTheInbox(page, isMobile);
      await expect(inbox(page).getByText(title)).toHaveCount(0);
    });

    test('puts it back in the Inbox when it is moved there', async ({ page, isMobile }) => {
      const { dashboard, panel } = await ownDashboardWithAPanel(page, isMobile);
      const title = uniqueTitle('Renew the domain');

      await goToTheInbox(page, isMobile);
      await captureBox(page).fill(title);
      await press(page.getByRole('button', { name: 'Capture' }), isMobile);
      await fileOnto(page, title, panel, isMobile);

      await goToTheDashboard(page, dashboard, isMobile);
      const onThePanel = page.getByRole('region', { name: panel });
      await expect(onThePanel.getByText(title)).toBeVisible();

      // The Inbox is one of the places it can be moved to, so there is a way
      // back that is not "remove it from the last panel holding it".
      await fileOnto(page, title, /^Inbox/, isMobile);

      await expect(onThePanel.getByText(title)).toHaveCount(0);
      await goToTheInbox(page, isMobile);
      await expect(inbox(page).getByText(title)).toBeVisible();
    });
  });
});
