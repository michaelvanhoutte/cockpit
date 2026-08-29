import { expect, test } from '@playwright/test';
import {
  captureBox,
  expectNoSidewaysScroll,
  itemRow,
  openFirstWorkspace,
  panel,
  press,
  uniqueTitle,
} from './support/app';

/**
 * F3, because the capture control is reached by a tap on a 480px screen and by
 * a mouse on a 1280px one, and neither the viewport nor the touch event path
 * exists below a real browser — jsdom, where the F1 tests run, has no layout
 * engine at all. It is not re-proving CaptureForm's logic, which
 * apps/web/tests/unit/components/CaptureForm.test.tsx already owns; it proves
 * the whole thing is tied together and usable on the device in hand.
 */
test.describe('Capture', () => {
  test.describe('a captured thought appears in the inbox, on a phone screen as on a desktop', () => {
    test('lists the thought to process, reachable without scrolling sideways', async ({
      page,
      isMobile,
    }) => {
      await openFirstWorkspace(page);
      await expectNoSidewaysScroll(page);

      // Reachable, not merely present: an element rendered off the edge of a
      // phone satisfies toBeVisible and is still unusable.
      await expect(captureBox(page)).toBeInViewport();

      const thought = uniqueTitle('Buy milk');
      await captureBox(page).fill(thought);
      await press(page.getByRole('button', { name: 'Capture' }), isMobile);

      await expect(itemRow(page, thought)).toBeVisible();
      await expect(panel(page, 'Inbox').getByText(thought)).toBeVisible();
      await expect(captureBox(page)).toHaveValue('');
      await expectNoSidewaysScroll(page);
    });
  });
});
