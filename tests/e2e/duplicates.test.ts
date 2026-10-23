import type { Locator, Page } from '@playwright/test';
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
/** The title the form shows: a box at a desk, text on a phone, where the page opens to be read. */
async function expectTitle(page: Page, title: string, isMobile: boolean): Promise<void> {
  if (isMobile) await expect(form(page).locator('p.text-xl', { hasText: title })).toHaveText(title);
  else await expect(form(page).getByRole('textbox', { name: 'Title' })).toHaveValue(title);
}

/** The card the warning draws for the note with this title, as the other one of a pair. */
const theOtherNote = (page: Page, title: string) =>
  form(page).getByRole('group', { name: 'The other note' }).filter({ hasText: title });

/**
 * How the warning draws one pair ("Choose which of two possible duplicates to
 * keep, from the warning", issue 1451): this note and the other side by side at
 * a desk, stacked with this note first and each as wide as the warning on a
 * phone, and the warning showing all of it - **Keep both** included - without a
 * scrollbar of its own. jsdom lays nothing out, so only a browser can say.
 */
async function expectThePairDrawn(other: Locator, isMobile: boolean): Promise<void> {
  const cards = other.locator('xpath=..');
  const thisNote = await cards.getByRole('group', { name: 'This note (open)' }).boundingBox();
  const theOther = await other.boundingBox();
  const row = await cards.boundingBox();
  if (!thisNote || !theOther || !row) throw new Error('the pair of cards is not drawn');
  if (isMobile) {
    expect(thisNote.y + thisNote.height).toBeLessThanOrEqual(theOther.y + 1);
    expect(Math.abs(thisNote.x - theOther.x)).toBeLessThan(2);
    expect(thisNote.width).toBeGreaterThan(row.width - 2);
    expect(theOther.width).toBeGreaterThan(row.width - 2);
  } else {
    expect(thisNote.x + thisNote.width).toBeLessThanOrEqual(theOther.x + 1);
    expect(Math.abs(thisNote.y - theOther.y)).toBeLessThan(2);
  }
  const keepBoth = other.locator('xpath=../..').getByRole('button', { name: 'Keep both: not a duplicate' });
  await expect(keepBoth).toBeVisible();
  const overflow = await keepBoth.evaluate((button) => {
    // The warning is the nearest box around it that scrolls on its own.
    let warning = button.parentElement;
    while (warning && getComputedStyle(warning).overflowY !== 'auto') warning = warning.parentElement;
    return warning ? warning.scrollHeight - warning.clientHeight : Number.NaN;
  });
  expect(overflow).toBeLessThanOrEqual(1);
}

/**
 * The words two notes share. Long enough that the unique tag each one carries
 * cannot be most of what either says, which is what would leave two notes of
 * the same words reading as two different ones.
 */
const THE_SAME_THING = 'Ask Novy whether the part 11 audit trail covers our validation protocol';

/**
 * A pair of shared words nothing else in this file, this run or an earlier
 * one shares - generated fresh rather than a fixed phrase, for the same
 * reason `somethingElse` above is: this account accumulates across both
 * projects and every earlier run of this same file, and a fixed phrase used
 * by the settling walk below would flag a note against those leftovers too
 * on the word-overlap the local stack reads meaning with
 * (`EMBEDDINGS_STAND_IN`) - so the pair just settled would still read as
 * flagged, against something the walk never touched.
 */
function aPairOfWordsNothingElseShares(): string {
  return `Renew the ${crypto.randomUUID()} support contract for the ${crypto.randomUUID()} line`;
}

/**
 * A note with nothing in common with the pair above - and nothing in common
 * with the other project's copy of itself either, which is why almost every
 * word of it is a fresh tag.
 *
 * **The two projects share one account**, `desktop` running before `phone`
 * against storage rebuilt once per run (scripts/e2e-stack.mjs). So a note that
 * differs only in a short tag really is the same note twice by the time the
 * second project captures it, and would be flagged - correctly, and fatally for
 * a case asking that it is not.
 */
const somethingElse = () => `Shopping list for ${crypto.randomUUID()} and ${crypto.randomUUID()}`;

test.describe('Triage', () => {
  test.describe('going from a flagged note to the one it repeats, and back', () => {
    test('marks both of them, names the other one on the form as a pair of cards, and opens it', async ({
      page,
      isMobile,
    }) => {
      await openInbox(page, isMobile);
      const one = uniqueTitle(THE_SAME_THING);
      const again = uniqueTitle(THE_SAME_THING);
      const unrelated = somethingElse();
      await capture(page, one, isMobile);
      await capture(page, again, isMobile);
      await capture(page, unrelated, isMobile);

      // The mark arrives on its own: reading a note happens behind the capture,
      // and the Inbox is told about it the way it is told about everything else.
      await expect(itemRow(page, one).getByText('Duplicate?')).toBeVisible();
      await expect(itemRow(page, again).getByText('Duplicate?')).toBeVisible();
      // And on no other row, which is the half that would pass on a mark drawn
      // against every note.
      await expect(itemRow(page, unrelated).getByText('Duplicate?')).toHaveCount(0);

      // The chip's hover names the other note (the open form hides the rows).
      await expect(itemRow(page, one).getByText('Duplicate?')).toHaveAttribute('title', new RegExp(again));
      await openItem(page, one, isMobile);
      await expectTitle(page, one, isMobile);
      await expect(form(page).getByText('Possible duplicate · keep which one?')).toBeVisible();
      // The phone project shares the desktop's account, so it can be flagged against
      // the desktop's leftovers too: the block that names `again` is the one looked at.
      await expectThePairDrawn(theOtherNote(page, again), isMobile);

      // Open lands on the other note's own form...
      await press(theOtherNote(page, again).getByRole('button', { name: 'Open' }), isMobile);
      await expectTitle(page, again, isMobile);
      // ...which names the first one back, a pair being one pair whichever of
      // the two you are looking at.
      await expect(theOtherNote(page, one)).toBeVisible();

      // And the way back is the browser's own, because opening one is a change
      // of address rather than something only this tab knows.
      await page.goBack();
      await expectTitle(page, one, isMobile);

      // The warning's answer "this one is the copy": it goes, and the other note's form opens.
      await press(theOtherNote(page, again).getByRole('button', { name: 'Keep this one' }), isMobile);
      await expectTitle(page, again, isMobile);
      await expect(itemRow(page, one)).toHaveCount(0);
      // The open form hides the bar from the accessibility tree, so it is found hidden too.
      await expect(page.getByRole('status', { includeHidden: true })).toContainText('dismissed');
      // The other note's form took this note's place in the history, so Back leaves
      // the form instead of landing on a note that has gone.
      await page.goBack();
      await expect(form(page)).toHaveCount(0);
    });
  });
});

/**
 * F3, because settling is a real click on a real menu entry against a real
 * server, and an offer to undo it is a thing that appears, is pressed, and
 * goes - the same reach `triage.test.ts`'s own undo walk names. What sends
 * the command and what the store does with it are settled without a browser
 * (`apps/web/tests/unit/components/ItemList.test.tsx`,
 * `apps/api/tests/integration/http/duplicate-notes.test.ts`); what is only
 * true here is that the mark actually leaves the row, and comes back.
 */
test.describe('Triage', () => {
  test.describe('a flagged pair can be settled as not a duplicate', () => {
    test('drops the mark from the row, and offers it back', async ({ page, isMobile }) => {
      await openInbox(page, isMobile);
      const sharedWords = aPairOfWordsNothingElseShares();
      const one = uniqueTitle(sharedWords);
      const again = uniqueTitle(sharedWords);
      await capture(page, one, isMobile);
      await capture(page, again, isMobile);

      await expect(itemRow(page, one).getByText('Duplicate?')).toBeVisible();
      await expect(itemRow(page, again).getByText('Duplicate?')).toBeVisible();

      await press(itemRow(page, one).getByRole('button', { name: 'Item actions' }), isMobile);
      await press(page.getByRole('menuitem', { name: 'Not a duplicate' }), isMobile);

      await expect(itemRow(page, one).getByText('Duplicate?')).toHaveCount(0);
      // Both halves lose the mark - it is a fact about the pair, not about
      // whichever row the settling was pressed from.
      await expect(itemRow(page, again).getByText('Duplicate?')).toHaveCount(0);

      const offer = page.getByRole('status');
      await expect(offer).toContainText('is not a duplicate');
      await press(offer.getByRole('button', { name: 'Undo' }), isMobile);

      await expect(itemRow(page, one).getByText('Duplicate?')).toBeVisible();
      await expect(itemRow(page, again).getByText('Duplicate?')).toBeVisible();
      await expect(offer).toHaveCount(0);
    });
  });
});
