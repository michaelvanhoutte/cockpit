import {
  STARTING_WORKSPACE,
  capture,
  captureBox,
  closeCapture,
  openCapture,
  expect,
  expectNoSidewaysScroll,
  inbox,
  itemRow,
  openInbox,
  makeWorkspace,
  press,
  switchTo,
  workspaceTab,
  test,
  uniqueTitle,
} from './support/app';
import type { Page } from '@playwright/test';

/**
 * F3, because the whole of this rule is one item being in two workspaces at
 * once and then in one: switching workspace is a navigation, capture is a
 * screen of its own reached from the header, and neither the second Inbox nor
 * the first one losing the row exists below a real browser against a real
 * store.
 *
 * It is not re-proving what the row's menu offers (F1,
 * apps/web/tests/unit/components/ItemRow.test.tsx) nor which workspace a
 * settling gives an item (L1/L2, apps/api/tests/unit/domain/items.test.ts and
 * apps/api/tests/integration/http/panel-items.test.ts). It proves the walk.
 */

/**
 * The workspace every account starts with. Named rather than counted, because
 * every spec in a run shares one database and several of them make workspaces
 * of their own - so an index into the strip is a different workspace depending
 * on what else is running, and this name and the one below are the two a walk
 * can count on.
 */
const CAPTURED_FROM = STARTING_WORKSPACE;
/**
 * The second workspace these walks need, made by the file rather than found: an
 * account starts with one now.
 *
 * **A fixed name, not a unique one.** Every spec in a run shares one database
 * and both projects run against it, so a name with a random suffix would make
 * one workspace per project and leave the strip two entries longer than the
 * other specs expect. Fixed, the guard below makes the second run a no-op. No
 * other spec uses this name, and none deletes it.
 */
const ELSEWHERE = 'Elsewhere';

/**
 * Goes to the capture page by its address and writes a note there, without
 * saying which workspace it belongs to.
 *
 * **By its address rather than the tab**, because that is reaching Capture
 * from outside a workspace, which is what starts Where on *Any workspace*: the
 * tab and `C` start it on the workspace you are in ("Capture over the screen
 * you are on, and open it with C", issue 536).
 *
 * **It waits on what the page says it just did.** The page has no Inbox beside
 * it - it belongs to no workspace - so the row under the box is the only thing
 * on screen that can say the note landed, and going looking for it in an Inbox
 * before then is a race against the workspace's own snapshot.
 */
async function captureWithoutAWorkspace(
  page: Page,
  title: string,
  isMobile: boolean,
): Promise<void> {
  await page.goto('/capture');
  const box = captureBox(page);
  await expect(box).toBeVisible();

  // Where the button sits ("Keep the Capture button in reach on a phone", issue
  // 534): directly under the note on a phone, so the keyboard does not cover
  // it, and below the Where row at a desk. Asserted here because this is the
  // walk already on that page, and the area's walk ceiling has no room for one
  // of its own.
  const [noteBox, buttonBox, typeBox, whereBox] = await Promise.all(
    [
      box,
      page.getByRole('button', { name: 'Capture', exact: true }),
      page.getByRole('group', { name: 'Type' }),
      page.getByRole('group', { name: 'Where' }),
    ].map((one) => one.boundingBox()),
  );
  if (isMobile) {
    expect(buttonBox!.y).toBeGreaterThanOrEqual(noteBox!.y + noteBox!.height);
    expect(buttonBox!.y + buttonBox!.height).toBeLessThanOrEqual(typeBox!.y);
  } else {
    expect(buttonBox!.y).toBeGreaterThanOrEqual(whereBox!.y + whereBox!.height);
  }

  await box.fill(title);
  // The button here and the shortcut in the walk below, so both ways in are
  // driven. Enter alone is a new line now, which is what a box of several lines
  // means.
  await press(page.getByRole('button', { name: 'Capture' }), isMobile);
  await expect(itemRow(page, title)).toBeVisible();
  await expectNoSidewaysScroll(page);
}

/** Back into a workspace's Inbox, which is a screen of its own on a phone. */
async function openTheInboxOf(page: Page, name: string, isMobile: boolean): Promise<void> {
  await switchTo(page, name, isMobile);
  if (isMobile) await press(page.getByRole('link', { name: 'Inbox' }).first(), isMobile);
}

/**
 * The second workspace, made once for the file. Every walk below needs an
 * Inbox that is not the one a note was captured from, and an account starts
 * with a single workspace - so this is arrangement rather than something to
 * find.
 */
test.beforeEach(async ({ page, isMobile }) => {
  await openInbox(page, isMobile);
  if (await workspaceTab(page, ELSEWHERE).count()) return;
  await makeWorkspace(page, ELSEWHERE, isMobile);
  await switchTo(page, CAPTURED_FROM, isMobile);
});

test.describe('Capture', () => {
  test.describe('a note captured without a workspace waits in every workspace until you say where it belongs', () => {
    test('is in both inboxes, and in one only once it has been put there', async ({
      page,
      isMobile,
    }) => {
      await openInbox(page, isMobile);

      const note = uniqueTitle('Where does this go');
      await captureWithoutAWorkspace(page, note, isMobile);

      // In the workspace it was captured from, marked as not that workspace's
      // own. Captured *from* it because that is where this walk had open when
      // it went to the page (apps/web/src/lastVisited.ts).
      await openTheInboxOf(page, CAPTURED_FROM, isMobile);
      await expect(itemRow(page, note)).toBeVisible();
      await expect(itemRow(page, note).getByText('Any workspace')).toBeVisible();
      await expectNoSidewaysScroll(page);

      // And in another workspace, which is the whole point of it.
      //
      // **Named, not the second tab along.** Every spec in a run shares one
      // database and several of them make workspaces, so an index into the
      // strip is a different workspace depending on what else is running. The
      // one an account starts with and the one this file makes are the two
      // names it can count on, and no walk deletes either.
      await openTheInboxOf(page, ELSEWHERE, isMobile);
      await expect(inbox(page).getByText(note)).toBeVisible();

      // Said here, it belongs here - and it stops being everybody's.
      await press(itemRow(page, note).getByRole('button', { name: 'Item actions' }), isMobile);
      await press(page.getByRole('menuitem', { name: 'Move to this workspace' }), isMobile);
      await expect(itemRow(page, note).getByText('Any workspace')).toHaveCount(0);

      // Waited for here too, for a different reason: what follows is a
      // negative assertion, and one of those is answered by any moment the
      // rows are not drawn - a page part way through a navigation among them.
      // The note is still in Atlas Copco's Inbox at this point, as its own
      // rather than everybody's, so it is Work's Inbox that has to be on screen
      // before "it is not there" says anything.
      await openTheInboxOf(page, CAPTURED_FROM, isMobile);
      await expect(inbox(page).getByText(note)).toHaveCount(0);
      await expectNoSidewaysScroll(page);
    });

  });

  test.describe('a note can say which workspace it belongs to as it is captured', () => {
    test('goes straight to the workspace named on the page, and is that workspace’s own', async ({
      page,
      isMobile,
    }) => {
      await openInbox(page, isMobile);

      const note = uniqueTitle('Book the venue deposit');
      await openCapture(page, isMobile);
      await press(page.getByRole('button', { name: ELSEWHERE }), isMobile);
      const box = captureBox(page);
      await box.fill(note);
      // The shortcut rather than the button, which is the other way in.
      await box.press('ControlOrMeta+Enter');
      await expect(page.getByRole('region', { name: 'Just captured' }).getByText(note)).toBeVisible();
      await closeCapture(page, isMobile);

      await openTheInboxOf(page, ELSEWHERE, isMobile);
      await expect(itemRow(page, note)).toBeVisible();
      // Somebody said where it belongs, so it is not waiting in everybody's.
      await expect(itemRow(page, note).getByText('Any workspace')).toHaveCount(0);
    });

  });

  test.describe('Capture starts on the workspace you are in, and C opens it at a desk', () => {
    test('makes the note that workspace’s own, without a choice being made', async ({
      page,
      isMobile,
    }) => {
      await openInbox(page, isMobile);

      await openCapture(page, isMobile);
      await expect(
        page.getByRole('group', { name: 'Where' }).getByRole('button', { name: CAPTURED_FROM }),
      ).toHaveAttribute('aria-pressed', 'true');
      await closeCapture(page, isMobile);

      const note = uniqueTitle('Reply to Bart');
      await capture(page, note, isMobile);

      await expect(itemRow(page, note)).toBeVisible();
      await expect(itemRow(page, note).getByText('Any workspace')).toHaveCount(0);

      // And `C` does the same at a desk, with the note in the Inbox beside the
      // window before it closes and Escape putting you back where you were. A
      // phone has no screen to leave visible: there `C` opens the page, which
      // is everything above.
      if (isMobile) return;
      const where = page.url();
      const second = uniqueTitle('Call the plumber');
      await page.keyboard.press('c');
      await expect(page.getByRole('dialog', { name: 'Capture', exact: true })).toBeVisible();
      await expect(captureBox(page)).toBeFocused();
      await captureBox(page).fill(second);
      await captureBox(page).press('ControlOrMeta+Enter');
      // Asked of the column by its element rather than its role: the window
      // makes it inert to one.
      await expect(page.locator('aside', { hasText: second })).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog', { name: 'Capture', exact: true })).toBeHidden();
      expect(page.url()).toBe(where);
      await expect(itemRow(page, second)).toBeVisible();
    });
  });
});
