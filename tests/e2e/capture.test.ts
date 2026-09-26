import {
  captureBox,
  closeCapture,
  expect,
  expectNoSidewaysScroll,
  inbox,
  itemRow,
  openCapture,
  openInbox,
  press,
  test,
  uniqueTitle,
} from './support/app';

/**
 * F3, because the capture control is reached by a tap on a 480px screen and by
 * a mouse on a 1280px one, and neither the viewport nor the touch event path
 * exists below a real browser — jsdom, where the F1 tests run, has no layout
 * engine at all. It is not re-proving the form's logic, which
 * apps/web/tests/unit/components/CaptureNote.test.tsx already owns; it proves
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
 * apps/api/tests/contract/clean-up-a-note.v8.test.ts asks the real model
 * nightly.
 *
 * **The row's mark and the form's picker for the other readings have no walk
 * here either, and for a sharper reason** ("Offer the other readings when a
 * captured note says two things", issue 297): unlike a plain cleanup, there is
 * no door open to this suite at all for putting an item into the one state
 * that draws them. `propose_item_texts` is the only writer of a reading and
 * is deliberately not a route a browser can reach
 * (apps/api/tests/integration/http/note-cleanup.test.ts, "the reading is
 * Cockpit's to do"), so arranging the precondition means either a real,
 * non-deterministic model call - the cost already rejected above - or a
 * network fake, which this stack has no seam for: a Playwright walk drives a
 * deployed-shaped Worker, not one with `fetch` replaced under it the way
 * `note-cleanup.test.ts` runs in-process. What holds this instead:
 * apps/web/tests/unit/components/ItemRow.test.tsx and
 * apps/web/tests/unit/components/ItemForm.test.tsx prove the mark and the
 * picker against a stored item shaped either way, and the shape itself -
 * whether a note is genuinely read as ambiguous - is the contract tier's
 * question, above.
 */
test.describe('Capture', () => {
  test.describe('a captured thought appears in the inbox, on a phone screen as on a desktop', () => {
    test('lists the thought to process, reachable without scrolling sideways', async ({
      page,
      isMobile,
    }) => {
      await openInbox(page, isMobile);
      await expectNoSidewaysScroll(page);
      // No note box in the Inbox: the header's Capture tab is the only way in
      // ("Capture over the screen you are on, and open it with C", issue 536).
      await expect(captureBox(page)).toHaveCount(0);

      await openCapture(page, isMobile);
      // Reachable, not merely present: an element rendered off the edge of a
      // phone satisfies toBeVisible and is still unusable.
      await expect(captureBox(page)).toBeInViewport();
      await expectNoSidewaysScroll(page);

      const thought = uniqueTitle('Buy milk');
      await captureBox(page).fill(thought);
      await press(page.getByRole('button', { name: 'Capture' }), isMobile);
      await expect(page.getByRole('region', { name: 'Just captured' }).getByText(thought)).toBeVisible();
      await closeCapture(page, isMobile);

      await expect(itemRow(page, thought)).toBeVisible();
      await expect(inbox(page).getByText(thought)).toBeVisible();
      await expectNoSidewaysScroll(page);
    });
  });

  test.describe('capturing a thought shows it in the inbox as a thought', () => {
    test('says what kind of thing it is on its own row', async ({ page, isMobile }) => {
      await openInbox(page, isMobile);
      await openCapture(page, isMobile);

      // Chosen from the types the account has, which is all this row offers -
      // one is made in the window they are managed in ("Make a type where types
      // are managed, not while capturing", issue 203), and that walk is
      // tests/e2e/item-types.test.ts.
      // One of the two every account starts with ("Call the two standard types
      // Task and Note", issue 194) rather than a name this walk invents:
      // capture chooses among the types there are.
      const kind = page.getByRole('group', { name: 'Type' }).getByRole('button', { name: 'Note' });
      await expect(kind).toBeInViewport();

      const thought = uniqueTitle('Maybe split the pricing page');
      await captureBox(page).fill(thought);
      await press(kind, isMobile);
      await press(page.getByRole('button', { name: 'Capture' }), isMobile);
      await expect(page.getByRole('region', { name: 'Just captured' }).getByText(thought)).toBeVisible();
      await closeCapture(page, isMobile);

      // The word under the title, which is one of the two marks the type took
      // from the status ("Capture a thought or an action, and see which it
      // is", issue 155).
      await expect(itemRow(page, thought).getByText('Note')).toBeVisible();
      await expectNoSidewaysScroll(page);
    });
  });
});
