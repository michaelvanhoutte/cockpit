import {
  captureBox,
  closeCapture,
  expect,
  itemRow,
  openCapture,
  openInbox,
  openTheFiles,
  press,
  test,
  uniqueTitle,
} from './support/app';
import type { Page } from '@playwright/test';

/**
 * F3, and one walk ("Keep a capture made offline, and send it once a connection
 * gets through", issue 610): only a real browser has real IndexedDB, a real file
 * kept in it, and a page reloaded with the server out of reach and nothing
 * telling it so. A capture surviving a reload of its own is
 * apps/web/tests/unit/components/CaptureNote.test.tsx's, over a fake IndexedDB. Which capture goes when, and what each
 * answer means, is apps/web/tests/unit/captureOutboxSender.test.tsx; what the
 * form draws for each is apps/web/tests/unit/components/CaptureNote.test.tsx.
 *
 * **"No connection" is every request to the server failing, not the browser's
 * offline switch.** F3 runs Vite's dev server, which registers no service
 * worker, so a reload with the browser offline would not load the page at all.
 * Failing the server's requests is the case the issue exists for anyway - a
 * phone showing 5G with no data, which fires no `offline` event - and the
 * connection coming back is the browser's own `online`.
 */

/** A minimal, valid 1x1 PNG. */
const A_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

const justCaptured = (page: Page) => page.getByRole('region', { name: 'Just captured' });
/** By its address rather than its role: at a desk the window open over it takes the header out of the accessibility tree. */
const captureTab = (page: Page) => page.locator('header a[href="/capture"]').first();

/** Whether the app's stored copy has been written whole, which a reload with no server paints from. */
const storedCopyWritten = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<boolean>((resolve) => {
        const opening = indexedDB.open('keyval-store');
        opening.onerror = () => resolve(false);
        opening.onsuccess = () => {
          const db = opening.result;
          if (!db.objectStoreNames.contains('keyval')) return resolve(false);
          const read = db.transaction('keyval').objectStore('keyval').get('cockpit-query-cache-v1');
          // Who is signed in and the workspace's own copy, both: a capture is
          // kept for whoever the stored copy says is signed in.
          read.onsuccess = () => {
            const kept: { queryKey: unknown[] }[] = read.result?.clientState?.queries ?? [];
            const has = (first: string) => kept.some((query) => query.queryKey[0] === first);
            resolve(has('me') && has('snapshot') && has('workspaces'));
          };
          read.onerror = () => resolve(false);
        };
      }),
  );

test.describe('Offline', () => {
  test.describe('a capture made with no connection reaches the Inbox once one returns', () => {
    test('waits, then lands with its file and shows its time', async ({ page, isMobile }) => {
      await openInbox(page, isMobile);
      await expect.poll(() => storedCopyWritten(page)).toBe(true);

      // The server out of reach, and the browser told nothing.
      await page.route('**/v1/**', (route) => route.abort('internetdisconnected'));
      await page.reload();
      await openCapture(page, isMobile);

      const note = uniqueTitle('Captured on the train');
      await captureBox(page).fill(note);
      await page.getByLabel('Files to attach').setInputFiles({
        name: 'receipt.png',
        mimeType: 'image/png',
        buffer: A_PNG,
      });
      await press(page.getByRole('button', { name: 'Capture', exact: true }), isMobile);

      await expect(captureBox(page)).toHaveValue('');
      const row = justCaptured(page).getByRole('listitem').filter({ hasText: note });
      await expect(row.getByText('Waiting to send')).toBeVisible();
      await expect(captureTab(page)).toHaveText('Capture1');

      await page.unroute('**/v1/**');
      await page.context().setOffline(true);
      await page.context().setOffline(false);

      await expect(row.getByText('now')).toBeVisible({ timeout: 15_000 });
      await expect(captureTab(page)).toHaveText('Capture');
      await closeCapture(page, isMobile);

      await expect(itemRow(page, note)).toBeVisible();
      await press(itemRow(page, note).getByRole('button', { name: 'Item actions' }), isMobile);
      await press(page.getByRole('menuitem', { name: 'Open' }), isMobile);
      await openTheFiles(page, isMobile);
      await expect(page.getByRole('dialog').getByRole('img', { name: 'receipt.png' })).toBeVisible();
    });
  });
});
