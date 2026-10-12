import { SHARE_HOLDING_DATABASE, SHARE_HOLDING_STORE } from '@cockpit/shared';
import {
  captureBox,
  closeCapture,
  expect,
  expectNoSidewaysScroll,
  inbox,
  itemRow,
  openCapture,
  openInbox,
  openTheFiles,
  press,
  test,
  uniqueTitle,
} from './support/app';

/** A minimal, valid 1x1 PNG. */
const A_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

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
 * apps/api/tests/contract/clean-up-a-note.v11.test.ts asks the real model
 * whenever the prompt changes.
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
 * A microphone the walk can record from: Chromium's fake device, which answers
 * `getUserMedia` with a generated tone and needs no prompt answered, so
 * Write's `MediaRecorder` records real audio. The Worker this walk talks to
 * answers any recording with fixed words (`TRANSCRIPTION_STAND_IN`,
 * scripts/e2e-stack.mjs), so what it proves is the whole path from a tap to an
 * Item, not what Whisper makes of a voice - that is the contract tier's.
 */
test.use({
  permissions: ['microphone'],
  launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] },
});

/** What the stand-in transcriber answers, whatever it was given (apps/api/src/transcription/index.ts). */
const STAND_IN_WORDS = 'This is the stand-in transcription.';

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

      // The same box, spoken into: the mic sits in the strip under the note,
      // reachable on this screen. Tapped, it records with a running timer;
      // tapped again, the recording is transcribed and the words land at the
      // end of what was typed, to be captured like anything typed. Only a
      // browser records, and only a browser proves it reaches an Item.
      const mic = page.getByRole('button', { name: 'Dictate' });
      await expect(mic).toBeInViewport();
      await expectNoSidewaysScroll(page);
      const typed = uniqueTitle('Water');
      await captureBox(page).fill(typed);
      await press(mic, isMobile);
      await expect(mic).toHaveAttribute('aria-pressed', 'true');
      // A second in, so there is sound kept to send: a recording stopped the moment it starts can be empty.
      await expect(page.getByText('Listening · 0:01')).toBeVisible();
      await press(mic, isMobile);
      await expect(captureBox(page)).toHaveValue(`${typed} ${STAND_IN_WORDS}`);
      await expect(mic).toHaveAttribute('aria-pressed', 'false');
      await expect(page.getByText('Transcribing…')).toHaveCount(0);
      await press(page.getByRole('button', { name: 'Capture' }), isMobile);
      await expect(page.getByRole('region', { name: 'Just captured' }).getByText(typed)).toBeVisible();
      await closeCapture(page, isMobile);

      await expect(itemRow(page, thought)).toBeVisible();
      await expect(inbox(page).getByText(thought)).toBeVisible();
      await expect(itemRow(page, typed)).toBeVisible();
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

      // Dark, for capturing at night: the whole screen under the top bar - the
      // page, the shell's edge and the empty band under the tabs - goes dark with
      // the Car view and is light again on Write. Only a browser applies the
      // stylesheet that is keyed on the view's flag.
      const colour = (selector: string) =>
        page.locator(selector).first().evaluate((el) => getComputedStyle(el).backgroundColor);
      const NIGHT = 'rgb(17, 18, 22)';
      const NIGHT_BAND = 'rgb(23, 24, 28)';
      expect(await colour('body')).not.toBe(NIGHT);
      await press(page.getByRole('button', { name: 'Dark view' }), isMobile);
      await expect.poll(() => colour('body')).toBe(NIGHT);
      expect(await colour('main')).toBe(NIGHT);
      expect(await colour('[data-capture]')).toBe(NIGHT);
      expect(await colour('[data-band]')).toBe(NIGHT_BAND);
      // The lit side of the Write | Car switch is still the view shown.
      expect(await colour('[data-capture] a[data-lit]')).not.toBe(await colour('[data-capture] a:not([data-lit])'));
      await press(page.getByRole('link', { name: 'Write' }), isMobile);
      await expect.poll(() => colour('body')).not.toBe(NIGHT);
      expect(await colour('[data-band]')).not.toBe(NIGHT_BAND);
      // Remembered on this device: Car opens dark again.
      await press(page.getByRole('link', { name: 'Car' }), isMobile);
      await expect.poll(() => colour('body')).toBe(NIGHT);
      await expect(page.getByRole('button', { name: 'Dark view' })).toHaveAttribute('aria-pressed', 'true');

      // Spoken into the same fake microphone as Write's: tap, a second of
      // sound, tap, and the Item holds the stand-in's words. It is not the
      // phrase of this run, so the row is found by being exactly those words.
      await press(drive, isMobile);
      await expect(page.getByText('Listening — tap to capture')).toBeVisible();
      await expect(page.getByLabel('Recording')).toContainText('Listening · 0:01');
      await press(page.getByRole('button', { name: 'Capture', exact: true }), isMobile);
      await expect(page.getByText('Captured', { exact: true })).toBeVisible();
      await expect(page.getByRole('list', { name: 'Captured here' }).getByText(STAND_IN_WORDS)).toBeVisible();
      await openInbox(page, isMobile);
      const spoken = page.getByRole('listitem').filter({ has: page.getByText(STAND_IN_WORDS, { exact: true }) });
      await expect(spoken.first()).toBeVisible();
      // Put somewhere, because a note without a workspace waits in every Inbox
      // of the one account all specs share, and would turn up in their counts.
      // Every run of this walk speaks the same words, so each row still
      // waiting is moved, and one an earlier run already moved is left be.
      for (let at = (await spoken.count()) - 1; at >= 0; at--) {
        await press(spoken.nth(at).getByRole('button', { name: 'Item actions' }), isMobile);
        const move = page.getByRole('menuitem', { name: 'Move to this workspace' });
        if (await move.isVisible()) await press(move, isMobile);
        else await page.keyboard.press('Escape');
      }
      // Moved once no row that belongs here offers to be moved here.
      await press(spoken.first().getByRole('button', { name: 'Item actions' }), isMobile);
      await expect(page.getByRole('menuitem', { name: 'Move to…' })).toBeVisible();
      await expect(page.getByRole('menuitem', { name: 'Move to this workspace' })).toHaveCount(0);
      await page.keyboard.press('Escape');

      // What the phone's share sheet handed to the installed app ("Share photos,
      // files and links into Cockpit from Android's share sheet", issue 789).
      // The sheet is outside any browser and this stack's Vite registers no
      // service worker, so the share is put in the holding area the way the
      // worker's script writes it, and Capture opened as the worker opens it.
      // Only a browser proves the page claims it, queues the file and sends it
      // through to an Item with the photo as its Attachment.
      const shared = uniqueTitle('Shared from the gallery');
      await page.evaluate(
        ({ note, png, database, store }) =>
          new Promise<void>((resolve, reject) => {
            const opening = indexedDB.open(database);
            opening.onupgradeneeded = () => opening.result.createObjectStore(store);
            opening.onerror = () => reject(opening.error);
            opening.onsuccess = () => {
              const bytes = Uint8Array.from(atob(png), (c) => c.charCodeAt(0)).buffer;
              const writing = opening.result.transaction(store, 'readwrite');
              writing.objectStore(store).put(
                {
                  id: 'a-share',
                  receivedAt: new Date().toISOString(),
                  title: '',
                  text: note,
                  url: '',
                  files: [{ name: 'sunset.png', type: 'image/png', size: bytes.byteLength, bytes }],
                },
                'a-share',
              );
              writing.oncomplete = () => resolve();
              writing.onerror = () => reject(writing.error);
            };
          }),
        { note: shared, png: A_PNG_BASE64, database: SHARE_HOLDING_DATABASE, store: SHARE_HOLDING_STORE },
      );
      await page.goto('/capture');
      await expect(page.getByText('sunset.png')).toBeVisible();
      await expect(captureBox(page)).toHaveValue(shared);
      await expect(page.getByRole('button', { name: 'Any workspace' })).toHaveAttribute('aria-pressed', 'true');
      // The photo uploads once the note has landed: leaving before it answers
      // cuts the upload off, and the retry comes after this walk has looked.
      const uploaded = page.waitForResponse(
        (response) =>
          response.request().method() === 'POST' &&
          /\/v1\/items\/[^/]+\/attachments$/.test(new URL(response.url()).pathname),
      );
      await press(page.getByRole('button', { name: 'Capture', exact: true }), isMobile);
      await expect(page.getByRole('region', { name: 'Just captured' }).getByText(shared)).toBeVisible();
      expect((await uploaded).status()).toBe(201);

      // Claimed, so opening Capture again finds nothing of it.
      await page.goto('/capture');
      await expect(captureBox(page)).toHaveValue('');
      await expect(page.getByText('sunset.png')).toHaveCount(0);

      await openInbox(page, isMobile);
      await press(itemRow(page, shared).getByRole('button', { name: 'Item actions' }), isMobile);
      await press(page.getByRole('menuitem', { name: 'Move to this workspace' }), isMobile);
      await press(itemRow(page, shared).getByRole('button', { name: 'Item actions' }), isMobile);
      await press(page.getByRole('menuitem', { name: 'Open' }), isMobile);
      await openTheFiles(page, isMobile);
      await expect(page.getByRole('dialog').getByRole('img', { name: 'sunset.png' })).toBeVisible({
        timeout: 15_000,
      });
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

      // The note written formatted ("Switch the Capture note to formatted",
      // issue 758): only a browser has a real selection to bold and a real
      // editor to carry it to an Item's description.
      await openCapture(page, isMobile);
      await press(page.getByRole('button', { name: 'Format the note' }), isMobile);
      const toolbar = page.getByRole('toolbar', { name: 'Formatting' });
      await expect(toolbar.getByRole('button', { name: 'bold' })).toBeEnabled();
      const bolded = uniqueTitle('Bold in the note');
      await press(captureBox(page), isMobile);
      await page.keyboard.type(bolded);
      await captureBox(page).press('ControlOrMeta+a');
      await press(toolbar.getByRole('button', { name: 'bold' }), isMobile);
      await press(page.getByRole('button', { name: 'Capture' }), isMobile);
      await expect(page.getByRole('region', { name: 'Just captured' }).getByText(bolded)).toBeVisible();
      // Emptied, and still formatted for the next note.
      await expect(captureBox(page)).toHaveText('');
      await expect(page.getByRole('button', { name: 'Format the note' })).toHaveAttribute('aria-pressed', 'true');
      await closeCapture(page, isMobile);

      // The row says it without the asterisks.
      await expect(itemRow(page, bolded)).toBeVisible();
      await press(itemRow(page, bolded).getByRole('button', { name: 'Item actions' }), isMobile);
      await press(page.getByRole('menuitem', { name: 'Open' }), isMobile);
      const form = page.getByRole('dialog');
      await expect(form.getByRole('textbox', { name: 'Title' })).toHaveValue(bolded);
      await expect(form.getByRole('textbox', { name: 'Description' }).locator('strong')).toHaveText(bolded);
    });
  });

  test.describe('dragging the handle of the note box at a desk changes its height', () => {
    test('grows the box, and past what the window holds the window scrolls instead of growing', async ({
      page,
      isMobile,
    }) => {
      // No handle on a phone, by design.
      test.skip(isMobile, 'the handle is a desk affordance');
      await openInbox(page, isMobile);
      await openCapture(page, isMobile);

      const note = captureBox(page);
      const box = note.locator('xpath=ancestor::div[contains(@class,"resize-y")]');
      const window = page.getByRole('dialog').filter({ has: note });
      const heights = async () => ({
        box: (await box.boundingBox())!.height,
        window: (await window.boundingBox())!.height,
      });
      // The handle is the box's bottom-right corner; a drag from just inside it.
      const dragHandleBy = async (dy: number) => {
        const at = (await box.boundingBox())!;
        const x = at.x + at.width - 6;
        const y = at.y + at.height - 6;
        await page.mouse.move(x, y);
        await page.mouse.down();
        await page.mouse.move(x, y + dy, { steps: 8 });
        await page.mouse.up();
      };

      const before = await heights();
      await dragHandleBy(60);
      const grown = await heights();
      expect(grown.box).toBeGreaterThan(before.box + 40);

      // With the note formatted too ("Switch the Capture note to formatted",
      // issue 758): the editor fills what the box is given instead of keeping
      // a height of its own, so the same handle still moves it.
      await press(page.getByRole('button', { name: 'Format the note' }), isMobile);
      await expect(page.getByRole('toolbar', { name: 'Formatting' })).toBeVisible();
      const formatted = await heights();
      await dragHandleBy(60);
      expect((await heights()).box).toBeGreaterThan(formatted.box + 40);
      const grownAgain = await heights();

      // Dragged past anything the window can hold: the window stops at the
      // screen and scrolls, rather than growing off it or squeezing the box back.
      await dragHandleBy(2000);
      const past = await heights();
      const screen = page.viewportSize()!.height;
      expect(past.box).toBeGreaterThan(grownAgain.box);
      expect(past.box).toBeGreaterThan(past.window);
      expect(past.window).toBeLessThanOrEqual(screen);
      await expect(note).toBeVisible();
    });
  });
});
