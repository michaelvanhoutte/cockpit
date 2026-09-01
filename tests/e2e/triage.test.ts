import { expect, test } from '@playwright/test';
import { capture, itemRow, openInbox, press, uniqueTitle } from './support/app';

/**
 * F3, and specifically on both projects, because the way this action is
 * reached differs by device: the menu opens under a mouse on the desktop and
 * under a finger on the phone, and a control that only answers to hover or to
 * a pointer event the phone never sends is unreachable in a way no test below
 * a real browser can see.
 *
 * What it does not do is re-prove what dismissing means. That an item is kept
 * rather than erased, and left out of the workspace's open items, is settled in
 * apps/api's tests against the real database; here the only question is
 * whether a person can actually do it.
 */
test.describe('Triage', () => {
  test.describe('dismissing an item takes it out of the inbox, by touch as by mouse', () => {
    test('leaves the inbox once dismissed', async ({ page, isMobile }) => {
      await openInbox(page, isMobile);
      const thought = uniqueTitle('Ignore me');
      await capture(page, thought, isMobile);

      await press(itemRow(page, thought).getByRole('button', { name: 'Item actions' }), isMobile);
      await press(page.getByRole('menuitem', { name: 'Dismiss' }), isMobile);

      await expect(itemRow(page, thought)).toHaveCount(0);
    });
  });
});
