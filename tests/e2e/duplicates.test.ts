import type { Page } from '@playwright/test';
import { capture, expect, itemRow, openInbox, press, test, uniqueTitle } from './support/app';

/**
 * F3, because this is the capability: a row says a note may be repeating
 * another, and you can go from it to that other note and back. The route change
 * and the back button exist nowhere but a browser - which is also why this walk
 * is one walk rather than several.
 *
 * Everything else about the feature is held below. Which notes are paired at
 * all is a real store's answer
 * (apps/api/tests/integration/http/duplicate-notes.test.ts), whether a pair is
 * drawn once one of them is filed is a view over the snapshot
 * (apps/web/tests/unit/duplicates.test.ts), and whether a model really reads
 * two differently-worded notes as saying the same thing is the contract tier's
 * (apps/api/tests/contract/read-what-a-note-means.test.ts).
 *
 * **This stack reads words rather than meaning** (`EMBEDDINGS_STAND_IN`,
 * scripts/e2e-stack.mjs): Workers AI has no local simulator and a walk may not
 * depend on a remote service answering, so the two notes below repeat each
 * other in almost the same words. That is enough for the one thing this tier is
 * for - the mark, the link and the way back.
 */

/** Opens one row's form the way both devices can: from the row's own menu. */
async function openItem(page: Page, row: string, isMobile: boolean): Promise<void> {
  await press(itemRow(page, row).getByRole('button', { name: 'Item actions' }), isMobile);
  await press(page.getByRole('menuitem', { name: 'Open' }), isMobile);
}

const form = (page: Page) => page.getByRole('dialog');
const titleBox = (page: Page) => form(page).getByRole('textbox', { name: 'Title' });

/**
 * The words two notes share. Long enough that the unique tag each one carries
 * cannot be most of what either says, which is what would leave two notes of
 * the same words reading as two different ones.
 */
const THE_SAME_THING = 'Ask Novy whether the part 11 audit trail covers our validation protocol';
const SOMETHING_ELSE = 'Buy milk and bread on my way home from work';

test.describe('Triage', () => {
  test.describe('going from a flagged note to the one it repeats, and back', () => {
    test('marks both of them, names the other one on the form, and opens it', async ({
      page,
      isMobile,
    }) => {
      await openInbox(page, isMobile);
      const one = uniqueTitle(THE_SAME_THING);
      const again = uniqueTitle(THE_SAME_THING);
      const unrelated = uniqueTitle(SOMETHING_ELSE);
      await capture(page, one, isMobile);
      await capture(page, again, isMobile);
      await capture(page, unrelated, isMobile);

      // The mark arrives on its own: reading a note happens behind the capture,
      // and the Inbox is told about it the way it is told about everything else.
      await expect(itemRow(page, one).getByLabel('Possible duplicate')).toBeVisible();
      await expect(itemRow(page, again).getByLabel('Possible duplicate')).toBeVisible();
      // And on no other row, which is the half that would pass on a mark drawn
      // against every note.
      await expect(itemRow(page, unrelated).getByLabel('Possible duplicate')).toHaveCount(0);

      await openItem(page, one, isMobile);
      await expect(titleBox(page)).toHaveValue(one);
      await expect(form(page).getByText('Possible duplicate of')).toBeVisible();

      // Following it lands on the other note's own form...
      await press(form(page).getByRole('button', { name: again }), isMobile);
      await expect(titleBox(page)).toHaveValue(again);
      // ...which names the first one back, a pair being one pair whichever of
      // the two you are looking at.
      await expect(form(page).getByRole('button', { name: one })).toBeVisible();

      // And the way back is the browser's own, because opening one is a change
      // of address rather than something only this tab knows.
      await page.goBack();
      await expect(titleBox(page)).toHaveValue(one);
    });
  });
});
