import { randomUUID } from 'node:crypto';
import type { Locator, Page } from '@playwright/test';
import {
  capture,
  chooseRowAction,
  chooseTabAction,
  closeTheFilterSheet,
  dashboardBar,
  dashboardTab,
  dashboardTabs,
  dragDashboardTabOnto,
  expect,
  expectNoSidewaysScroll,
  filterSheet,
  inbox,
  itemRow,
  makeWorkspace,
  openDashboard,
  openFirstWorkspace,
  press,
  setFormStatus,
  switchTo,
  test,
  uniqueTitle,
} from './support/app';

/**
 * What is drawn on top at a point. A hit test cannot say: while a menu or a
 * window is open Radix makes everything outside it inert, which a hit test
 * skips, so the bar would be passed over even where it is painted over the
 * menu. Lifting that for the one question is what exposes paint order.
 */
const drawnOnTopAt = (page: Page, x: number, y: number) =>
  page.evaluate(
    ([px, py]) => {
      const before = document.body.style.pointerEvents;
      document.body.style.pointerEvents = 'auto';
      const top = document.elementFromPoint(px!, py!);
      document.body.style.pointerEvents = before;
      return {
        inTheBar: !!top?.closest(
          '[role="search"][aria-label="Dashboard filter"], [role="group"][aria-label="Dashboard filter summary"]',
        ),
        role: top?.getAttribute('role') ?? top?.tagName.toLowerCase(),
      };
    },
    [x, y],
  );

/**
 * F3, because the bar, the field that grows in it and the address only exist in
 * a browser: the `+` is reached by a tap on a 480px screen and by a mouse on a
 * 1280px one, and landing on a dashboard by its own address is real navigation.
 *
 * It is not re-proving the naming rules, which
 * apps/api/tests/integration/http/dashboards.test.ts owns against a real store,
 * nor which view a workspace opens on, which
 * apps/web/tests/unit/router.test.tsx owns. This is the one walk that says the
 * capability works for a person.
 *
 * It adds its dashboard to a workspace it makes, not to a seeded one: every
 * spec in a run shares one database (support/app.ts), so a walk that filled
 * Work's bar would leave it filled for whatever ran next.
 */
test.describe('Dashboards', () => {
  test.describe('a dashboard you add is one you can switch to and come back to', () => {
    test('puts it in the bar, opens it empty, and is reachable by its address', async ({
      page,
      isMobile,
    }) => {
      // Its own workspace, which is what the note above promises: adding to
      // Work would leave its bar filled for whatever spec ran next.
      const workspace = uniqueTitle('Bookkeeping');
      await openFirstWorkspace(page, isMobile);
      await makeWorkspace(page, workspace, isMobile);
      await switchTo(page, workspace, isMobile);
      await expect(dashboardBar(page)).toBeInViewport();
      await expectNoSidewaysScroll(page);

      const name = uniqueTitle('Research');
      await press(page.getByRole('button', { name: 'Add a dashboard' }), isMobile);
      // The question says what a dashboard is, which is the moment somebody
      // pressing `+` is asking. Matched on the opening clause, so rewording the
      // sentence around it does not re-break this walk.
      //
      // Walking away from it is not here: Escape closing the question and
      // adding nothing belongs to the shared dialog rather than to this bar,
      // and is proved on it (apps/web/tests/unit/components/DashboardBar.test.tsx
      // presses Escape after a refusal and finds the box empty on reopening).
      await expect(
        page.getByRole('dialog').getByText(/A view inside one workspace/),
      ).toBeVisible();
      // Enter, not the button: adding a dashboard is a one-gesture thing you do
      // often, and a real key event is the only way to know the field takes it.
      await page.getByLabel('Name of the new dashboard').fill(name);
      await page.getByLabel('Name of the new dashboard').press('Enter');

      // In the bar, and open on it: adding one puts you on it, so this walk
      // does not have to switch first.
      const tab = dashboardBar(page).getByRole('link', { name });
      await expect(tab).toBeVisible();
      await expect(page.getByRole('heading', { name })).toBeVisible();
      // A dashboard you add is one you can file into: it arrives with a panel,
      // so the Inbox has a target from the moment the dashboard exists rather
      // than an empty sheet. Matched on the title the panel arrives under.
      await expect(page.getByRole('heading', { name: 'Panel 1' })).toBeVisible();
      await expectNoSidewaysScroll(page);

      // The Inbox is on screen either way, which is what says the bar holds
      // dashboards and the Inbox is not one of them: a tab in the same bar
      // where there is no room beside, and already there where there is
      // ("Show the Inbox beside the dashboards instead of as a tab", issue
      // 117). Which of the two, and that they fit, is tests/e2e/inbox.test.ts.
      const address = page.url();
      if (isMobile) {
        await press(dashboardBar(page).getByRole('link', { name: 'Inbox' }), isMobile);
      }
      await expect(inbox(page)).toBeVisible();

      // Reachable by its own address, which is what makes a dashboard something
      // you can link to and come back to.
      await page.goto(address);
      await expect(page.getByRole('heading', { name })).toBeVisible();
    });
  });

  test.describe('a dashboard you move is where you put it in the bar', () => {
    /**
     * F3, and the drag exists nowhere below a browser at all - where the
     * pointer is over the bar is measured from the tabs' rectangles, and jsdom
     * has no layout engine to give it any. What the drag's answer does is
     * settled in apps/web/tests/unit/components/DashboardBar.test.tsx, and that
     * the server keeps the order in
     * apps/api/tests/integration/http/dashboards.test.ts.
     *
     * Desktop only: dragging a tab is a mouse gesture with no keyboard or
     * touch alternative, the same as the workspace strip above.
     */
    test('moves it when its tab is dragged over another, and the order survives a reload', async ({
      page,
      isMobile,
    }) => {
      test.skip(isMobile, 'a drag is the pointer’s; a finger has no way to move a tab');
      // Its own workspace, for the reason every walk here makes one: the run
      // shares one database, and a reordered bar would stay reordered for
      // whatever ran next.
      const workspace = uniqueTitle('Bookkeeping');
      await openFirstWorkspace(page, isMobile);
      await makeWorkspace(page, workspace, isMobile);
      await switchTo(page, workspace, isMobile);

      const mover = uniqueTitle('Mover');
      await press(page.getByRole('button', { name: 'Add a dashboard' }), isMobile);
      await page.getByLabel('Name of the new dashboard').fill(mover);
      await page.getByLabel('Name of the new dashboard').press('Enter');
      await expect(page.getByRole('heading', { name: mover })).toBeVisible();
      // Added after the one the workspace arrives with, which is what the drag
      // is about to change - and a walk that never saw it there would not know
      // the move happened.
      await expect.poll(async () => placesApart(await dashboardTabs(page), mover)).toBe(1);

      // Armed before the gesture, because the answer is what the reload below
      // has to come after: the bar paints a move before the server agrees, so
      // the poll under the drag is satisfied by the preview alone and a reload
      // fired on it would cancel the request in flight and read back an order
      // nothing ever wrote.
      const kept = page.waitForResponse(
        (response) =>
          response.url().endsWith('/v1/commands/reorder_dashboards') && response.status() === 200,
      );

      await dragDashboardTabOnto(page, mover, 'Dashboard 1');

      await expect.poll(async () => placesApart(await dashboardTabs(page), mover)).toBe(-1);
      await kept;

      // Read back from the server rather than painted: the bar shows a move
      // before the server has agreed, so only a reload says the order was kept
      // rather than merely drawn.
      await page.reload();
      await expect.poll(async () => placesApart(await dashboardTabs(page), mover)).toBe(-1);
      await expectNoSidewaysScroll(page);
    });

    /** Where the moved tab sits relative to the one the workspace arrived with. */
    function placesApart(tabs: string[], mover: string): number {
      return tabs.indexOf(mover) - tabs.indexOf('Dashboard 1');
    }
  });

  test.describe('deleting the dashboard you are on leaves you somewhere that works', () => {
    test('renames one on its own tab, and lands elsewhere after deleting it', async ({
      page,
      isMobile,
    }) => {
      // Its own workspace: every spec in a run shares one database, and a walk
      // that deleted a dashboard out of Work would take it from whatever ran
      // next.
      const workspace = uniqueTitle('Bookkeeping');
      await openFirstWorkspace(page, isMobile);
      await makeWorkspace(page, workspace, isMobile);
      await switchTo(page, workspace, isMobile);

      const doomed = uniqueTitle('Recherche');
      await press(page.getByRole('button', { name: 'Add a dashboard' }), isMobile);
      await page.getByLabel('Name of the new dashboard').fill(doomed);
      await page.getByLabel('Name of the new dashboard').press('Enter');
      await expect(page.getByRole('heading', { name: doomed })).toBeVisible();
      // The dashboard being deleted is the one being looked at.
      const itsAddress = page.url();

      // From the bar's own visible "…" this time, rather than the tab's
      // right-click - the same entries, from the same list ("Give the open
      // workspace and dashboard their own "…", and split the header's menu
      // into settings and you", issue 567). The form it opens is a dialog
      // over the workspace rather than a screen, which is a stacking and
      // focus-trapping question only a browser answers.
      const renamed = uniqueTitle('Renamed');
      await chooseRowAction(page, doomed, 'Edit…', isMobile);
      await page.getByLabel(`Name of ${doomed}`).fill(renamed);
      await press(page.getByRole('button', { name: 'Save' }), isMobile);
      // In the bar, which is the only place a dashboard's name is now: the
      // list that used to hold a second copy of it is gone.
      await expect(dashboardTab(page, renamed)).toBeVisible();

      await chooseTabAction(page, dashboardTab(page, renamed), 'Delete', isMobile);
      // Its one panel is the one it arrived with, and the question names what
      // goes with the dashboard rather than only that it is going. The
      // "nothing on it" wording is reachable only after that panel has been
      // deleted, and is proved on the question itself
      // (apps/web/tests/unit/components/DashboardBar.test.tsx).
      await expect(page.getByText(`Delete ${renamed}? Its one panel goes with it.`)).toBeVisible();
      await press(page.getByRole('button', { name: `Yes, delete ${renamed}` }), isMobile);

      // Somewhere that works: a dashboard that is still there, and no tab in
      // the bar pointing at the one that has gone. The workspace moved
      // underneath by itself, the dashboard deleted being the one being looked
      // at.
      await expect(dashboardBar(page).getByRole('link', { name: renamed })).toHaveCount(0);
      await expect(page.getByRole('heading', { name: 'Dashboard 1' })).toBeVisible();
      expect(page.url()).not.toBe(itsAddress);
      await expectNoSidewaysScroll(page);
    });
  });

  test.describe('a person reads every item from All items', () => {
    /**
     * F3, because only a browser has the real tab, address and item form
     * together, on a mouse at 1280px and a finger at 480px. Which items the
     * table lists, how a row reads and how a header orders it is
     * apps/web/tests/unit/allItems.test.ts, and that the address turns the tab
     * on is apps/web/tests/unit/router.test.tsx.
     */
    test('shows the tab from a dashboard’s menu, lists a finished item, and reopens it from its form', async ({
      page,
      isMobile,
    }) => {
      // Its own workspace, for the reason the walks above give.
      const workspace = uniqueTitle('Bookkeeping');
      await openFirstWorkspace(page, isMobile);
      await makeWorkspace(page, workspace, isMobile);
      await switchTo(page, workspace, isMobile);

      // A finished item, which no list shows: finished from its form.
      const finished = uniqueTitle('Filed the return');
      if (isMobile) await press(dashboardBar(page).getByRole('link', { name: 'Inbox' }), isMobile);
      await capture(page, finished, isMobile);
      await press(itemRow(page, finished).getByRole('button', { name: 'Item actions' }), isMobile);
      await press(page.getByRole('menuitem', { name: 'Open' }), isMobile);
      await setFormStatus(page, 'done', isMobile);
      await press(page.getByRole('dialog').getByRole('button', { name: 'Save' }), isMobile);
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(itemRow(page, finished)).toHaveCount(0);

      await openDashboard(page, 'Dashboard 1', isMobile);
      await expect(dashboardBar(page).getByRole('link', { name: 'All items' })).toHaveCount(0);
      await chooseRowAction(page, 'Dashboard 1', 'Show all items', isMobile);

      // After the dashboards, and open on it: the tab is the one marked, the
      // dashboard behind it is not.
      const tab = dashboardBar(page).getByRole('link', { name: 'All items' });
      await expect(tab).toBeVisible();
      await press(tab, isMobile);
      await expect(page).toHaveURL(/\/items$/);
      await expect(tab).toHaveClass(/(^|\s)active(\s|$)/);
      await expect(dashboardTab(page, 'Dashboard 1')).not.toHaveClass(/(^|\s)active(\s|$)/);
      const row = page.getByRole('row').filter({ hasText: finished });
      await expect(row).toContainText('Done');
      await expect(row).toContainText('Inbox');
      await expectNoSidewaysScroll(page);

      // A reload lands on the same table: the address and the remembered tab.
      await page.reload();
      await expect(row).toBeVisible();
      await expect(tab).toHaveClass(/(^|\s)active(\s|$)/);

      // Narrowed from the tab's funnel to what is finished: no row of another
      // status is left, and the finished one is.
      await press(tab.getByRole('button', { name: 'Filter All items' }), isMobile);
      await press(
        page.getByRole('group', { name: 'Status' }).getByRole('button', { name: 'Done', exact: true }),
        isMobile,
      );
      // A phone's filter is a sheet over the page, which hides the table from a
      // role query until it is closed - and closed before the funnel is reachable.
      if (isMobile) await closeTheFilterSheet(page);
      await expect(row).toBeVisible();
      await expect(page.getByRole('row').filter({ hasNotText: 'Done' })).toHaveCount(1); // the header
      await press(tab.getByRole('button', { name: 'Clear the filter and close it' }), isMobile);
      await expect(page.getByRole('group', { name: 'Status' })).toHaveCount(0);

      // The row opens its form, and the Status control reopens the item.
      await press(row.getByRole('button', { name: finished }), isMobile);
      await setFormStatus(page, 'to_do', isMobile);
      await press(page.getByRole('dialog').getByRole('button', { name: 'Save' }), isMobile);
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(row).toContainText('To do');

      // Then paged: sixty more items made through the API, since sixty captures
      // by hand is a minute spent on nothing this proves (that paging is by
      // count is apps/web/tests/unit/components/AllItemsBoard.test.tsx).
      const workspaceId = new URL(page.url()).pathname.split('/')[2]!;
      const known = await page.request.get('/v1/item-types');
      const [aType] = ((await known.json()) as { itemTypes: { id: string }[] }).itemTypes;
      for (let at = 0; at < 60; at += 1) {
        const sent = await page.request.post('/v1/commands/capture_item', {
          data: {
            commandId: randomUUID(),
            issuedAt: new Date().toISOString(),
            workspaceId,
            itemId: randomUUID(),
            message: uniqueTitle(`Entry ${at}`),
            typeId: aType!.id,
          },
        });
        expect(sent.ok(), `capturing from outside failed: ${sent.status()}`).toBe(true);
      }
      await page.reload();

      // The header row and fifty items, then the rest of the sixty-one.
      const rows = page.getByRole('row');
      await expect(rows).toHaveCount(51);
      await press(page.getByRole('button', { name: 'Show more' }), isMobile);
      await expect.poll(() => rows.count()).toBe(62);
    });
  });

  test.describe('an open filter bar stays in view, and opening it starts from the top', () => {
    /**
     * F3, because a pinned bar and a scroll position exist only where something
     * is laid out and scrolled, which jsdom does neither of. A short window keeps
     * the Panels needed to scroll it few. A Dashboard and All items share the
     * scrolling element, the bar and the funnel's press handler, so one walk
     * covers both rather than one each.
     */
    test('pins the bar under the dashboard bar, scrolls to the top only when it opens, and leaves a switch where it was', async ({
      page,
      isMobile,
    }) => {
      const workspace = uniqueTitle('Bookkeeping');
      await openFirstWorkspace(page, isMobile);
      await makeWorkspace(page, workspace, isMobile);
      await switchTo(page, workspace, isMobile);
      // **A phone folds the filter into a summary line and a sheet.** Folded into this walk
      // rather than walked apart, which the Dashboards ceiling leaves no room for: the same
      // funnel, bar and pinned row. It is F3 because what fits on one line is layout and a
      // swipe is a touch gesture. Which conditions the line names, in what order, and what
      // each tap stores is apps/web/tests/unit/components/DashboardBar.test.tsx's.
      if (isMobile) {
        await openDashboard(page, 'Dashboard 1', isMobile);
        await press(dashboardTab(page, 'Dashboard 1').getByRole('button', { name: 'Filter this dashboard' }), isMobile);
        const sheet = filterSheet(page);
        await expect(sheet).toBeVisible();
        // Every condition at once.
        const within = (group: string, name: string) =>
          press(sheet.getByRole('group', { name: group }).getByRole('button', { name, exact: true }), isMobile);
        await within('Status', 'To do');
        await within('Status', 'In progress');
        await within('Priority', 'High');
        await within('Priority', 'Normal');
        await within('Priority', 'Low');
        await sheet.getByRole('combobox').selectOption({ label: 'This week' });
        await sheet.getByRole('searchbox', { name: 'Containing' }).fill('invoice');
        await within('Attachments', 'With');
        await press(sheet.getByRole('button', { name: 'Agent running' }), isMobile);

        // **A swipe down on the handle closes it**, and keeps what was set.
        const box = (await sheet.boundingBox())!;
        const x = box.x + box.width / 2;
        const y = box.y + 12;
        const touch = await page.context().newCDPSession(page);
        const at = (type: 'touchStart' | 'touchMove' | 'touchEnd', dy: number) =>
          touch.send('Input.dispatchTouchEvent', {
            type,
            touchPoints: type === 'touchEnd' ? [] : [{ x, y: y + dy }],
          });
        await at('touchStart', 0);
        for (const dy of [30, 80, 140]) await at('touchMove', dy);
        await at('touchEnd', 140);
        await expect(sheet).toHaveCount(0);

        // **One row, and the rest as +n.** The line is as tall as one pill and
        // names where the others went.
        const line = page.getByRole('group', { name: 'Dashboard filter summary' });
        await expect(line).toBeVisible();
        await expect(line.getByText(/^\+\d+$/)).toBeVisible();
        const lineBox = (await line.boundingBox())!;
        const pill = (await line.getByText('To do', { exact: true }).boundingBox())!;
        expect(lineBox.height, 'the summary is one row tall').toBeLessThan(pill.height * 2.5);
        expect(lineBox.x + lineBox.width, 'and inside the screen').toBeLessThanOrEqual(page.viewportSize()!.width);
        await expectNoSidewaysScroll(page);

        // Kept across a reload, and cleared by its own ×.
        await page.reload();
        await expect(line).toBeVisible();
        await press(line.getByRole('button', { name: 'Clear the filter' }), isMobile);
        await expect(line).toHaveCount(0);
      }

      await page.setViewportSize({ width: page.viewportSize()!.width, height: 280 });

      const scroller = page.locator('[data-drag-scroll="dashboard"]');
      // A phone pins the one-line summary of a filter that is on; a desk pins the bar.
      const bar = isMobile
        ? page.getByRole('group', { name: 'Dashboard filter summary' })
        : page.getByRole('search', { name: 'Dashboard filter' });
      // The funnel opens the bar, or on a phone the sheet - where a filter is set
      // and the sheet closed, since the summary is what stays pinned.
      const openTheFilter = async (funnelButton: Locator) => {
        await press(funnelButton, isMobile);
        if (!isMobile) return;
        await press(filterSheet(page).getByRole('group', { name: 'Priority' }).getByRole('button', { name: 'High' }), isMobile);
        await closeTheFilterSheet(page);
      };
      const scrollTop = () => scroller.evaluate((el) => el.scrollTop);
      const reach = () => scroller.evaluate((el) => el.scrollHeight - el.clientHeight);
      const scrollDown = async (to: 'bottom' | number) => {
        await scroller.evaluate((el, at) => {
          el.scrollTop = at === 'bottom' ? el.scrollHeight : at;
        }, to);
        await expect.poll(scrollTop).toBeGreaterThan(0);
      };
      // Directly under the dashboard bar: flush with the top of the element that
      // scrolls, and wholly inside the window.
      const expectPinned = async () => {
        await expect(bar).toBeVisible();
        const barBox = (await bar.boundingBox())!;
        const scrollerBox = (await scroller.boundingBox())!;
        expect(Math.abs(barBox.y - scrollerBox.y), 'the bar sits at the top of the scroller').toBeLessThanOrEqual(8);
        expect(barBox.y + barBox.height).toBeLessThanOrEqual(page.viewportSize()!.height);
        const barOfDashboards = (await dashboardBar(page).boundingBox())!;
        expect(barBox.y).toBeGreaterThanOrEqual(barOfDashboards.y + barOfDashboards.height - 1);
      };
      const funnel = (name: string) =>
        dashboardTab(page, 'Dashboard 1').getByRole('button', { name });
      // **Setup is not the behaviour**, so it goes through the API in one go and
      // the page is read once: Panels to scroll through (a short window alone
      // does not hold a Dashboard taller than it once the bar closes and takes
      // its own height back), a second Dashboard with its own, and enough items
      // that All items is taller than the window.
      await openDashboard(page, 'Dashboard 1', isMobile);
      await chooseRowAction(page, 'Dashboard 1', 'Show all items', isMobile);
      const [, , workspaceId, , dashboardId] = new URL(page.url()).pathname.split('/');
      const known = await page.request.get('/v1/item-types');
      const [aType] = ((await known.json()) as { itemTypes: { id: string }[] }).itemTypes;
      const send = async (command: string, data: Record<string, unknown>) => {
        const sent = await page.request.post(`/v1/commands/${command}`, {
          data: { commandId: randomUUID(), issuedAt: new Date().toISOString(), workspaceId, ...data },
        });
        expect(sent.ok(), `${command} from outside failed: ${sent.status()} ${await sent.text()}`).toBe(true);
      };
      const other = uniqueTitle('Elsewhere');
      const otherId = randomUUID();
      await send('add_dashboard', { dashboardId: otherId, panelId: randomUUID(), name: other });
      // The Panels that give Dashboard 1 its height hold High items, because a
      // filter hides a Panel it leaves empty and a Dashboard of hidden Panels
      // has nothing to scroll.
      const tall = [0, 1, 2].map(() => ({
        panelId: randomUUID(),
        itemIds: Array.from({ length: 4 }, () => randomUUID()),
      }));
      await Promise.all([
        ...tall.map(({ panelId }, at) =>
          send('add_panel', { dashboardId: dashboardId!, panelId, name: `Extra ${at}` }),
        ),
        ...[0, 1].map((at) =>
          send('add_panel', { dashboardId: otherId, panelId: randomUUID(), name: `Other ${at}` }),
        ),
        ...tall.flatMap(({ itemIds }) =>
          itemIds.map((itemId) =>
            send('capture_item', {
              itemId,
              message: uniqueTitle('High'),
              typeId: aType!.id,
              priority: 'high',
            }),
          ),
        ),
        ...Array.from({ length: 12 }, (_, at) =>
          send('capture_item', {
            itemId: randomUUID(),
            message: uniqueTitle(`Entry ${at}`),
            typeId: aType!.id,
          }),
        ),
      ]);
      // One Panel's items go on in turn, since each names the order so far.
      await Promise.all(
        tall.map(async ({ panelId, itemIds }) => {
          for (let at = 0; at < itemIds.length; at += 1) {
            await send('add_item_to_panel', { itemId: itemIds[at]!, panelId, order: itemIds.slice(0, at + 1) });
          }
        }),
      );
      await page.reload();

      // **A Dashboard.**
      await expect.poll(reach).toBeGreaterThan(150);
      await scrollDown('bottom');
      await openTheFilter(funnel('Filter this dashboard'));
      await expect(bar).toBeVisible();
      await expect.poll(scrollTop, 'opening the bar goes to the top').toBe(0);

      await scrollDown('bottom');
      await expectPinned();

      // **Menus and windows draw above it.** The bar is only pinned usefully
      // if it never hides what opens over it. By selector, since a modal hides
      // what is behind it from role queries; paint order exists only in a real
      // layout, hence F3. Item-row submenus take their level from the same
      // `z-floating` the menus do, so they are not walked apart.
      // By selector, since an open menu hides the bar from role queries too.
      const drawn = page.locator(
        isMobile
          ? '[role="group"][aria-label="Dashboard filter summary"]'
          : '[role="search"][aria-label="Dashboard filter"]',
      );
      const filterButton = (await drawn.getByText('High', { exact: true }).boundingBox())!;
      if (!isMobile) {
        // A desk's: a phone has no Settings.
        await press(page.getByRole('button', { name: 'Profile' }), isMobile);
        const settings = page.getByRole('menuitem', { name: 'Settings…', exact: true });
        await expect(settings).toBeVisible();
        // The entry's foot is under the bar, and that foot is where it is
        // pressed: the walk means nothing unless the point really is inside it.
        const entry = (await settings.boundingBox())!;
        const barBox = (await drawn.boundingBox())!;
        const into = barBox.y + 3 - entry.y;
        expect(into, 'the entry starts above the bar').toBeGreaterThanOrEqual(0);
        expect(into, 'the point is inside the entry').toBeLessThan(entry.height);
        expect(entry.y + into, 'and inside the bar').toBeLessThan(barBox.y + barBox.height);
        expect(await drawnOnTopAt(page, entry.x + entry.width / 2, entry.y + into)).toEqual({
          inTheBar: false,
          role: 'menuitem',
        });
        await settings.click({ position: { x: entry.width / 2, y: into } });
        await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
      } else {
        await press(page.getByRole('button', { name: 'Add a dashboard' }), isMobile);
        await expect(page.getByRole('dialog')).toBeVisible();
      }
      // Whichever window is open, its dimming is what is on top where a filter
      // button is, so a press there is not a press on a filter.
      const top = await drawnOnTopAt(
        page,
        filterButton.x + filterButton.width / 2,
        filterButton.y + filterButton.height / 2,
      );
      expect(top.inTheBar, 'the bar is drawn over the dimming').toBe(false);
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog')).toHaveCount(0);

      // Filtered and scrolled: clearing closes the bar and goes nowhere. A phone
      // was filtered by opening the sheet above.
      if (!isMobile) await press(bar.getByRole('button', { name: 'High' }), isMobile);
      await scrollDown(200);
      await press(funnel('Clear the filter and close it'), isMobile);
      await expect(bar).toHaveCount(0);
      // Not zero: the bar's own height leaves with it and the Panels follow, but
      // nothing takes the Dashboard to its top.
      expect(await scrollTop(), 'closing does not scroll to the top').toBeGreaterThan(0);

      // **A switch to a filtered Dashboard.** The first is filtered again and
      // left; a second is scrolled down; the first's filled funnel comes back
      // to it without taking it to the top.
      await press(funnel('Filter this dashboard'), isMobile);
      if (isMobile) {
        await press(filterSheet(page).getByRole('group', { name: 'Priority' }).getByRole('button', { name: 'High' }), isMobile);
        await closeTheFilterSheet(page);
      } else {
        await press(bar.getByRole('button', { name: 'High' }), isMobile);
      }
      await press(dashboardTab(page, other), isMobile);
      await expect(page.getByRole('heading', { name: other, level: 2 })).toBeVisible();
      await expect.poll(reach).toBeGreaterThan(150);
      await scrollDown(100);
      await press(
        dashboardTab(page, 'Dashboard 1').getByRole('img', { name: 'This dashboard is filtered' }),
        isMobile,
      );
      await expect(page.getByRole('heading', { name: 'Dashboard 1', level: 2 })).toBeVisible();
      await expect(bar).toBeVisible();
      expect(await scrollTop(), 'a switch does not scroll').toBeGreaterThan(0);
      await press(funnel('Clear the filter and close it'), isMobile);

      // **All items.**
      const tab = dashboardBar(page).getByRole('link', { name: 'All items' });
      await press(tab, isMobile);
      await expect(page).toHaveURL(/\/items$/);
      await expect.poll(reach).toBeGreaterThan(150);
      await scrollDown('bottom');
      await openTheFilter(tab.getByRole('button', { name: 'Filter All items' }));
      await expect(bar).toBeVisible();
      await expect.poll(scrollTop, 'opening the bar goes to the top').toBe(0);
      await scrollDown('bottom');
      await expectPinned();
    });
  });
  test.describe('a Dashboard’s Panels are listed at its right, and a click brings one to the top', () => {
    /**
     * F3, because where a header lands is layout and a scroll position, which
     * jsdom has neither of; what the list holds, its controls and the key are
     * apps/web/tests/unit (components/PanelList, panelList, pages/Layout). One
     * walk: a Dashboard too tall for the window, the list open, then the key and
     * a reload.
     */
    test('scrolls a Panel’s header to the top, as far as the page allows for one too low, and keeps the list collapsed across a reload', async ({
      page,
      isMobile,
    }) => {
      const workspace = uniqueTitle('Bookkeeping');
      await openFirstWorkspace(page, isMobile);
      await makeWorkspace(page, workspace, isMobile);
      await switchTo(page, workspace, isMobile);
      await openDashboard(page, 'Dashboard 1', isMobile);
      const list = page.getByRole('complementary', { name: 'Panels' });
      const strip = page.getByRole('button', { name: 'Open the Panel list' });
      // A phone keeps collapse-and-jump, so there is nothing to walk.
      if (isMobile) {
        await expect(page.getByRole('region', { name: 'Panel 1' })).toBeVisible();
        await expect(list).toHaveCount(0);
        await expect(strip).toHaveCount(0);
        return;
      }

      const [, , workspaceId, , dashboardId] = new URL(page.url()).pathname.split('/');
      for (let at = 0; at < 9; at += 1) {
        const sent = await page.request.post('/v1/commands/add_panel', {
          data: {
            commandId: randomUUID(),
            issuedAt: new Date().toISOString(),
            workspaceId,
            dashboardId,
            panelId: randomUUID(),
            name: `Extra ${at}`,
          },
        });
        expect(sent.ok(), `add_panel from outside failed: ${sent.status()} ${await sent.text()}`).toBe(true);
      }
      await page.setViewportSize({ width: 1280, height: 520 });
      await page.reload();

      const scroller = page.locator('[data-drag-scroll="dashboard"]');
      const headerOf = (name: string) => page.getByRole('region', { name }).locator('header');
      const scrollTop = () => scroller.evaluate((el) => el.scrollTop);
      const reach = () => scroller.evaluate((el) => el.scrollHeight - el.clientHeight);
      const entry = (name: string) => list.getByRole('button', { name: new RegExp(`^${name}`) });
      await expect(list).toBeVisible();
      await expect(list.getByRole('heading', { name: 'Panels' })).toBeVisible();
      await expect(entry('Extra 8')).toBeVisible();
      await expect.poll(reach, 'the Dashboard is taller than the window').toBeGreaterThan(150);
      // The list takes its width from the Panels: it is beside the scroller, not over it.
      const listBox = (await list.boundingBox())!;
      const scrollerBox = (await scroller.boundingBox())!;
      expect(listBox.x).toBeGreaterThanOrEqual(scrollerBox.x + scrollerBox.width - 1);

      // **A Panel that can reach the top.**
      await press(entry('Extra 3'), isMobile);
      await expect
        .poll(async () => Math.abs((await headerOf('Extra 3').boundingBox())!.y - (await scroller.boundingBox())!.y))
        .toBeLessThan(2);
      await expectNoSidewaysScroll(page);

      // **One too low to**: as far as the page goes, and no further.
      await press(entry('Extra 8'), isMobile);
      await expect.poll(async () => (await reach()) - (await scrollTop())).toBeLessThan(2);
      expect((await headerOf('Extra 8').boundingBox())!.y, 'short of the top').toBeGreaterThan(scrollerBox.y + 2);
      await expectNoSidewaysScroll(page);

      // **P collapses it to the strip, and a reload keeps it so.**
      await page.keyboard.press('p');
      await expect(list).toHaveCount(0);
      await expect(strip).toBeVisible();
      await page.reload();
      await expect(strip).toBeVisible();
      await expect(list).toHaveCount(0);
      await press(strip, isMobile);
      await expect(list).toBeVisible();
    });
  });
});
