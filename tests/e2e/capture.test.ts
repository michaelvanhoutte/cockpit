import {
  captureBox,
  expect,
  expectNoSidewaysScroll,
  inbox,
  itemRow,
  openInbox,
  press,
  test,
  uniqueTitle,
} from './support/app';

/**
 * F3, because the capture control is reached by a tap on a 480px screen and by
 * a mouse on a 1280px one, and neither the viewport nor the touch event path
 * exists below a real browser — jsdom, where the F1 tests run, has no layout
 * engine at all. It is not re-proving CaptureForm's logic, which
 * apps/web/tests/unit/components/CaptureForm.test.tsx already owns; it proves
 * the whole thing is tied together and usable on the device in hand.
 *
 * **A note being cleaned up after it is captured has no walk here, on purpose**
 * ("Clean up a captured note into a clear title and a fuller message", issue
 * 296). It changed no frontend code and adds no gesture: what a person sees is
 * the row's own text changing a few seconds later, which is the Live updates
 * path that already has coverage. Reaching it would mean either a real model
 * call on every CI run - money, and an answer that differs every time - or a
 * fake, which would prove the walk and nothing about the feature. What holds it
 * instead: apps/api/tests/integration/http/note-cleanup.test.ts drives a real
 * capture through the real queue to the real consumer, and
 * apps/api/tests/contract/clean-up-a-note.test.ts asks the real model nightly.
 */
test.describe('Capture', () => {
  test.describe('a captured thought appears in the inbox, on a phone screen as on a desktop', () => {
    test('lists the thought to process, reachable without scrolling sideways', async ({
      page,
      isMobile,
    }) => {
      await openInbox(page, isMobile);
      await expectNoSidewaysScroll(page);

      // Reachable, not merely present: an element rendered off the edge of a
      // phone satisfies toBeVisible and is still unusable.
      await expect(captureBox(page)).toBeInViewport();

      const thought = uniqueTitle('Buy milk');
      await captureBox(page).fill(thought);
      await press(inbox(page).getByRole('button', { name: 'Capture' }), isMobile);

      await expect(itemRow(page, thought)).toBeVisible();
      await expect(inbox(page).getByText(thought)).toBeVisible();
      await expectNoSidewaysScroll(page);
    });
  });

  test.describe('capturing a thought shows it in the inbox as a thought', () => {
    test('says what kind of thing it is on its own row', async ({ page, isMobile }) => {
      await openInbox(page, isMobile);

      const kind = page.getByLabel('What kind of thing this is');
      await expect(kind).toBeInViewport();

      const thought = uniqueTitle('Maybe split the pricing page');
      await captureBox(page).fill(thought);
      // Chosen from the types the account has, which is all this row offers -
      // one is made in the window they are managed in ("Make a type where types
      // are managed, not while capturing", issue 203), and that walk is
      // tests/e2e/item-types.test.ts.
      // One of the two every account starts with ("Call the two standard types
      // Task and Note", issue 194) rather than a name this walk invents:
      // capture chooses among the types there are.
      await kind.selectOption({ label: 'Note' });
      await press(inbox(page).getByRole('button', { name: 'Capture' }), isMobile);

      // The word under the title, which is one of the two marks the type took
      // from the status ("Capture a thought or an action, and see which it
      // is", issue 155).
      await expect(itemRow(page, thought).getByText('Note')).toBeVisible();
      await expectNoSidewaysScroll(page);
    });
  });
});
