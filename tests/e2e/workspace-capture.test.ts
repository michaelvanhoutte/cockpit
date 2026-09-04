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
import type { Page } from '@playwright/test';

/**
 * F3, because the whole of this rule is one item being in two workspaces at
 * once and then in one: switching workspace is a navigation, the capture window
 * is a dialog opened from the header, and neither the second Inbox nor the
 * first one losing the row exists below a real browser against a real store.
 *
 * It is not re-proving what the row's menu offers (F1,
 * apps/web/tests/unit/components/ItemRow.test.tsx) nor which workspace a
 * settling gives an item (L1/L2, apps/api/tests/unit/domain/items.test.ts and
 * apps/api/tests/integration/http/panel-items.test.ts). It proves the walk.
 */

/**
 * Two of the three workspaces every account starts with. Named rather than
 * counted, because every spec in a run shares one database and several of them
 * make workspaces of their own; the seeded three are the only ones a walk can
 * name, and no walk deletes them.
 */
const CAPTURED_FROM = 'Work';
const ELSEWHERE = 'Atlas Copco';

/** The workspace tabs across the top, which is how another workspace is reached. */
function workspaceTab(page: Page, name: string) {
  return page.getByRole('navigation', { name: 'Workspaces' }).getByRole('link', { name });
}

/** Opens the header's capture window and writes a note in it, without saying where it goes. */
async function captureWithoutAWorkspace(
  page: Page,
  title: string,
  isMobile: boolean,
): Promise<void> {
  await press(page.getByRole('button', { name: 'Capture…' }), isMobile);
  const box = page.getByRole('dialog').getByLabel('Capture a note or to-do');
  await expect(box).toBeVisible();
  await box.fill(title);
  // Enter, not the button: capture is the thing the app does fastest, and a
  // note typed into a box wants the key already under the hand. The button is
  // pressed by the walk below, so both ways in are driven.
  await box.press('Enter');
  // **The row, then the window.** The window closes on the answer rather than
  // on the press, so waiting only for it to go says nothing about whether the
  // note landed - and when a capture is refused the window is *meant* to stay,
  // which would read here as a slow one.
  await expect(itemRow(page, title)).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

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
      // own.
      await expect(itemRow(page, note)).toBeVisible();
      await expect(itemRow(page, note).getByText('Any workspace')).toBeVisible();
      await expectNoSidewaysScroll(page);

      // And in another workspace, which is the whole point of it.
      //
      // **Named, not the second tab along.** Every spec in a run shares one
      // database and several of them make workspaces, so an index into the
      // strip is a different workspace depending on what else is running. The
      // three seeded ones are the only names a walk can count on, and no walk
      // deletes them.
      await press(workspaceTab(page, ELSEWHERE), isMobile);
      if (isMobile) {
        await press(page.getByRole('link', { name: 'Inbox' }).first(), isMobile);
      }
      await expect(inbox(page).getByText(note)).toBeVisible();

      // Said here, it belongs here - and it stops being everybody's.
      await press(itemRow(page, note).getByRole('button', { name: 'Item actions' }), isMobile);
      await press(page.getByRole('menuitem', { name: 'Move to this workspace' }), isMobile);
      await expect(itemRow(page, note).getByText('Any workspace')).toHaveCount(0);

      await press(workspaceTab(page, CAPTURED_FROM), isMobile);
      if (isMobile) {
        await press(page.getByRole('link', { name: 'Inbox' }).first(), isMobile);
      }
      await expect(inbox(page).getByText(note)).toHaveCount(0);
      await expectNoSidewaysScroll(page);
    });

    test('captures into the workspace you are in from the inbox’s own box, as it always did', async ({
      page,
      isMobile,
    }) => {
      await openInbox(page, isMobile);

      const note = uniqueTitle('Reply to Bart');
      await captureBox(page).fill(note);
      await press(inbox(page).getByRole('button', { name: 'Capture' }), isMobile);

      await expect(itemRow(page, note)).toBeVisible();
      await expect(itemRow(page, note).getByText('Any workspace')).toHaveCount(0);
    });
  });
});
