import { expect, test, type Page } from '@playwright/test';
import {
  ADA,
  captureBox,
  dashboardBar,
  dragItemOnto,
  inbox,
  itemRow,
  itemsOn,
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

/**
 * F3, and here rather than beside the other undo walk because putting an item
 * back where it came from needs a panel to have moved it to, and this file is
 * where a dashboard with one is arranged.
 *
 * Undoing a move is the second thing the bar can put back, and it is a
 * different inverse from undoing a dismissal: a status against a panel and an
 * order. What the inverse *is* belongs to
 * apps/web/tests/unit/components/ItemList.test.tsx; what is only true here is
 * that pressing Undo really does return the item to the list it left.
 */
test.describe('Triage', () => {
  test.describe('what just happened can be put back, until the offer runs out', () => {
    test('brings an item back out of the panel it was filed onto', async ({ page, isMobile }) => {
      const { dashboard, panel } = await ownDashboardWithAPanel(page, isMobile);
      const title = uniqueTitle('Filed by mistake');

      await goToTheInbox(page, isMobile);
      await captureBox(page).fill(title);
      await press(page.getByRole('button', { name: 'Capture' }), isMobile);
      await fileOnto(page, title, panel, isMobile);
      await expect(inbox(page).getByText(title)).toHaveCount(0);

      const offer = page.getByRole('status');
      await expect(offer).toContainText(panel);
      await press(offer.getByRole('button', { name: 'Undo' }), isMobile);

      // Back in the Inbox, off the panel, and the offer gone with it.
      await expect(inbox(page).getByText(title)).toBeVisible();
      await goToTheDashboard(page, dashboard, isMobile);
      await expect(page.getByRole('region', { name: panel }).getByText(title)).toHaveCount(0);
      await expect(offer).toHaveCount(0);
    });
  });
});

/**
 * F3, and it can be nowhere else: a drag only exists in a browser, and where a
 * drop lands is a claim about where the rows actually are on the screen. jsdom
 * has no layout engine and does not carry a pointer position through a drop
 * event, so the level below can prove which gap a *position* picks out
 * (apps/web/tests/unit/dropAt.test.ts) and that a drop reaches the right
 * command (apps/web/tests/unit/components/ItemList.test.tsx), and nothing about
 * aiming.
 */
test.describe('Panels', () => {
  test.describe('a dropped row is sent to the panel it was dropped on, in the place it was dropped', () => {
    test('drops an item between two rows, and where it was let go is where it lands', async ({
      page,
      isMobile,
    }) => {
      // Desktop only, and not because of the input: on a 480px screen the Inbox
      // and the dashboard are two screens, so there is nowhere to drag *from*.
      // The phone files an item by swiping it right, which is issue 145's walk.
      test.skip(isMobile, 'the Inbox and the dashboard are not on one screen here');
      const { dashboard, panel } = await ownDashboardWithAPanel(page, isMobile);
      const first = uniqueTitle('Renew the domain');
      const second = uniqueTitle('Read the routing paper');
      const arriving = uniqueTitle('Reply to Bart');

      await goToTheInbox(page, isMobile);
      for (const title of [first, second, arriving]) {
        await captureBox(page).fill(title);
        await press(page.getByRole('button', { name: 'Capture' }), isMobile);
        await expect(itemRow(page, title)).toBeVisible();
      }
      await fileOnto(page, first, panel, isMobile);
      await fileOnto(page, second, panel, isMobile);
      await goToTheDashboard(page, dashboard, isMobile);
      // Filed one at a time from the menu, so each lands on top of the one
      // before: the panel reads second, first.
      await expect.poll(() => itemsOn(page, panel)).toEqual([second, first]);

      // Onto the bottom half of the first row, which is the gap between them.
      await goToTheInbox(page, isMobile);
      await dragItemOnto(page, arriving, { title: second, half: 'bottom' });

      await goToTheDashboard(page, dashboard, isMobile);
      await expect.poll(() => itemsOn(page, panel)).toEqual([second, arriving, first]);
      await goToTheInbox(page, isMobile);
      await expect(inbox(page).getByText(arriving)).toHaveCount(0);
    });

    test('reorders a panel when a row is dropped inside the panel it is already on', async ({
      page,
      isMobile,
    }) => {
      const { dashboard, panel } = await ownDashboardWithAPanel(page, isMobile);
      const first = uniqueTitle('Renew the domain');
      const second = uniqueTitle('Read the routing paper');
      const third = uniqueTitle('Chase the invoice');

      await goToTheInbox(page, isMobile);
      for (const title of [first, second, third]) {
        await captureBox(page).fill(title);
        await press(page.getByRole('button', { name: 'Capture' }), isMobile);
        await expect(itemRow(page, title)).toBeVisible();
      }
      for (const title of [first, second, third]) await fileOnto(page, title, panel, isMobile);
      await goToTheDashboard(page, dashboard, isMobile);
      // Each filed from the menu lands on top of the one before.
      await expect.poll(() => itemsOn(page, panel)).toEqual([third, second, first]);

      // **Three rows, not two, and that is the point.** Moving the top row down
      // past one row is where taking it out of its old place shifts the gaps
      // below: with two rows the answer is the same either way, because a place
      // past the end is clamped to the end, so a walk over two rows passes just
      // as well when the shift is not made at all.
      await dragItemOnto(page, third, { title: second, half: 'bottom' });

      await expect.poll(() => itemsOn(page, panel)).toEqual([second, third, first]);
    });
  });
});

/**
 * F3, and only in a browser: the question is asked by a drop, and a drop is a
 * gesture. Which answer sends which command is
 * apps/web/tests/unit/components/ItemList.test.tsx, and what each command does
 * to a panel is apps/api/tests/integration/http/panel-items.test.ts. What is
 * only true here is that a person can get one item onto two panels at once and
 * see it on both.
 *
 * Desktop only, for the reason the other drag walks are: on a phone the panels
 * are one to a screen, so there is nowhere to drag between.
 */
test.describe('Panels', () => {
  test.describe('a drop from one panel onto another asks which it is, and sends what was chosen', () => {
    test('adds the item to the second panel, leaving it on the first', async ({
      page,
      isMobile,
    }) => {
      test.skip(isMobile, 'two panels are not on one screen here');
      const { dashboard, panel } = await ownDashboardWithAPanel(page, isMobile);
      const second = uniqueTitle('Anna');
      await press(page.getByRole('button', { name: 'Add a panel' }), isMobile);
      await page.getByLabel('Name of the new panel').fill(second);
      await page.getByLabel('Name of the new panel').press('Enter');
      await expect(page.getByRole('region', { name: second })).toBeVisible();

      const title = uniqueTitle('Belongs on both');
      await goToTheInbox(page, isMobile);
      await captureBox(page).fill(title);
      await press(page.getByRole('button', { name: 'Capture' }), isMobile);
      await fileOnto(page, title, panel, isMobile);
      await goToTheDashboard(page, dashboard, isMobile);
      await expect.poll(() => itemsOn(page, panel)).toEqual([title]);

      // Dragged from one panel to the other: both answers are possible, so it
      // asks rather than guessing.
      const row = page.getByRole('region', { name: panel }).getByRole('listitem').first();
      const target = page.getByRole('region', { name: second });
      const from = await row.boundingBox();
      const to = await target.boundingBox();
      if (!from || !to) throw new Error('one of the two panels is not on screen');
      await row.dragTo(target, { targetPosition: { x: to.width / 2, y: to.height / 2 } });

      const question = page.getByRole('alertdialog');
      await expect(question).toBeVisible();
      await expect(question).toContainText(title);
      await press(question.getByRole('button', { name: 'Add it here as well' }), isMobile);

      // On both at once, which is the whole point of a panel being a view over
      // one shared list rather than a folder.
      await expect.poll(() => itemsOn(page, panel)).toEqual([title]);
      await expect.poll(() => itemsOn(page, second)).toEqual([title]);
    });
  });
});

/**
 * F3, and it can be nowhere else: scrolling and dragging both only exist in a
 * browser, and "the dashboard changed under the drag" is a claim about a real
 * page. How fast a drag near an edge scrolls, and how long a rest has to last,
 * are apps/web/tests/unit/scrollWhileDragging.test.ts; that the bar reaches
 * those rules is apps/web/tests/unit/components/DashboardBar.test.tsx.
 *
 * Desktop only, like the other drag walks.
 */
test.describe('Panels', () => {
  test.describe('a drag resting on a dashboard’s name switches to it', () => {
    test('drops the item on a panel of the dashboard it switched to, and stays there', async ({
      page,
      isMobile,
    }) => {
      test.skip(isMobile, 'the Inbox and the dashboards are not on one screen here');
      const { dashboard, panel } = await ownDashboardWithAPanel(page, isMobile);

      // A second dashboard, with a panel of its own, and back to the first.
      const elsewhere = uniqueTitle('Research');
      await press(page.getByRole('button', { name: 'Add a dashboard' }), isMobile);
      await page.getByLabel('Name of the new dashboard').fill(elsewhere);
      await page.getByLabel('Name of the new dashboard').press('Enter');
      // Waited for: adding a dashboard switches to it, and the board is keyed
      // by dashboard, so the panel form that was on screen is replaced.
      await expect(page.getByRole('heading', { name: elsewhere, level: 2 })).toBeVisible();
      const toRead = uniqueTitle('To read');
      await press(page.getByRole('button', { name: 'Add a panel' }), isMobile);
      await page.getByLabel('Name of the new panel').fill(toRead);
      await page.getByLabel('Name of the new panel').press('Enter');
      await expect(page.getByRole('region', { name: toRead })).toBeVisible();
      await press(dashboardBar(page).getByRole('link', { name: dashboard }), isMobile);
      await expect(page.getByRole('region', { name: panel })).toBeVisible();

      const title = uniqueTitle('Goes to the other dashboard');
      await captureBox(page).fill(title);
      await press(page.getByRole('button', { name: 'Capture' }), isMobile);
      await expect(itemRow(page, title)).toBeVisible();

      // Picked up on this dashboard, held over the other one's name until the
      // page changes under it, and let go on a panel that was not on screen
      // when the drag began.
      const row = itemRow(page, title);
      const tab = dashboardBar(page).getByRole('link', { name: elsewhere });
      // Scrolled to before it is measured, which is what `dragRowOnto` records:
      // the bar scrolls sideways once a workspace has a few dashboards, and
      // `boundingBox` reports where a tab is without scrolling to it — so a tab
      // off the end is measured at a coordinate the mouse cannot reach and the
      // drag silently does nothing. Every walk in this file adds a dashboard to
      // the same account, so by the end of a run there are several.
      await tab.scrollIntoViewIfNeeded();
      await row.scrollIntoViewIfNeeded();
      const from = await row.boundingBox();
      const over = await tab.boundingBox();
      if (!from || !over) throw new Error('the row or the tab is not on screen');
      const viewport = page.viewportSize();
      if (viewport && (over.x < 0 || over.x + over.width > viewport.width)) {
        throw new Error(
          `the ${elsewhere} tab is at ${over.x}px of a ${viewport.width}px screen, so the mouse cannot reach it`,
        );
      }

      await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
      await page.mouse.down();
      await page.mouse.move(over.x + over.width / 2, over.y + over.height / 2, { steps: 8 });
      // Held there. `dragover` keeps firing while a drag is still, and the dwell
      // is what tells a pause from a pointer crossing the bar on its way.
      for (let held = 0; held < 12; held += 1) {
        await page.mouse.move(over.x + over.width / 2, over.y + over.height / 2 + (held % 2));
        await page.waitForTimeout(100);
      }

      await expect(page.getByRole('region', { name: toRead })).toBeVisible();
      const target = await page.getByRole('region', { name: toRead }).boundingBox();
      if (!target) throw new Error('the other dashboard’s panel is not on screen');
      await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 8 });
      await page.mouse.up();

      // On the panel it was dropped on — and that dashboard is the one still
      // open, because it is where you just put something.
      await expect.poll(() => itemsOn(page, toRead)).toEqual([title]);
      await expect(page.getByRole('heading', { name: elsewhere, level: 2 })).toBeVisible();
    });
  });
});

/**
 * F3, and it can be nowhere else: this is a claim about a page that actually
 * scrolls. jsdom has no layout engine and runs no animation frames, so the
 * level below can prove how fast a pointer near an edge *should* scroll
 * (apps/web/tests/unit/scrollWhileDragging.test.ts) and nothing about whether
 * anything moves.
 *
 * Desktop only: the phone has no drag.
 */
test.describe('Panels', () => {
  test.describe('a drag near an edge scrolls what is under it', () => {
    test('scrolls the Inbox while a row is held at its bottom edge', async ({ page, isMobile }) => {
      test.skip(isMobile, 'there is no drag on a touchscreen');
      await signIn(page, ADA, isMobile);

      // Enough rows that the column has somewhere to scroll to. Sixteen is
      // about twice what a 720px screen shows.
      const first = uniqueTitle('The first of many');
      for (let made = 0; made < 16; made += 1) {
        await captureBox(page).fill(made === 0 ? first : uniqueTitle(`Filler ${made}`));
        await press(page.getByRole('button', { name: 'Capture' }), isMobile);
      }
      const column = page.getByRole('complementary', { name: 'Inbox' });
      await expect
        .poll(() => column.evaluate((box) => box.scrollHeight > box.clientHeight))
        .toBe(true);

      const row = itemRow(page, first);
      const from = await row.boundingBox();
      const over = await column.boundingBox();
      if (!from || !over) throw new Error('the row or the column is not on screen');

      await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
      await page.mouse.down();
      // Held at the bottom edge. The moves are what keep the drag reporting
      // where it is; the scrolling itself is a frame loop, which is why this
      // waits rather than expecting one move to have done it.
      for (let held = 0; held < 10; held += 1) {
        await page.mouse.move(over.x + over.width / 2, over.y + over.height - 4 + (held % 2));
        await page.waitForTimeout(60);
      }
      const scrolled = await column.evaluate((box) => box.scrollTop);
      await page.mouse.up();

      expect(scrolled, 'the Inbox did not scroll while a row was held at its edge').toBeGreaterThan(0);
    });
  });
});
