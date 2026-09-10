import {
  capture,
  captureBox,
  dashboardBar,
  expect,
  expectNoSidewaysScroll,
  expectNothingSpillsOutOfTheInbox,
  inbox,
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
      // one more row in the workspaces window every later spec in the run then
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
      const tooLong = uniqueTitle('A title far longer than this column is ever going to be');
      await capture(page, tooLong, isMobile);
      await expectNothingSpillsOutOfTheInbox(page);

      // And, being cut, it spells the whole thing out on hover. This case and
      // no other: what only a real browser can say is that the text is cut at
      // this width at all. Which answer a given pair of widths deserves, and
      // that a label drawn whole is left alone, are decided a level down
      // (apps/web/tests/unit/cutOff.test.ts and
      // apps/web/tests/unit/components/ItemRow.test.tsx).
      const cutLabel = inbox(page).getByText(tooLong);
      await cutLabel.hover();
      await expect(cutLabel).toHaveAttribute('title', tooLong);
      // Not one of the views to switch between any more: it is not somewhere
      // you go, it is somewhere you are.
      await expect(dashboardBar(page).getByRole('link', { name: 'Inbox' })).toHaveCount(0);

      // Gone from the screen reached without a workspace, which has no Inbox
      // to show. Capture is that screen: it is deliberately in no workspace
      // ("Capture something before you know which workspace it belongs to",
      // issue 165).
      await press(page.locator('header a[href="/capture"]'), isMobile);
      await expect(page.getByRole('heading', { name: 'Capture' })).toBeVisible();
      await expect(column).toHaveCount(0);
    });
  });

  /**
   * F3, for the same reason as the walk above: this is a claim about real
   * pixels. The clamp itself is pure and proved on its own in
   * apps/web/tests/unit/inboxWidth.test.ts; that the band above the column
   * mirrors whatever width it settles on is proved without a browser, on the
   * same render, in apps/web/tests/unit/router.test.tsx - two elements
   * reading one JS value is not a fact a real browser adds anything to.
   */
  test.describe('the Inbox column can be resized past its automatic width', () => {
    // A pointer gesture, the same reason moving and resizing a panel are
    // desktop-only in tests/e2e/panels.test.ts - and there is no column to
    // resize below the breakpoint in the first place.
    test.skip(({ isMobile }) => !!isMobile, 'resizing the column is a pointer gesture');

    test('drags to a chosen width, clamped to half the row, and remembers it - or its reset - across a reload', async ({
      page,
      isMobile,
    }) => {
      await openFirstWorkspace(page, isMobile);
      const column = inbox(page);
      const handle = page.getByRole('separator', { name: /drag to resize the inbox/i });
      const before = (await column.boundingBox())!;
      const grip = (await handle.boundingBox())!;
      const full = page.viewportSize()!;

      // Dragged almost to the far edge of the screen, so the drag lands on
      // the full window's own ceiling regardless of exactly how far the
      // pointer travelled - the ceiling, not the pointer, is under test here.
      await page.mouse.move(grip.x + grip.width / 2, before.y + before.height / 2);
      await page.mouse.down();
      await page.mouse.move(full.width - 40, before.y + before.height / 2, { steps: 8 });
      await page.mouse.up();

      const dragged = (await column.boundingBox())!;
      expect(dragged.width, 'the drag widened the column by well over 150px').toBeGreaterThan(
        before.width + 150,
      );
      await expectNoSidewaysScroll(page);

      // The choice survives a reload.
      await page.reload();
      const reopened = (await inbox(page).boundingBox())!;
      expect(Math.round(reopened.width)).toBe(Math.round(dragged.width));

      // A window too narrow to hold it clamps what is drawn without losing
      // the choice - widened back, the same width comes back rather than the
      // narrow window's own clamp of it. Half the full window is already most
      // of what a 1280px-wide default has to spare, so a deliberately much
      // narrower window is what actually exercises the clamp rather than
      // landing near the same ceiling by coincidence.
      await page.setViewportSize({ width: 800, height: full.height });
      const clamped = (await inbox(page).boundingBox())!;
      expect(clamped.width, 'clamped to at most half the narrower row').toBeLessThan(
        dragged.width - 100,
      );
      await expectNoSidewaysScroll(page);

      await page.setViewportSize(full);
      const restored = (await inbox(page).boundingBox())!;
      expect(Math.round(restored.width)).toBe(Math.round(dragged.width));

      // Double-clicking the handle resets it, and the reset is what a reload
      // remembers now - not the dragged width any more.
      await page.getByRole('separator', { name: /drag to resize the inbox/i }).dblclick();
      const reset = (await inbox(page).boundingBox())!;
      expect(reset.width).toBeLessThan(dragged.width);

      await page.reload();
      const afterReset = (await inbox(page).boundingBox())!;
      expect(Math.round(afterReset.width)).toBe(Math.round(reset.width));
    });
  });
});
