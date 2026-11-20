import { randomUUID } from 'node:crypto';
import { type Page } from '@playwright/test';
import { arrange, giveADashboard, giveToAPanel, type ArrangedDashboard } from './support/arrange';
import { ADA, dashboardBar, expect, expectNoSidewaysScroll, openDashboard, signIn, test, uniqueTitle } from './support/app';

/**
 * F3: a Dashboard's whiteboard ("Brainstorming: give every Dashboard a
 * whiteboard of its own", issue 1829). What each change stores, the Inbox rule
 * and what Undo restores are proved against a real store
 * (apps/api/tests/integration/http/board.test.ts); what a card draws, the
 * toolbar's words and the question "Take it off there too?" are F1
 * (apps/web/tests/unit/whiteboard/, apps/web/tests/unit/whiteboardQuestion.test.tsx).
 * **What is only true in a browser** is that a row really drags onto the board,
 * that a box is drawn by dragging, that the pointer gestures select, toggle and
 * open as agreed, and how the board fits a desk and a phone.
 *
 * **Every walk arranges its rows through the API** and drives only the board.
 */

/** Waits for the server's answer to one change the page sends. */
function answerTo(page: Page, command: string) {
  return page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === `/v1/commands/${command}`);
}

/** A Dashboard of the walk's own with one Panel holding these titles, laid out as asked; its id and the Items' ids. */
async function aDashboardWith(page: Page, titles: string[], view: 'panels' | 'side' | 'board' = 'panels'): Promise<ArrangedDashboard> {
  const board = await giveADashboard(page, uniqueTitle('Novel'), [uniqueTitle('People')]);
  await giveToAPanel(page, board.panels[0]!, titles);
  if (view !== 'panels') await arrange(page, 'set_dashboard_view', { dashboardId: board.id, view });
  return board;
}

const card = (page: Page, title: string) => page.locator('.react-flow__node').filter({ has: page.locator(`[data-card="${title}"]`) });
const isSelected = (page: Page, title: string) => card(page, title).evaluate((node) => node.classList.contains('selected'));

test.describe('Whiteboard', () => {
  test.describe('a row dragged onto the board becomes a card, a box is drawn and named, and both stay', () => {
    test('places the row as a card and draws a named box at a desk; on a phone the board opens to look at and a tap opens the card', async ({ page, isMobile }) => {
      await signIn(page, ADA, isMobile);
      const [ferry] = [uniqueTitle('Ferry scene')];
      const board = await aDashboardWith(page, [ferry]);

      if (isMobile) {
        await arrange(page, 'place_card', { cardId: randomUUID(), dashboardId: board.id, itemId: board.panels[0]!.itemIds[0], boxId: null, x: 40, y: 40 });
        await page.reload();
        await openDashboard(page, board.name, isMobile);
        await page.getByRole('tab', { name: 'Whiteboard' }).click();
        await expect(card(page, ferry)).toBeVisible();
        // Only to look at: no tools, nothing spilling sideways, and a tap opens the Item.
        await expect(page.getByRole('toolbar', { name: 'Whiteboard tools' })).toHaveCount(0);
        await expectNoSidewaysScroll(page);
        await card(page, ferry).tap();
        await expect(page.getByRole('dialog')).toBeVisible();
        return;
      }

      await page.reload();
      await openDashboard(page, board.name, isMobile);
      const switched = answerTo(page, 'set_dashboard_view');
      await dashboardBar(page).getByRole('radio', { name: 'Side by side' }).click();
      expect((await switched).status()).toBe(200);
      const whiteboard = page.locator('[data-whiteboard]');
      await expect(whiteboard).toBeVisible();
      // The toolbar is one row, at a desk.
      expect((await page.getByRole('toolbar', { name: 'Whiteboard tools' }).boundingBox())!.height).toBeLessThan(48);

      const placed = answerTo(page, 'place_card');
      const area = (await whiteboard.boundingBox())!;
      await page.locator('[data-panel-cell] li[data-item-row]').filter({ hasText: ferry }).dragTo(whiteboard, { targetPosition: { x: area.width / 2, y: area.height / 2 } });
      expect((await placed).status()).toBe(200);
      await expect(card(page, ferry)).toBeVisible();

      const drawn = answerTo(page, 'draw_box');
      await page.getByRole('button', { name: 'Draw box' }).click();
      await page.mouse.move(area.x + 40, area.y + 80);
      await page.mouse.down();
      await page.mouse.move(area.x + 260, area.y + 240, { steps: 6 });
      await page.mouse.up();
      await page.keyboard.type('Places');
      await page.keyboard.press('Enter');
      expect((await drawn).status()).toBe(200);

      await page.reload();
      await expect(card(page, ferry)).toBeVisible();
      await expect(page.locator('[data-box="Places"]')).toBeVisible();
      await expect(dashboardBar(page).getByRole('radio', { name: 'Side by side' })).toHaveAttribute('aria-checked', 'true');
    });
  });

  test.describe('clicks select, toggle or open as agreed, and a modifier never opens', () => {
    test('a click selects, Shift-click adds, a double-click opens, and a row clicked in the Panels selects its card', async ({ page, isMobile }) => {
      test.skip(isMobile, 'a phone’s board is only to look at, and its tap is walked above');
      await signIn(page, ADA, isMobile);
      const [ferry, storm] = [uniqueTitle('Ferry scene'), uniqueTitle('Storm scene')];
      const board = await aDashboardWith(page, [ferry, storm], 'side');
      const [ferryId, stormId] = board.panels[0]!.itemIds;
      await arrange(page, 'place_card', { cardId: randomUUID(), dashboardId: board.id, itemId: ferryId, boxId: null, x: 0, y: 0 });
      await arrange(page, 'place_card', { cardId: randomUUID(), dashboardId: board.id, itemId: stormId, boxId: null, x: 300, y: 0 });
      await page.reload();
      await openDashboard(page, board.name, isMobile);
      await expect(card(page, storm)).toBeVisible();

      await card(page, ferry).click();
      await card(page, storm).click();
      expect([await isSelected(page, ferry), await isSelected(page, storm)]).toEqual([false, true]);
      await card(page, ferry).click({ modifiers: ['Shift'] });
      expect([await isSelected(page, ferry), await isSelected(page, storm)]).toEqual([true, true]);
      await expect(page.locator('li[data-card-selected]')).toHaveCount(2);

      await card(page, ferry).dblclick({ modifiers: ['Shift'] });
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await card(page, ferry).dblclick();
      await expect(page.getByRole('dialog')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog')).toHaveCount(0);

      await page.locator('[data-panel-cell] li[data-item-row]').filter({ hasText: storm }).click();
      await expect.poll(() => isSelected(page, storm)).toBe(true);
      await expect.poll(() => isSelected(page, ferry)).toBe(false);
    });
  });
});
