import { expect, test } from '@playwright/test';
import { itemRow, openFirstWorkspace, uniqueTitle } from './support/app';

/**
 * F3, and one walk: what nothing below can prove is that a *real* EventSource,
 * once the browser has given up on it, is replaced by one that actually
 * delivers again. apps/web/tests/unit/api/useServerEvents.test.tsx owns the
 * timing and the branching against a stand-in; this owns "and then a change
 * made elsewhere really does arrive".
 *
 * Nothing here touches the page after it loads. That is the point: the failure
 * this guards against is a tab that looks fine and has quietly stopped
 * listening, which no amount of clicking would reveal because clicking is
 * exactly what hides it.
 */
test.describe('Offline', () => {
  test.describe('a change made elsewhere reaches a tab nobody has touched, even after the connection was refused', () => {
    test('shows the new item without anyone returning to the tab', async ({ page }) => {
      const attempts: string[] = [];
      page.on('request', (r) => {
        if (r.url().includes('/v1/events')) attempts.push(r.url());
      });

      // Refuse the first connection outright. A refusal is the case the browser
      // will not retry by itself — a dropped connection it would.
      await page.route('**/v1/events**', (route) =>
        route.fulfill({ status: 503, contentType: 'text/plain', body: 'refused' }),
      );

      await openFirstWorkspace(page);
      await expect.poll(() => attempts.length).toBeGreaterThanOrEqual(1);

      // Let the replacement through for real. Interception is dropped rather
      // than passed through, because proxying a long-lived stream through the
      // test harness is not the thing under test.
      await page.unroute('**/v1/events**');
      await expect
        .poll(() => attempts.length, { timeout: 30_000 })
        .toBeGreaterThanOrEqual(2);

      // The server starts reporting changes from the moment a connection is
      // made, so the change has to come after the replacement is up.
      await page.waitForTimeout(1_500);

      const workspaceId = new URL(page.url()).pathname.split('/').pop()!;
      const title = uniqueTitle('Arrived while nobody looked');
      const sent = await page.request.post('/v1/commands/capture_item', {
        data: {
          commandId: crypto.randomUUID(),
          issuedAt: new Date().toISOString(),
          workspaceId,
          itemId: crypto.randomUUID(),
          title,
        },
      });
      expect(sent.ok(), `capturing from outside failed: ${sent.status()}`).toBe(true);

      await expect(itemRow(page, title)).toBeVisible({ timeout: 30_000 });
    });
  });
});
