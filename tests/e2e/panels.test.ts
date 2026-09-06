import { type Locator, type Page, type Response } from '@playwright/test';
import type { CommandName } from '@cockpit/shared';
import {
  ADA,
  chooseRowAction,
  dashboardBar,
  expect,
  expectNoSidewaysScroll,
  press,
  signIn,
  test,
  uniqueTitle,
} from './support/app';

/**
 * F3, because the whole of this feature is layout. Whether a dashboard fits the
 * screen it is drawn on, and whether a panel really moves when it is dragged,
 * are claims no level below this one can make: jsdom has no layout engine and
 * reports every width as zero, and it performs no drag.
 *
 * It is not re-proving the naming rules, which
 * apps/api/tests/integration/http/panels.test.ts owns against a real store, nor
 * which layout a screen picks, which apps/web/tests/unit/panels/arrangement.test.ts
 * owns. These are the walks that say the capability works for a person.
 *
 * Each walk makes its own dashboard, **in the second person's account**: every
 * spec in a run shares one database (support/app.ts), so a walk that filled the
 * first dashboard of Work would leave it filled for whatever ran next. Ada's
 * account is the one nothing else here touches, and using it also keeps these
 * walks from lengthening the workspace list that the walks about workspaces
 * assert against - a spec that quietly moves another spec's controls down the
 * page is the order-dependence this tier is arranged to avoid.
 */

/** An empty dashboard of this walk's own, already open. */
async function ownDashboard(page: Page, isMobile: boolean): Promise<void> {
  const name = uniqueTitle('Today');
  await signIn(page, ADA, isMobile);
  await press(page.getByRole('button', { name: 'Add a dashboard' }), isMobile);
  await page.getByLabel('Name of the new dashboard').fill(name);
  await page.getByLabel('Name of the new dashboard').press('Enter');
  await expect(dashboardBar(page).getByRole('link', { name })).toBeVisible();
  await expect(page.getByRole('heading', { name, level: 2 })).toBeVisible();
}

async function addPanel(page: Page, name: string, isMobile: boolean): Promise<void> {
  // In the dashboard's own bar, beside the control naming its layout ("Pick the
  // layout you are on, by name"), rather than in a strip at the foot of the
  // board.
  await press(page.getByRole('button', { name: '+ Panel' }), isMobile);
  await page.getByLabel('Name of the new panel').fill(name);
  await page.getByLabel('Name of the new panel').press('Enter');
  await expect(page.getByRole('region', { name })).toBeVisible();
}

/** The panels as they are laid out, left to right and top to bottom. */
async function panelsOnScreen(page: Page): Promise<string[]> {
  return page.locator('main section[aria-label]').evaluateAll((boxes) =>
    boxes.map((box) => box.getAttribute('aria-label') ?? ''),
  );
}

/**
 * The same, but as the panels on each line - which is the thing rows added and
 * a flat list cannot express ("Rows of panels, not a grid that wraps").
 *
 * Read off the drawn grid rather than off the layout, because which panels
 * share a line is exactly the claim: a stored row nobody can see is not an
 * arrangement.
 */
async function rowsOnScreen(page: Page): Promise<string[][]> {
  return page
    .locator('main [style*="grid-template-columns"]')
    .evaluateAll((rows) =>
      rows.map((row) =>
        [...row.querySelectorAll('section[aria-label]')].map(
          (panel) => panel.getAttribute('aria-label') ?? '',
        ),
      ),
    );
}

/**
 * Fails if the dashboard itself has to be scrolled sideways to be seen.
 *
 * `expectNoSidewaysScroll` asks whether the *page* scrolls, and that is not the
 * same question here: the column a dashboard is drawn in scrolls vertically,
 * which in CSS also makes it scroll horizontally rather than push the document
 * wider. So a grid twice the width of the screen leaves the page perfectly
 * still and hides half of every dashboard - measured, not assumed, by giving
 * the grid fixed-pixel columns and watching the page-level check stay green.
 *
 * Both checks are kept. The page one catches the thing that takes the header
 * and the bar sideways with it; this one catches the thing that only takes the
 * panels.
 *
 * The column rather than `main`, which since "Show the Inbox beside the
 * dashboards instead of as a tab" (issue 117) also holds the Inbox: the
 * dashboard is the last of `main`'s children at every width, with or without
 * the Inbox beside it.
 *
 * Polled rather than measured once, because a window that has just been resized
 * is a window mid-answer: the Inbox leaves the row below 768px, and for a frame
 * after the resize the dashboard is still the narrow column it had beside it.
 * What is under test is where the layout settles, not what it passes through.
 */
async function expectTheDashboardFits(page: Page): Promise<void> {
  const room = () =>
    page
      .locator('main > div')
      .last()
      .evaluate((area) => ({ over: area.scrollWidth - area.clientWidth, area: area.clientWidth }));
  await expect
    .poll(async () => (await room()).over, {
      message: `the dashboard scrolls sideways, in a ${(await room()).area}px column`,
    })
    .toBeLessThanOrEqual(0);
}

/**
 * The server's answer to the one change an arrangement gesture sends, waited
 * for from before the gesture is made.
 *
 * **Nothing on the page can stand in for this.** A dashboard draws the
 * arrangement a gesture produces before it sends it, and drops that drawing
 * once the store agrees (components/PanelBoard.tsx) - so the panels look
 * identical either side of the save, and every assertion about where they are
 * passes on a change that has not left the browser yet. What follows such a
 * gesture in a walk therefore has to wait here, or it is racing a request.
 *
 * **It takes the next answer of that name, whichever gesture asked for it**, so
 * it only says anything about the gesture it brackets if the walk's earlier
 * changes have already been answered. Nothing here can check that; the caller
 * has to have waited.
 *
 * `CommandName` rather than a bare string, because a wait for a name nothing
 * sends does not fail - it hangs until the timeout, saying only that the
 * response never came. Renaming the command breaks the typecheck instead.
 */
function answerTo(page: Page, command: CommandName): Promise<Response> {
  return page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === `/v1/commands/${command}`,
  );
}

/** The control at the right of the dashboard bar, which names the layout in use. */
function layoutControl(page: Page) {
  return page.getByRole('button', { name: 'Layout for this dashboard' });
}

/**
 * Opens the layout menu, waits for one entry per layout plus *Automatic*, and
 * closes it again - which is also how these walks wait for a layout to have
 * landed, since the menu is the only place the dashboard says how many it has.
 */
async function expectLayouts(page: Page, made: number, isMobile: boolean): Promise<void> {
  await press(layoutControl(page), isMobile);
  // One entry per layout, plus the automatic choice at the top.
  await expect(page.getByRole('menuitemradio')).toHaveCount(made + 1);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menuitemradio')).toHaveCount(0);
}

test.describe('Panels', () => {
  test.describe('a panel you add is one you can rename, move and delete on the dashboard itself', () => {
    test('puts it on the dashboard and keeps it there through all three', async ({
      page,
      isMobile,
    }) => {
      await ownDashboard(page, isMobile);
      await expect(
        page.getByText(/A dashboard holds the panels you want in view/),
      ).toBeVisible();

      const falcon = uniqueTitle('Project Falcon');
      const reading = uniqueTitle('To read');
      await addPanel(page, falcon, isMobile);
      await addPanel(page, reading, isMobile);
      expect(await panelsOnScreen(page)).toEqual([falcon, reading]);
      await expectNoSidewaysScroll(page);
      await expectTheDashboardFits(page);

      // Renaming happens in the panel's own header, from its own menu, which is
      // the same two gestures every row of a management window takes.
      const renamed = uniqueTitle('Falcon');
      await chooseRowAction(page, falcon, 'Rename', isMobile);
      await page.getByLabel(`New name for ${falcon}`).fill(renamed);
      await press(page.getByRole('button', { name: 'Save' }), isMobile);
      await expect(page.getByRole('region', { name: renamed })).toBeVisible();

      // Moving, by the entry the screen makes true: the panels are side by side
      // on a laptop and stacked on a phone, so the direction is named for what
      // the person is actually looking at.
      await chooseRowAction(page, reading, isMobile ? 'Move up' : 'Move left', isMobile);
      await expect
        .poll(() => panelsOnScreen(page))
        .toEqual([reading, renamed]);

      await chooseRowAction(page, reading, 'Delete', isMobile);
      await expect(
        page.getByText(`Delete ${reading}? It goes from every layout of this dashboard.`),
      ).toBeVisible();
      await press(page.getByRole('button', { name: `Yes, delete ${reading}` }), isMobile);
      await expect.poll(() => panelsOnScreen(page)).toEqual([renamed]);
      await expectNoSidewaysScroll(page);
      await expectTheDashboardFits(page);
    });
  });

  test.describe('a dashboard is drawn to fit the screen it is on, whatever it was arranged for', () => {
    test('never scrolls sideways, and keeps a change in the layout it is drawn with', async ({
      page,
      isMobile,
    }) => {
      await ownDashboard(page, isMobile);
      const first = uniqueTitle('Project Falcon');
      const second = uniqueTitle('To read');
      const third = uniqueTitle('People');
      await addPanel(page, first, isMobile);
      await addPanel(page, second, isMobile);
      await addPanel(page, third, isMobile);

      // Arranged on the screen it is on now, which stores the dashboard's
      // first layout and names it for that screen. Nothing is asked.
      //
      // The *second* panel, because what a move is called now depends on the
      // panel's own row rather than on the screen: this one shares a row on a
      // desktop, where the board fits two across, so it has somewhere to go
      // left. On a phone every row holds one and every move is up or down.
      await chooseRowAction(page, second, isMobile ? 'Move up' : 'Move left', isMobile);
      await expect(page.getByRole('alertdialog')).toHaveCount(0);
      // Waited for by name rather than by a pause: the layout is what the next
      // half of this walk changes *from*, and pressing again before it landed
      // would be a change made against a dashboard that still had no layout -
      // which is a different rule, and not the one under test here.
      await expectLayouts(page, 1, isMobile);
      await expectNoSidewaysScroll(page);
      await expectTheDashboardFits(page);

      // A different screen. The layout stored a moment ago was made for the
      // other one, so it is squeezed to fit rather than cut off - which is what
      // the sideways-scroll check is really asserting, and which is why the
      // panels are in the same order on both: the rows are the arrangement, and
      // a narrower screen draws the same rows narrower rather than re-wrapping
      // them.
      const arranged = await panelsOnScreen(page);
      const wasWide = page.viewportSize()!.width > 700;
      await page.setViewportSize({ width: wasWide ? 420 : 1100, height: 800 });
      await expect.poll(() => panelsOnScreen(page)).toEqual(arranged);
      await expectNoSidewaysScroll(page);
      await expectTheDashboardFits(page);

      // A layout for this screen, made by name rather than as the answer to a
      // question about a drag. It is picked as it is made, so what is drawn
      // afterwards is the new one.
      await press(layoutControl(page), isMobile);
      await press(page.getByRole('menuitem', { name: /^New layout from this one/ }), isMobile);
      const named = uniqueTitle('Narrow');
      await page.getByLabel('Name of the new layout').fill(named);
      await page.getByLabel('Name of the new layout').press('Enter');
      await expect(layoutControl(page)).toHaveText(new RegExp(named));

      // Two layouts now, one per screen, and a change made here goes into the
      // one on screen without asking.
      //
      // *Move up* on both projects, and not because of the screen: what a move
      // is called follows the panel's own row now, and this panel has a row to
      // itself in either arrangement - the desktop put two on the first line
      // and this one on the second, the phone put every panel on a line of its
      // own. A screen-width guess is what this used to make, and a wider screen
      // does not turn a row of one into a row of two.
      await chooseRowAction(page, third, 'Move up', isMobile);
      await expect(page.getByRole('alertdialog')).toHaveCount(0);
      await expectLayouts(page, 2, isMobile);
      await expectNoSidewaysScroll(page);
      await expectTheDashboardFits(page);
    });
  });

  test.describe('a panel too narrow for its name, its count and its menu gives the room to the name', () => {
    // F3 for the reason the rest of this file is: the header is drawn to the
    // panel's own width, which is a container query, and jsdom has neither a
    // layout engine nor container queries - it would report the count as shown
    // at every width, including the ones where it is not.
    test('drops the count when the panel is squeezed, and keeps it where there is room', async ({
      page,
      isMobile,
    }) => {
      // Wide enough for three panels side by side, so the layout this records
      // is one the narrow screen below has to squeeze into four columns each.
      await page.setViewportSize({ width: 1600, height: 900 });
      await ownDashboard(page, isMobile);
      const waiting = uniqueTitle('Waiting on people');
      const falcon = uniqueTitle('Project Falcon');
      const reading = uniqueTitle('To read');
      await addPanel(page, waiting, isMobile);
      await addPanel(page, falcon, isMobile);
      await addPanel(page, reading, isMobile);

      const panel = page.getByRole('region', { name: waiting });
      const count = panel.getByText('0', { exact: true });
      await expect(count).toBeVisible();

      // Recorded as this screen's layout, so narrowing squeezes it rather than
      // arranging the panels afresh for the screen they are now on - which is
      // how a panel ends up narrower than any screen would have made it.
      await chooseRowAction(page, reading, 'Move left', isMobile);
      await expectLayouts(page, 1, isMobile);

      await page.setViewportSize({ width: 420, height: 800 });
      await expect.poll(async () => (await panel.boundingBox())!.width).toBeLessThan(200);

      // The count goes, because the list underneath already shows what is on
      // the panel; the name and the menu stay, being the panel's own name and
      // the only way to rename, move or delete it.
      await expect(count).toBeHidden();
      await expect(panel.getByRole('heading', { name: waiting })).toBeVisible();
      await expect(page.getByRole('button', { name: `Actions for ${waiting}` })).toBeVisible();

      // And the room it gave up goes to the name, which now has more of the
      // header than everything else in it put together.
      const room = await panel.evaluate((section) => {
        const header = section.querySelector('header')!;
        const name = header.querySelector('h3')!;
        return {
          header: header.getBoundingClientRect().width,
          name: name.getBoundingClientRect().width,
        };
      });
      expect(
        room.name,
        `the name has ${Math.round(room.name)}px of a ${Math.round(room.header)}px header`,
      ).toBeGreaterThan(room.header - room.name);
    });
  });

  test.describe('a panel goes where you drag it', () => {
    // Desktop only, and the reason is the gesture rather than the screen: the
    // browser's own drag-and-drop is a mouse protocol, so dragging a panel
    // cannot happen on a touchscreen at all - moving there is the entry in the
    // panel's own menu, which the walk above drives on both projects.
    test.skip(({ isMobile }) => !!isMobile, 'dragging a panel is a pointer gesture');

    test('joins the row of the panel it was dropped on, and leaves the row behind', async ({
      page,
      isMobile,
    }) => {
      await ownDashboard(page, isMobile);
      const first = uniqueTitle('Project Falcon');
      const second = uniqueTitle('To read');
      const third = uniqueTitle('People');
      await addPanel(page, first, isMobile);
      await addPanel(page, second, isMobile);
      await addPanel(page, third, isMobile);
      // Two fit across a desktop board, so the third starts on a line of its
      // own - which is what makes this a drag between rows rather than along
      // one, and the only arrangement that can show a row being left behind.
      await expect.poll(() => rowsOnScreen(page)).toEqual([[first, second], [third]]);

      // Waited for from before the gesture, because the board draws the
      // arrangement a drag produces before it sends it: every assertion below
      // would pass on a change still sitting in the browser.
      const saved = answerTo(page, 'save_layout');
      // The header is the handle; the panel is the target, and *where* on it
      // decides which side it lands - so the left tenth rather than the centre,
      // which is what `dragTo` aims at by default and reads as the right-hand
      // half.
      await page
        .getByRole('region', { name: third })
        .locator('header')
        .dragTo(page.getByRole('region', { name: first }), { targetPosition: { x: 8, y: 20 } });
      expect((await saved).status()).toBe(200);

      // One row now, holding all three, and the line the third panel came from
      // has gone with it rather than staying behind as a blank.
      await expect.poll(() => rowsOnScreen(page)).toEqual([[third, first, second]]);
      await expectNoSidewaysScroll(page);
      await expectTheDashboardFits(page);
    });

    test('takes a line of its own when it is let go in the gap between two rows', async ({
      page,
      isMobile,
    }) => {
      // The seam is four pixels of gap at rest and opens to something a hand
      // can hit only while a panel is actually in the air, so whether it is a
      // target at all is a question about a real drag against a real layout -
      // the one claim in this gesture that no amount of firing events at the
      // element can answer. The board's half of it, what the drop *means*, is
      // settled in apps/web/tests/unit/components/PanelBoard.test.tsx.
      await ownDashboard(page, isMobile);
      const first = uniqueTitle('Project Falcon');
      const second = uniqueTitle('To read');
      await addPanel(page, first, isMobile);
      await addPanel(page, second, isMobile);
      await expect.poll(() => rowsOnScreen(page)).toEqual([[first, second]]);

      // Aimed at where the gap above the row *is*, measured while the drag is
      // on rather than beforehand: at rest it is four pixels, and a point
      // picked from that would be off the seam the moment it opened.
      const saved = answerTo(page, 'save_layout');
      const board = page.getByRole('region', { name: first });
      await page.mouse.move(...(await centreOf(board.locator('header'))));
      await page.mouse.down();
      const seam = page.locator('main [data-testid="row-seam"]').first();
      // Two moves, because a drag that jumps straight to its destination in one
      // step gives the page nothing to react to: the seams open on the first.
      await page.mouse.move(...(await centreOf(board)), { steps: 4 });
      await page.mouse.move(...(await centreOf(seam)), { steps: 4 });
      await page.mouse.up();
      expect((await saved).status()).toBe(200);

      await expect.poll(() => rowsOnScreen(page)).toEqual([[first], [second]]);
      await expectNoSidewaysScroll(page);
      await expectTheDashboardFits(page);
    });
  });
});

/** The middle of something, as the pair `page.mouse.move` takes. */
async function centreOf(what: Locator): Promise<[number, number]> {
  const box = await what.boundingBox();
  if (!box) throw new Error('nothing to aim at');
  return [box.x + box.width / 2, box.y + box.height / 2];
}
