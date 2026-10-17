import type { Locator } from '@playwright/test';

import { SHARE_HOLDING_DATABASE, SHARE_HOLDING_STORE, TRANSCRIPTION_PATH } from '@cockpit/shared';
import {
  backToTheInbox,
  captureBox,
  capturedLine,
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
 * apps/api/tests/contract/clean-up-a-note.v16.test.ts asks the real model
 * whenever the prompt changes. A note filed where it says it goes ("File a
 * capture on the panels you name, read from the spoken path", issue 1116) has
 * no walk for the same reason: this stack has no model stand-in ("No model
 * stand-in in the browser suite, so no clean-up walk can be written", issue
 * 1118), and apps/api/tests/integration/http/note-cleanup-path.test.ts holds it.
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
      await expect(capturedLine(page, thought)).toBeVisible();

      // Undo takes it back into the box, and nothing of it stays in the Inbox;
      // captured again it is the one row there.
      await press(capturedLine(page, thought).getByRole('button', { name: 'Undo' }), isMobile);
      await expect(captureBox(page)).toHaveValue(thought);
      await expect(capturedLine(page, thought)).toHaveCount(0);
      await press(page.getByRole('button', { name: 'Capture' }), isMobile);
      await expect(capturedLine(page, thought)).toBeVisible();

      // A note captured twice says so above the Captured line, once the server
      // has paired them, with Undo still beside the line; the next capture clears it
      // ("Warn at Capture when the note just captured repeats another", issue 1115).
      // Words nothing else on this shared account says, so the pair is this walk's own
      // (the stack reads words rather than meaning: `EMBEDDINGS_STAND_IN`, scripts/e2e-stack.mjs).
      const words = `Renew the ${crypto.randomUUID()} support contract for the ${crypto.randomUUID()} line`;
      await captureBox(page).fill(uniqueTitle(words));
      await press(page.getByRole('button', { name: 'Capture' }), isMobile);
      const repeated = uniqueTitle(words);
      await captureBox(page).fill(repeated);
      await press(page.getByRole('button', { name: 'Capture' }), isMobile);
      await expect(capturedLine(page, repeated)).toBeVisible();
      const warning = page.getByRole('status').filter({ hasText: /^Looks like “/ });
      await expect(warning).toBeVisible({ timeout: 20_000 });
      await expect(warning.getByRole('button', { name: 'Open it' })).toBeVisible();
      await expect(capturedLine(page, repeated).getByRole('button', { name: 'Undo' })).toBeVisible();
      await captureBox(page).fill(uniqueTitle('Shopping list'));
      await press(page.getByRole('button', { name: 'Capture' }), isMobile);
      await expect(warning).toHaveCount(0);

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
      // The status sits under the strip on a phone and the mic's box is where
      // it was before the tap, so a thumb on it is not moved by recording; at a
      // desk the time sits beside the mic. Held at "Transcribing…" until the
      // walk has looked, since the stand-in answers at once.
      const micBefore = (await mic.boundingBox())!;
      let answer!: () => void;
      const held = new Promise<void>((resolve) => (answer = resolve));
      await page.route(`**${TRANSCRIPTION_PATH}`, async (route) => {
        await held;
        await route.continue();
      });
      await press(mic, isMobile);
      await expect(mic).toHaveAttribute('aria-pressed', 'true');
      // A second in, so there is sound kept to send: a recording stopped the moment it starts can be empty.
      const status = page.getByText('Listening · 0:01');
      await expect(status).toBeVisible();
      const listeningAt = (await status.boundingBox())!;
      const micNow = (await mic.boundingBox())!;
      if (isMobile) {
        expect(micNow).toEqual(micBefore);
        expect(listeningAt.y).toBeGreaterThanOrEqual(micBefore.y + micBefore.height);
      } else {
        expect(listeningAt.x + listeningAt.width).toBeLessThanOrEqual(micNow.x);
      }
      await press(mic, isMobile);
      const transcribing = page.getByText('Transcribing…');
      await expect(transcribing).toBeVisible();
      const transcribingAt = (await transcribing.boundingBox())!;
      expect(transcribingAt.y).toBe(listeningAt.y);
      if (isMobile) expect(await mic.boundingBox()).toEqual(micBefore);
      answer();
      await expect(captureBox(page)).toHaveValue(`${typed} ${STAND_IN_WORDS}`);
      await expect(mic).toHaveAttribute('aria-pressed', 'false');
      await expect(page.getByText('Transcribing…')).toHaveCount(0);
      await press(page.getByRole('button', { name: 'Capture' }), isMobile);
      await expect(capturedLine(page, typed)).toBeVisible();
      await closeCapture(page, isMobile);

      await expect(itemRow(page, thought)).toHaveCount(1);
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

      // Spoken into the same fake microphone as Write's, with no connection:
      // the Car view's capture with one is CarCapture.test.tsx's, and the
      // recorder and the transcriber are Write's walk above, so what only
      // this one adds is the kept recording. It still captures at once: the
      // recording waits on the phone for its words, and once the server can be reached it is
      // transcribed and lands as an Item ("Capture in the Car view without a
      // connection, from the recording", issue 1045). Only a browser keeps a
      // real recording in IndexedDB and hears the connection come back.
      await page.route('**/v1/**', (route) => route.abort('internetdisconnected'));
      const capturedHere = page.getByRole('list', { name: 'Captured here' });
      await press(drive, isMobile);
      await expect(page.getByLabel('Recording')).toContainText('Listening · 0:01');
      await press(page.getByRole('button', { name: 'Capture', exact: true }), isMobile);
      await expect(page.getByText('Captured', { exact: true })).toBeVisible();
      await expect(capturedHere.getByText('Waiting for its words')).toBeVisible();
      await page.unroute('**/v1/**');
      await page.context().setOffline(true);
      await page.context().setOffline(false);
      await expect(capturedHere.getByText('Waiting for its words')).toHaveCount(0, { timeout: 15_000 });
      await expect(capturedHere.getByText(STAND_IN_WORDS)).toHaveCount(1);
      await backToTheInbox(page, isMobile);
      const spoken = page.getByRole('listitem').filter({ has: page.getByText(STAND_IN_WORDS, { exact: true }) });
      await expect(spoken.first()).toBeVisible();
      await expect.poll(() => spoken.count()).toBeGreaterThanOrEqual(1);
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

      // A recording whose words do not come back waits on the device with
      // Retry, through a reload, and lands in the note once retried ("Keep a
      // recording Write could not transcribe, with Retry", issue 1044). The
      // transcriber is made to fail by turning its requests away. Only a
      // browser keeps a real recording in IndexedDB across a real reload.
      await page.goto('/capture');
      await page.route(`**${TRANSCRIPTION_PATH}`, (route) => route.fulfill({ status: 503, body: '' }));
      const again = page.getByRole('button', { name: 'Dictate' });
      await press(again, isMobile);
      await expect(page.getByText('Listening · 0:01')).toBeVisible();
      await press(again, isMobile);
      await expect(page.getByText('The recording is kept here to retry.', { exact: false })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible();
      await page.unroute(`**${TRANSCRIPTION_PATH}`);
      await page.reload();
      await expect(captureBox(page)).toHaveValue('');
      await press(page.getByRole('button', { name: 'Retry' }), isMobile);
      await expect(captureBox(page)).toHaveValue(STAND_IN_WORDS);
      await expect(page.getByRole('button', { name: 'Retry' })).toHaveCount(0);
      // Not captured: the walk's point is the words reaching the note.
      await captureBox(page).fill('');

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
      await expect(capturedLine(page, shared)).toBeVisible();
      expect((await uploaded).status()).toBe(201);

      // Claimed, so opening Capture again finds nothing of it.
      await page.goto('/capture');
      await expect(captureBox(page)).toHaveValue('');
      await expect(page.getByText('sunset.png')).toHaveCount(0);

      await backToTheInbox(page, isMobile);
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

  test.describe('capturing a thought never asks what kind of thing it is', () => {
    test('shows it in the inbox with no Type on its row', async ({ page, isMobile }) => {
      await openInbox(page, isMobile);
      await openCapture(page, isMobile);

      // Capture never asks ("Capture without a Type, at every front door",
      // issue 1067): the Where row is all there is to choose.
      await expect(page.getByRole('group', { name: 'Where' })).toBeInViewport();
      await expect(page.getByRole('group', { name: 'Type' })).toHaveCount(0);

      const thought = uniqueTitle('Maybe split the pricing page');
      await captureBox(page).fill(thought);
      await press(page.getByRole('button', { name: 'Capture' }), isMobile);
      await expect(capturedLine(page, thought)).toBeVisible();
      await closeCapture(page, isMobile);

      await expect(itemRow(page, thought)).toBeVisible();
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
      await expect(capturedLine(page, bolded)).toBeVisible();
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

  test.describe('the strip under the note is one row at a desk and two on a phone, and nothing in it runs past the note box', () => {
    test('puts the date shortcuts above the flags, Aa and the mic on a phone, and everything inside the box', async ({
      page,
      isMobile,
    }) => {
      // The phone project is 480px wide, which is not the narrowest phone, so
      // this walk narrows itself to 360px rather than adding a project that
      // would run every spec again (playwright.config.ts).
      if (isMobile) await page.setViewportSize({ width: 360, height: 740 });
      await openInbox(page, isMobile);
      await openCapture(page, isMobile);

      const priority = page.getByRole('group', { name: 'Priority' });
      const strip = priority.locator('xpath=..');
      const noteBox = strip.locator('xpath=..');
      const flags = priority.getByRole('button');
      const shortcuts = ['Today', 'Tmrw', '+7d'].map((name) => page.getByRole('button', { name, exact: true }));
      const aa = page.getByRole('button', { name: 'Format the note' });
      const mic = page.getByRole('button', { name: 'Dictate' });
      const due = page.getByRole('group', { name: 'Due' });
      const datePicker = page.getByRole('button', { name: 'Pick a due date' });
      const picked = page.getByRole('button', { name: /^Due / });
      const clear = page.getByRole('button', { name: 'Clear the due date' });

      const middle = async (control: Locator) => {
        const box = (await control.boundingBox())!;
        return box.y + box.height / 2;
      };
      const expectEverythingInsideTheBox = async () => {
        const inside = (await noteBox.boundingBox())!;
        for (const control of await strip.getByRole('button').all()) {
          const box = (await control.boundingBox())!;
          expect(box.x).toBeGreaterThanOrEqual(inside.x);
          expect(box.x + box.width).toBeLessThanOrEqual(inside.x + inside.width);
        }
        await expectNoSidewaysScroll(page);
      };
      /** Picks a day the way the native picker would: through the field's own setter, then its event. */
      const pick = (day: string) =>
        page.locator('input[type="date"]').evaluate((input: HTMLInputElement, value) => {
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
          input.dispatchEvent(new Event('input', { bubbles: true }));
        }, day);
      // A day that is none of the shortcuts, this year and next: December
      // until July and March after, so it is never within a week of today.
      const now = new Date();
      const thisYear = `${now.getFullYear()}-${now.getMonth() < 6 ? '12' : '03'}-29`;
      const nextYear = `${now.getFullYear() + 1}-12-29`;

      if (isMobile) {
        // Two rows: the shortcuts above, the flags with Aa and the mic below.
        await expect(due.getByText('Due', { exact: true })).toBeHidden();
        const top = await middle(shortcuts[0]!);
        for (const control of [...shortcuts, datePicker]) expect(await middle(control)).toBeCloseTo(top, 0);
        const bottom = await middle(flags.first());
        expect(top).toBeLessThan(bottom);
        for (const control of [...(await flags.all()), aa, mic]) expect(await middle(control)).toBeCloseTo(bottom, 0);
        const right = async (control: Locator) => (await control.boundingBox())!.x;
        expect(await right(aa)).toBeGreaterThan(await right(flags.last()));
        expect(await right(mic)).toBeGreaterThan(await right(aa));
        await expectEverythingInsideTheBox();

        // A day picked shows short, without the 📅, and the ✕ stays beside it.
        for (const day of [thisYear, nextYear]) {
          await pick(day);
          await expect(picked).toBeVisible();
          await expect(picked).not.toContainText('📅', { useInnerText: true });
          await expect(clear).toBeVisible();
          expect(await middle(clear)).toBeCloseTo(top, 0);
          await expectEverythingInsideTheBox();
        }
        // Next year's carries the year, this year's does not: counted as
        // numbers in the label, since the day itself can match a year's digits.
        await expect(picked).toHaveText(/^\D*\d+\D+\d+\D*$/, { useInnerText: true });
        await pick(thisYear);
        await expect(picked).toHaveText(/^\D*\d+\D*$/, { useInnerText: true });
      } else {
        // One row, with the label, and the full date beside the 📅.
        await expect(due.getByText('Due', { exact: true })).toBeVisible();
        const row = await middle(flags.first());
        for (const control of [...shortcuts, datePicker, aa, mic]) expect(await middle(control)).toBeCloseTo(row, 0);
        await expectEverythingInsideTheBox();
        await pick(thisYear);
        await expect(picked).toContainText('📅', { useInnerText: true });
        await expect(picked).toContainText(String(now.getFullYear()), { useInnerText: true });
        await expect(clear).toBeVisible();
        await expectEverythingInsideTheBox();
      }
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
