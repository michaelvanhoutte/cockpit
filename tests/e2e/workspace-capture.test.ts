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

/**
 * Switches workspace, and waits until the new one is really the one on screen.
 *
 * **The waiting is the point, and nothing else in this walk can do it.** The
 * note it follows is drawn in *every* workspace's Inbox until it is settled -
 * which is the rule under test - so "the note is in the Inbox" is true before
 * the switch as well as after, and cannot say the switch has happened. Without
 * this the walk pressed Move to this workspace on the workspace it had just
 * left: measured on CI, Atlas Copco's snapshot took 126ms to arrive and the
 * walk was seven milliseconds quicker, so the item was settled into the
 * workspace it was captured in and never left that Inbox.
 *
 * **It waits for the address to get deeper, not to change.** A tab's own
 * address is `/w/<id>`, and the router puts that in the bar before it does any
 * of the work - the failing run had `/w/ws-atlas` up a twentieth of a second
 * before the bad press. `/w/<id>` then redirects to the view the workspace was
 * last on, from a `beforeLoad` that awaits the workspace and its dashboards
 * (router.tsx), so a *deeper* address is the page saying it holds this
 * workspace's snapshot - which is the same snapshot the Inbox is drawn from.
 */
async function switchTo(page: Page, name: string, isMobile: boolean): Promise<void> {
  const tab = workspaceTab(page, name);
  const workspace = await tab.getAttribute('href');
  if (!workspace) throw new Error(`the tab for ${name} has no address to wait for`);
  await press(tab, isMobile);
  await page.waitForURL((url) => url.pathname.startsWith(`${workspace}/`));
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
      await switchTo(page, ELSEWHERE, isMobile);
      if (isMobile) {
        await press(page.getByRole('link', { name: 'Inbox' }).first(), isMobile);
      }
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
      await switchTo(page, CAPTURED_FROM, isMobile);
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
