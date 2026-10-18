import type { Page } from '@playwright/test';
import {
  ADA,
  capture,
  dashboardBar,
  expect,
  fileOnto,
  itemRow,
  press,
  signIn,
  test,
  uniqueTitle,
} from './support/app';

/**
 * F3, and the one walk this capability gets: only a real browser proves that
 * the clipboard write from a real click and the link it holds resolving in a
 * fresh page belong together ("Copy an Item's link from its menu and its
 * form", issue 1247). Where Copy link is offered, what it writes and what the
 * bar says are F1, in apps/web/tests/unit/components/ItemRow.test.tsx and
 * ItemForm.test.tsx.
 *
 * **In the second person's account**, like the filing walks: every spec in a
 * run shares one database.
 */
test.describe('Item editing', () => {
  // Reading the clipboard back is the walk's own act, so it is granted here
  // rather than for the whole suite.
  test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

  test.describe('a link copied from a panel row’s menu opens that Item in a fresh page', () => {
    test('copies from the menu, says so, and the pasted address opens the Item’s form', async ({
      page,
      isMobile,
    }) => {
      const dashboard = uniqueTitle('Today');
      const panel = uniqueTitle('Falcon');
      const title = uniqueTitle('Reply to Bart');
      await signIn(page, ADA, isMobile);
      await press(page.getByRole('button', { name: 'Add a dashboard' }), isMobile);
      await page.getByLabel('Name of the new dashboard').fill(dashboard);
      await page.getByLabel('Name of the new dashboard').press('Enter');
      await expect(dashboardBar(page).getByRole('link', { name: dashboard })).toBeVisible();
      await press(page.getByRole('button', { name: '+ Panel' }), isMobile);
      await page.getByLabel('Name of the new panel').fill(panel);
      await page.getByLabel('Name of the new panel').press('Enter');
      await expect(page.getByRole('region', { name: panel })).toBeVisible();

      // A phone shows the Inbox as a screen of its own, which capture waits on and filing starts from.
      if (isMobile) await press(dashboardBar(page).getByRole('link', { name: 'Inbox' }), isMobile);
      await capture(page, title, isMobile);
      await fileOnto(page, title, panel, isMobile);
      if (isMobile) await press(dashboardBar(page).getByRole('link', { name: dashboard }), isMobile);
      await expect(page.getByRole('region', { name: panel }).getByText(title)).toBeVisible();

      await press(itemRow(page, title).getByRole('button', { name: 'Item actions' }), isMobile);
      await press(page.getByRole('menuitem', { name: 'Copy link' }), isMobile);
      await expect(page.getByText('Link copied')).toBeVisible();

      const link = await copiedLink(page);
      expect(new URL(link).pathname).toMatch(/^\/w\/[^/]+$/);

      const fresh = await page.context().newPage();
      await fresh.goto(link);
      await expect(fresh.getByRole('dialog').getByRole('textbox', { name: 'Title' })).toHaveValue(title);
      await fresh.close();
    });
  });
});

/** The address on the clipboard, and that its titled form is an anchor to it. */
async function copiedLink(page: Page): Promise<string> {
  const { plain, html } = await page.evaluate(async () => {
    const [item] = await navigator.clipboard.read();
    const text = async (type: string) => (await (await item!.getType(type)).text()) as string;
    return { plain: await text('text/plain'), html: await text('text/html') };
  });
  expect(html).toContain(`<a href="${plain}">`);
  return plain;
}
