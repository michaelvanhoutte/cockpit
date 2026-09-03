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

/**
 * F3, because an undo is a thing that appears, is pressed, and goes: what the
 * bar offers and when it stops offering it is settled without a browser in
 * apps/web/tests/unit/undo.test.tsx, and which change is sent in
 * apps/web/tests/unit/components/ItemRow.test.tsx. What is only true here is
 * that the offer is reachable from the row the change was made on, and that the
 * item really comes back.
 *
 * Both projects, for the reason dismissing is walked on both: a bar pinned to
 * the bottom of the screen is where a phone's own controls are.
 */
test.describe('Triage', () => {
  test.describe('what just happened can be put back, until the offer runs out', () => {
    test('brings back an item dismissed by mistake', async ({ page, isMobile }) => {
      await openInbox(page, isMobile);
      const thought = uniqueTitle('Dismissed by mistake');
      await capture(page, thought, isMobile);

      await press(itemRow(page, thought).getByRole('button', { name: 'Item actions' }), isMobile);
      await press(page.getByRole('menuitem', { name: 'Dismiss' }), isMobile);
      await expect(itemRow(page, thought)).toHaveCount(0);

      const offer = page.getByRole('status');
      await expect(offer).toContainText(thought);
      await press(offer.getByRole('button', { name: 'Undo' }), isMobile);

      // Back in the Inbox, with the status it had — and the offer gone, because
      // an undo cannot itself be undone.
      await expect(itemRow(page, thought)).toBeVisible();
      await expect(itemRow(page, thought).getByText('To process')).toBeVisible();
      await expect(offer).toHaveCount(0);
    });
  });
});
