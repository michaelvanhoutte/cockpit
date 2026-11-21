import { randomUUID } from 'node:crypto';
import { type Page } from '@playwright/test';
import { arrange, giveADashboard, giveToAPanel, type ArrangedDashboard } from './support/arrange';
import { ADA, dashboardBar, expect, expectNoSidewaysScroll, openDashboard, signIn, test, uniqueTitle } from './support/app';

/**
 * F3: a Dashboard's whiteboard ("Brainstorming: give every Dashboard a
 * whiteboard of its own", issue 1829), with links and free lines
 * ("Brainstorming: the whiteboard can't show how Items connect", issue 1831,
 * whose stored rules are apps/api/tests/integration/http/item-links.test.ts and
 * whose drawing is apps/web/tests/unit/whiteboard/links.test.ts). What each change stores, the Inbox rule
 * and what Undo restores are proved against a real store
 * (apps/api/tests/integration/http/board.test.ts); what a card draws, the
 * toolbar's words and the question "Take it off there too?" are F1
 * (apps/web/tests/unit/whiteboard/, apps/web/tests/unit/whiteboardQuestion.test.tsx).
 * **What is only true in a browser** is that a row really drags onto the board,
 * that a box and a line are drawn by dragging, that a card's dot drags into a
 * link, that the pointer gestures select, toggle and open as agreed, and how
 * the board fits a desk and a phone.
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
/** A card on the board itself, not one drawn inside a parent's unfolded card. */
const topCard = (page: Page, title: string) => page.locator(`[data-card-id] > [data-card="${title}"]`);

/** Drags a card by its title, in steps so the board sees a drag, and lets go at a point of the page. */
async function dragCardTo(page: Page, title: string, to: { x: number; y: number }) {
  const from = (await topCard(page, title).boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height - 6);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 10 });
  await page.mouse.up();
}
const centre = (box: { x: number; y: number; width: number; height: number }) => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });

test.describe('Whiteboard', () => {
  test.describe('a row dragged onto the board becomes a card, a box and a line are drawn, a card’s dot links it to another, and all of it stays', () => {
    test('places the row as a card, draws a named box, links two cards from a hover dot and draws a line at a desk; on a phone the board opens to look at and a tap opens the card', async ({ page, isMobile }) => {
      await signIn(page, ADA, isMobile);
      const [ferry, storm] = [uniqueTitle('Ferry scene'), uniqueTitle('Storm scene')];
      const board = await aDashboardWith(page, [ferry, storm]);

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

      await arrange(page, 'place_card', { cardId: randomUUID(), dashboardId: board.id, itemId: board.panels[0]!.itemIds[1], boxId: null, x: 0, y: 0 });
      await page.reload();
      await openDashboard(page, board.name, isMobile);
      const switched = answerTo(page, 'set_dashboard_view');
      await dashboardBar(page).getByRole('radio', { name: 'Side by side' }).click();
      expect((await switched).status()).toBe(200);
      const whiteboard = page.locator('[data-whiteboard]');
      await expect(whiteboard).toBeVisible();
      // The toolbar is one row, at a desk.
      expect((await page.getByRole('toolbar', { name: 'Whiteboard tools' }).boundingBox())!.height).toBeLessThan(48);

      await expect(topCard(page, storm)).toBeVisible();
      const placed = answerTo(page, 'place_card');
      const area = (await whiteboard.boundingBox())!;
      // Below Storm scene, which the board opened centred on.
      await page.locator('[data-panel-cell] li[data-item-row]').filter({ hasText: ferry }).dragTo(whiteboard, { targetPosition: { x: area.width / 2, y: area.height - 60 } });
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

      // A dot on the side of a card, shown on hover, dragged to another card links the two ("Brainstorming: the whiteboard can't show how Items connect", issue 1831).
      await topCard(page, ferry).hover();
      const dot = (await card(page, ferry).locator('.board-dot.react-flow__handle-top').boundingBox())!;
      await page.mouse.move(dot.x + dot.width / 2, dot.y + dot.height / 2);
      await page.mouse.down();
      const onStorm = centre((await topCard(page, storm).boundingBox())!);
      await page.mouse.move(onStorm.x, onStorm.y, { steps: 10 });
      const linked = answerTo(page, 'link_items');
      await page.mouse.up();
      expect((await linked).status()).toBe(200);
      await expect(whiteboard.locator('.react-flow__edge')).toHaveCount(1);

      const line = answerTo(page, 'draw_line');
      await page.getByRole('button', { name: 'Draw line' }).click();
      await page.mouse.move(area.x + 300, area.y + 80);
      await page.mouse.down();
      await page.mouse.move(area.x + area.width - 40, area.y + 120, { steps: 6 });
      await page.mouse.up();
      expect((await line).status()).toBe(200);
      const labelled = answerTo(page, 'set_line_label');
      await page.getByRole('textbox', { name: 'Label this line' }).fill('Act two');
      await page.keyboard.press('Enter');
      expect((await labelled).status()).toBe(200);

      await page.reload();
      await expect(card(page, ferry)).toBeVisible();
      await expect(page.locator('[data-box="Places"]')).toBeVisible();
      await expect(whiteboard.locator('.react-flow__edge')).toHaveCount(1);
      await expect(whiteboard.locator('[data-line-label="Act two"]')).toBeVisible();
      await expect(dashboardBar(page).getByRole('radio', { name: 'Side by side' })).toHaveAttribute('aria-checked', 'true');
    });
  });

  test.describe('clicks select, toggle or open as agreed, a modifier never opens, and a click on a selected title renames', () => {
    test('a click selects, Shift-click adds, a double-click opens, a row clicked in the Panels selects its card, and a second click on its title or F2 renames it', async ({ page, isMobile }) => {
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

      // Rename in place: the second click on the title of what is selected, a card's after the double-click has had its chance.
      await card(page, ferry).click();
      await expect.poll(() => isSelected(page, ferry)).toBe(true);
      // Two clicks on one card inside the board's double-click window open it, so the second waits it out, as a hand does.
      await page.waitForTimeout(450);
      const retitled = answerTo(page, 'set_title');
      await topCard(page, ferry).getByText(ferry).click();
      const crossing = uniqueTitle('Ferry crossing');
      await page.getByRole('textbox', { name: 'Title' }).fill(crossing);
      await page.keyboard.press('Enter');
      expect((await retitled).status()).toBe(200);
      await expect(topCard(page, crossing)).toBeVisible();
      await expect(page.getByRole('dialog')).toHaveCount(0);

      // F2 on a selected box, and Escape leaves the name as it was.
      await arrange(page, 'draw_box', { boxId: randomUUID(), dashboardId: board.id, parentBoxId: null, label: 'Places', colour: null, x: 0, y: 200, w: 400, h: 200 });
      await page.reload();
      await openDashboard(page, board.name, isMobile);
      await page.locator('[data-box="Places"]').getByText('Places').click();
      await page.keyboard.press('F2');
      await page.getByRole('textbox', { name: 'Name this box' }).fill('Dropped');
      await page.keyboard.press('Escape');
      await expect(page.locator('[data-box="Places"]')).toBeVisible();
      await page.keyboard.press('F2');
      const renamed = answerTo(page, 'rename_box');
      await page.getByRole('textbox', { name: 'Name this box' }).fill('Harbour');
      await page.keyboard.press('Enter');
      expect((await renamed).status()).toBe(200);
      await expect(page.locator('[data-box="Harbour"]')).toBeVisible();
    });
  });

  test.describe('a card dragged on the board lands where it is let go, and one let go on a card asks to put it inside or combine', () => {
    test('moves a card into a box and back out without filing it, then puts one inside a card and combines a row with it', async ({ page, isMobile }) => {
      test.skip(isMobile, 'a phone’s board is only to look at');
      await signIn(page, ADA, isMobile);
      const [chapter, storm, ferry, waves] = [uniqueTitle('Chapter 3'), uniqueTitle('Storm scene'), uniqueTitle('Ferry scene'), uniqueTitle('Waves')];
      const board = await aDashboardWith(page, [chapter, storm, ferry, waves], 'side');
      const [chapterId, stormId, ferryId] = board.panels[0]!.itemIds;
      await arrange(page, 'draw_box', { boxId: randomUUID(), dashboardId: board.id, parentBoxId: null, label: 'Act one', colour: null, x: 0, y: 260, w: 560, h: 260 });
      for (const [itemId, x, y] of [[chapterId, 0, 0], [stormId, 300, 0], [ferryId, 600, 0]] as const) {
        await arrange(page, 'place_card', { cardId: randomUUID(), dashboardId: board.id, itemId, boxId: null, x, y });
      }
      await page.reload();
      await openDashboard(page, board.name, isMobile);
      await expect(topCard(page, ferry)).toBeVisible();
      const row = (title: string) => page.locator('[data-panel-cell] li[data-item-row]').filter({ hasText: title });

      // Into the box, then out onto open space; the Panel's rows never change.
      const box = page.locator('[data-box="Act one"]');
      const into = answerTo(page, 'move_card');
      await dragCardTo(page, storm, centre((await box.boundingBox())!));
      expect((await into).status()).toBe(200);
      await page.reload();
      await openDashboard(page, board.name, isMobile);
      const inside = (await box.boundingBox())!;
      const stormAt = (await topCard(page, storm).boundingBox())!;
      expect(stormAt.y).toBeGreaterThan(inside.y);
      expect(stormAt.y + stormAt.height).toBeLessThan(inside.y + inside.height + 1);
      const out = answerTo(page, 'move_card');
      await dragCardTo(page, storm, { x: stormAt.x + stormAt.width / 2, y: inside.y - 60 });
      expect((await out).status()).toBe(200);
      await expect(row(storm)).toBeVisible();

      // Let go on a card: asked, and nothing moves until it is answered.
      const chapterAt = (await topCard(page, chapter).boundingBox())!;
      await dragCardTo(page, ferry, centre(chapterAt));
      const question = page.getByRole('menu', { name: 'Dropped on an Item' });
      await expect(question.getByRole('menuitem')).toHaveText([`Put inside ${chapter}`, `Combine with ${chapter}…`]);
      const added = answerTo(page, 'put_inside');
      await question.getByRole('menuitem', { name: `Put inside ${chapter}` }).click();
      expect((await added).status()).toBe(200);
      const whiteboard = page.locator('[data-whiteboard]');
      const panels = page.locator('[data-panel-cell]');
      await expect(whiteboard.getByRole('list', { name: `Inside ${chapter}` }).getByText(ferry)).toBeVisible();
      await expect(topCard(page, ferry)).toHaveCount(0);
      // Moved, as Add as child of… moves it ("Panels: Items put inside a parent stay where they were", issue 1876): the Panel shows it once, inside Chapter.
      const onlyInside = async (title: string) => {
        await expect(panels.locator('[data-child-rows]').getByText(title, { exact: true })).toBeVisible();
        await expect(panels.getByText(title, { exact: true })).toHaveCount(1);
      };
      await onlyInside(ferry);

      // A row from the Panels let go on a card is asked the same; one whose Item has a card of its own loses it when put inside.
      await row(storm).dragTo(topCard(page, chapter));
      await page.getByRole('menuitem', { name: `Put inside ${chapter}` }).click();
      await expect(whiteboard.getByRole('list', { name: `Inside ${chapter}` }).getByText(storm)).toBeVisible();
      await expect(topCard(page, storm)).toHaveCount(0);
      await onlyInside(storm);

      // And Combine draws the new parent where the card was.
      await row(waves).dragTo(topCard(page, chapter));
      await page.getByRole('menuitem', { name: `Combine with ${chapter}…` }).click();
      const dialog = page.getByRole('dialog', { name: 'Combine 2 Items' });
      const combined = answerTo(page, 'combine_under_new_parent');
      await dialog.getByRole('button', { name: 'Combine', exact: true }).click();
      const parent = `Combined: ${chapter} +1`;
      expect(((await combined).request().postDataJSON() as { onBoard?: unknown }).onBoard).toBeTruthy();
      await expect(topCard(page, parent)).toBeVisible();
      await expect(topCard(page, chapter)).toHaveCount(0);
      await expect(whiteboard.getByRole('list', { name: `Inside ${parent}` }).getByText(waves)).toBeVisible();
    });
  });

  test.describe('taking a card off removes only the card', () => {
    test('comes off from its menu and Undo puts it back, with the Item still on its Panel', async ({ page, isMobile }) => {
      test.skip(isMobile, 'a phone’s board is only to look at');
      await signIn(page, ADA, isMobile);
      const ferry = uniqueTitle('Ferry scene');
      const board = await aDashboardWith(page, [ferry], 'side');
      await arrange(page, 'place_card', { cardId: randomUUID(), dashboardId: board.id, itemId: board.panels[0]!.itemIds[0], boxId: null, x: 40, y: 40 });
      await page.reload();
      await openDashboard(page, board.name, isMobile);
      await expect(topCard(page, ferry)).toBeVisible();

      await topCard(page, ferry).hover();
      await page.getByRole('button', { name: `Actions for ${ferry}` }).click();
      const off = answerTo(page, 'take_card_off');
      await page.getByRole('menuitem', { name: 'Take off the whiteboard' }).click();
      expect((await off).status()).toBe(200);
      await expect(topCard(page, ferry)).toHaveCount(0);
      await expect(page.locator('[data-panel-cell] li[data-item-row]').filter({ hasText: ferry })).toBeVisible();

      const back = answerTo(page, 'put_cards_back');
      await page.getByRole('button', { name: 'Undo' }).click();
      expect((await back).status()).toBe(200);
      await page.reload();
      await openDashboard(page, board.name, isMobile);
      await expect(topCard(page, ferry)).toBeVisible();
    });
  });
});
