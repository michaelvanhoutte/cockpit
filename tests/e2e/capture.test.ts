import type { Page } from '@playwright/test';
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
 * apps/api/tests/contract/clean-up-a-note.v9.test.ts asks the real model
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
/**
 * A speech engine the walk can drive, installed before the app loads: the
 * browser's own has no working implementation in Playwright's Chromium, and is
 * a third party besides. `start()` only registers the session; the walk says
 * when it has started and what it heard, the way the engine does.
 */
async function installSpeechEngine(page: Page): Promise<void> {
  await page.addInitScript(() => {
    type Session = {
      onstart: (() => void) | null;
      onresult: ((event: unknown) => void) | null;
    };
    const holder = window as unknown as { __speech: { current: Session | null } };
    holder.__speech = { current: null };
    class FakeSpeechRecognition {
      onstart: (() => void) | null = null;
      onresult: ((event: unknown) => void) | null = null;
      start() {
        holder.__speech.current = this;
      }
      // Asked to stop, the real engine ends: what the Car view's second tap waits on.
      stop() {
        (this as { onend?: () => void }).onend?.();
      }
      abort() {}
    }
    // Both names: Chromium has a standard one of its own, which the app prefers.
    Object.assign(window, {
      SpeechRecognition: FakeSpeechRecognition,
      webkitSpeechRecognition: FakeSpeechRecognition,
    });
  });
}

/** The engine, as the walk's fake has it: listening once started, then hearing a phrase. */
async function engineHears(page: Page, phrase: string): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => (window as never as { __speech: { current: unknown } }).__speech.current !== null))
    .toBe(true);
  await page.evaluate((said) => {
    const engine = (window as never as { __speech: { current: Record<string, (event?: unknown) => void> } })
      .__speech.current;
    engine.onstart!();
    engine.onresult!({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: said } }] });
  }, phrase);
  // The next session is a new one: a walk that dictates twice waits for the second.
  await page.evaluate(() => {
    (window as never as { __speech: { current: unknown } }).__speech.current = null;
  });
}

test.describe('Capture', () => {
  test.describe('a captured thought appears in the inbox, on a phone screen as on a desktop', () => {
    test('lists the thought to process, reachable without scrolling sideways', async ({
      page,
      isMobile,
    }) => {
      await installSpeechEngine(page);
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

      // The same box, spoken into: the mic sits in the strip under the note,
      // reachable on this screen, and what is heard lands in the note and is
      // captured like anything typed. Only a browser proves it reaches an Item.
      const mic = page.getByRole('button', { name: 'Dictate' });
      await expect(mic).toBeInViewport();
      await expectNoSidewaysScroll(page);
      await press(mic, isMobile);
      const spoken = uniqueTitle('Water the plants');
      await engineHears(page, spoken);
      await expect(mic).toHaveAttribute('aria-pressed', 'true');
      await expect(captureBox(page)).toHaveValue(spoken);
      await press(page.getByRole('button', { name: 'Capture' }), isMobile);
      await expect(page.getByRole('region', { name: 'Just captured' }).getByText(spoken)).toBeVisible();
      await closeCapture(page, isMobile);

      await expect(itemRow(page, thought)).toBeVisible();
      await expect(inbox(page).getByText(thought)).toBeVisible();
      await expect(itemRow(page, spoken)).toBeVisible();
      await expectNoSidewaysScroll(page);

      // The Car view of the same page: one round button, tapped to listen and
      // tapped again to capture, with nothing to read in between. Reached by the
      // address, because at a desk the Capture tab opens a window with no switch,
      // and only a browser proves what it captures reaches the Inbox.
      await page.goto('/capture');
      await press(page.getByRole('link', { name: 'Car' }), isMobile);
      const drive = page.getByRole('button', { name: 'Speak a note' });
      await expect(drive).toBeInViewport();
      await expectNoSidewaysScroll(page);
      await press(drive, isMobile);
      const driven = uniqueTitle('Book the car service');
      await engineHears(page, driven);
      await expect(page.getByText('Listening — tap to capture')).toBeVisible();
      await press(page.getByRole('button', { name: 'Capture', exact: true }), isMobile);
      await expect(page.getByText('Captured', { exact: true })).toBeVisible();
      await openInbox(page, isMobile);
      await expect(itemRow(page, driven)).toBeVisible();
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
