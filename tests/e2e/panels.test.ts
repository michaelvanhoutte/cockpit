import { type Page } from '@playwright/test';
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
  await press(page.getByRole('button', { name: 'Add a panel' }), isMobile);
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
 * Opens the layouts menu, waits for one entry per layout plus the automatic
 * one, and closes it again - which is also how this walk waits for a layout to
 * have landed, since the menu is the only place the dashboard says how many it
 * has.
 */
async function expectLayouts(page: Page, made: number, isMobile: boolean): Promise<void> {
  await press(page.getByRole('button', { name: 'Layouts' }), isMobile);
  // One entry per layout, plus the automatic choice at the top.
  await expect(page.getByRole('menuitemradio')).toHaveCount(made + 1);
  await expect(page.getByText('in use')).toHaveCount(1);
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
      // the same two gestures every row of a settings page takes.
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
    test('never scrolls sideways, and asks which layout a change on another screen belongs to', async ({
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

      // Arranged for the screen it is on now, which stores the dashboard's
      // first layout - there is nothing to choose between, so nothing is asked.
      await press(page.getByRole('button', { name: 'Fit to this screen' }), isMobile);
      await expect(page.getByText(/Keep the change where\?/)).toHaveCount(0);
      // Waited for by name rather than by a pause: the layout is what the next
      // half of this walk changes *from*, and pressing again before it landed
      // would be a change made against a dashboard that still had no layout -
      // which is a different rule, and not the one under test here.
      await expectLayouts(page, 1, isMobile);
      await expectNoSidewaysScroll(page);
      await expectTheDashboardFits(page);

      // A different screen. The layout stored a moment ago was made for the
      // other one, so it is squeezed to fit rather than cut off - which is what
      // the sideways-scroll check is really asserting.
      const wasWide = page.viewportSize()!.width > 700;
      await page.setViewportSize({ width: wasWide ? 420 : 1100, height: 800 });
      await expect.poll(() => panelsOnScreen(page)).toEqual([first, second, third]);
      await expectNoSidewaysScroll(page);
      await expectTheDashboardFits(page);

      // And a change made here is a change on a screen the layout was not made
      // for, so it asks rather than quietly rewriting the other one.
      await press(page.getByRole('button', { name: 'Fit to this screen' }), isMobile);
      await expect(page.getByText(/Keep the change where\?/)).toBeVisible();
      await press(page.getByRole('button', { name: 'Make a layout for this screen' }), isMobile);

      // Two layouts now, one per screen, and the one made for this screen is
      // the one being drawn with.
      await expectLayouts(page, 2, isMobile);
      await expectNoSidewaysScroll(page);
      await expectTheDashboardFits(page);
    });
  });

  test.describe('a panel goes where you drag it and takes the size you drag it to', () => {
    // Desktop only, and the reason is the gesture rather than the screen: the
    // browser's own drag-and-drop is a mouse protocol, so dragging a panel
    // cannot happen on a touchscreen at all - moving there is the entry in the
    // panel's own menu, which the walk above drives on both projects.
    // Resizing has no such entry: the grip is drawn everywhere and a touch drag
    // does work it, but a corner that size is a target no thumb wants, so what
    // the gesture is worth on a phone is not what this walk is for.
    test.skip(({ isMobile }) => !!isMobile, 'these two are pointer gestures');

    test('takes the size the corner was dragged to, and still has it after a reload', async ({
      page,
      isMobile,
    }) => {
      await ownDashboard(page, isMobile);
      const falcon = uniqueTitle('Project Falcon');
      await addPanel(page, falcon, isMobile);
      // Arranged first, so the drag happens on a dashboard that already has a
      // layout - which is the case a resize can be dropped in, and the one a
      // freshly made dashboard does not reach.
      await press(page.getByRole('button', { name: 'Fit to this screen' }), isMobile);
      await expectLayouts(page, 1, isMobile);
      const panel = page.getByRole('region', { name: falcon });
      const before = (await panel.boundingBox())!;

      // The corner, dragged to the right: pointer events rather than the
      // browser's drag protocol, which is why this is a mouse press and a move
      // rather than `dragTo`.
      const grip = page.locator(`[data-resize-grip="${falcon}"]`);
      const corner = (await grip.boundingBox())!;
      await page.mouse.move(corner.x + corner.width / 2, corner.y + corner.height / 2);
      await page.mouse.down();
      await page.mouse.move(corner.x + 260, corner.y + corner.height / 2, { steps: 8 });
      await page.mouse.up();

      await expect.poll(async () => (await panel.boundingBox())!.width).toBeGreaterThan(
        before.width + 100,
      );
      await expectNoSidewaysScroll(page);
      await expectTheDashboardFits(page);

      // Reloaded, because a resize that is only drawn survives every check on
      // the screen it was made on and is gone the next time the dashboard is
      // opened - which is the way it goes wrong, silently and later.
      await page.reload();
      await expect(panel).toBeVisible();
      await expect.poll(async () => (await panel.boundingBox())!.width).toBeGreaterThan(
        before.width + 100,
      );
    });

    test('moves it past the panel it was dropped on', async ({ page, isMobile }) => {
      await ownDashboard(page, isMobile);
      const first = uniqueTitle('Project Falcon');
      const second = uniqueTitle('To read');
      await addPanel(page, first, isMobile);
      await addPanel(page, second, isMobile);

      // The header is the handle; the panel is the target.
      await page
        .getByRole('region', { name: second })
        .locator('header')
        .dragTo(page.getByRole('region', { name: first }));

      await expect.poll(() => panelsOnScreen(page)).toEqual([second, first]);
      await expectNoSidewaysScroll(page);
      await expectTheDashboardFits(page);
    });
  });
});
