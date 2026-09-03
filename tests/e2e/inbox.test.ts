import {
  capture,
  captureBox,
  dashboardBar,
  expect,
  expectNoSidewaysScroll,
  expectNothingSpillsOutOfTheInbox,
  openFirstWorkspace,
  press,
  test,
  uniqueTitle,
} from './support/app';

/**
 * F3, and it can be nowhere else: this is a claim about how much room a screen
 * has and what fits in it. jsdom has no layout engine and reports every width
 * as zero, so the level below can prove which shape the app *chose* - which it
 * does, in apps/web/tests/unit/router.test.tsx - and nothing about whether the
 * two columns actually fit beside each other.
 *
 * One walk, under both projects, because the answer is meant to differ by
 * device: 1280px has room for the Inbox beside the dashboards, 480px does not.
 */
test.describe('Triage', () => {
  test.describe('the Inbox is beside the dashboards where there is room, and a view of its own where there is not', () => {
    test('fits both on the screen they share, without scrolling sideways', async ({
      page,
      isMobile,
    }) => {
      // The workspace that is already there, deliberately: this walk only
      // looks, so it needs no workspace of its own - and one more workspace is
      // one more row on the settings page every later spec in the run then
      // pays for.
      await openFirstWorkspace(page, isMobile);

      const column = page.getByRole('complementary', { name: 'Inbox' });
      // The tab you are on, not the dashboard's heading. The heading was the
      // anchor until the name stopped being drawn twice - once in the tab and
      // again over the board a centimetre below it ("Modernise the app shell",
      // issue 125) - and a heading only a screen reader can reach is in no
      // viewport. The tab is the visible thing that says which dashboard this
      // is, and it sits in the dashboard's own column, so it answers the same
      // question this walk was asking.
      const dashboard = dashboardBar(page).getByRole('link', { name: 'Dashboard 1' });

      if (isMobile) {
        // No room for a column, so the Inbox is what it was: a tab at the left
        // of the bar, opening a screen of its own.
        await expect(column).toHaveCount(0);
        const tab = dashboardBar(page).getByRole('link', { name: 'Inbox' });
        await expect(tab).toBeVisible();
        await press(tab, isMobile);
        await expect(captureBox(page)).toBeInViewport();
        await expectNoSidewaysScroll(page);
        return;
      }

      // Room for both, so both are on the screen at once - the dashboard the
      // workspace opened on, and the Inbox beside it - and neither pushed the
      // other off.
      await expect(column).toBeInViewport();
      await expect(captureBox(page)).toBeInViewport();
      await expect(dashboard).toBeInViewport();
      await expectNoSidewaysScroll(page);

      // And nothing inside the column spills out of it, with an item in it
      // whose title is far longer than the column is wide. The page-level
      // check above cannot see this: the column scrolls inside itself.
      await capture(page, uniqueTitle('A title far longer than this column is ever going to be'), isMobile);
      await expectNothingSpillsOutOfTheInbox(page);
      // Not one of the views to switch between any more: it is not somewhere
      // you go, it is somewhere you are.
      await expect(dashboardBar(page).getByRole('link', { name: 'Inbox' })).toHaveCount(0);

      // Still there on the page the dashboards are managed from, which is
      // inside the workspace too.
      await press(dashboardBar(page).getByRole('button', { name: 'Dashboard actions' }), isMobile);
      await press(page.getByRole('menuitem', { name: 'Manage dashboards' }), isMobile);
      await expect(page.getByRole('heading', { name: 'Dashboards' })).toBeVisible();
      await expect(column).toBeInViewport();
      await expectNoSidewaysScroll(page);

      // And gone from the page reached without a workspace, which has no Inbox
      // to show.
      await press(page.getByRole('button', { name: 'Settings' }), isMobile);
      await press(page.getByRole('menuitem', { name: 'Workspaces' }), isMobile);
      await expect(page.getByLabel('Name of the new workspace')).toBeVisible();
      await expect(column).toHaveCount(0);
    });
  });
});
