import { expect, test } from '@playwright/test';
import { capture, itemRow, openInbox, press, swipeRow, uniqueTitle } from './support/app';

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

      // Back in the Inbox, and the offer gone, because an undo cannot itself be
      // undone. There is nothing else to check it came back as: undoing a
      // dismissal is the same change with the flag turned round, so there is no
      // previous state that could be put back wrongly ("An item is either yours
      // to deal with or finished with", issue 154).
      await expect(itemRow(page, thought)).toBeVisible();
      await expect(offer).toHaveCount(0);
    });
  });
});

/**
 * F3, and only under the phone project: a swipe is a touch gesture and the
 * desktop project has no touch at all. What the rules are is
 * apps/web/tests/unit/swipe.test.ts, and that the handlers hand their numbers
 * to them is apps/web/tests/unit/components/ItemRow.test.tsx. What is only true
 * here is that a real finger, against a real `touch-action` and a real list that
 * scrolls under the same thumb, reaches them.
 */
test.describe('Triage', () => {
  test.describe('a swipe that acts sends its change; one that stops short puts the row back', () => {
    test('dismisses on a swipe left, and offers it back', async ({ page, isMobile }) => {
      test.skip(!isMobile, 'a swipe is a touch gesture, and this project has no touch');
      await openInbox(page, isMobile);
      const thought = uniqueTitle('Swiped away');
      await capture(page, thought, isMobile);

      await swipeRow(page, thought, -160);

      await expect(itemRow(page, thought)).toHaveCount(0);
      // The same way back the menu's Dismiss offers, because it is the same
      // change ("Undo what just happened", issue 144).
      await expect(page.getByRole('status')).toContainText(thought);
    });

    test('opens the picker for that row on a swipe right', async ({ page, isMobile }) => {
      test.skip(!isMobile, 'a swipe is a touch gesture, and this project has no touch');
      await openInbox(page, isMobile);
      const thought = uniqueTitle('Swiped into a panel');
      await capture(page, thought, isMobile);

      await swipeRow(page, thought, 160);

      // The same picker Move to… opens, and open on the row that was swiped, so
      // filing is one gesture on a phone and the same question either way. What
      // choosing a panel in it then does is the filing walk's own claim
      // (tests/e2e/filing.test.ts), not this one's.
      const picker = page.getByRole('dialog');
      await expect(picker).toBeVisible();
      await expect(picker).toContainText(thought);
      // And it is the whole picker, not a stub of one: the Inbox and this
      // workspace's dashboards, the same as from the menu.
      await expect(picker.getByRole('button', { name: /^Inbox/ })).toBeVisible();
    });

    test('leaves the row alone when the swipe stops short', async ({ page, isMobile }) => {
      test.skip(!isMobile, 'a swipe is a touch gesture, and this project has no touch');
      await openInbox(page, isMobile);
      const thought = uniqueTitle('Barely moved');
      await capture(page, thought, isMobile);

      await swipeRow(page, thought, -30);

      await expect(itemRow(page, thought)).toBeVisible();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(page.getByRole('status')).toHaveCount(0);
    });
  });
});
