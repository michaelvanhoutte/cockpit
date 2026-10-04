import { capture, expect, itemRow, openInbox, press, test, uniqueTitle } from './support/app';

/**
 * F3: What Cockpit changed is reached from two places, and this walks both: the
 * Inbox heading's menu, which opens the window over every item, and an item's
 * own form, which carries it as a tab and a note under the tabs ("See the
 * history of what Cockpit proposed for the Inbox's items", issue 444; "Show
 * what Cockpit changed on the item itself, and name it for what it is", issue
 * 690).
 *
 * **Never touches the real enrichment path**, the same rule `capture.test.ts`
 * states for the same cost reasons (money, non-determinism) - the e2e stack
 * runs with no `ANTHROPIC_API_KEY` (`scripts/e2e-stack.mjs`), so every
 * capture here settles, deterministically and for free, as the one outcome
 * that needs no model at all: left as it is, "this environment has no
 * ANTHROPIC_API_KEY". That is what the window and an untouched item's tab show.
 * An item Cockpit *changed* has no such path here, so its history is answered at
 * the network edge by one row the stack could not have made; what is walked is
 * the real shell, the form's tabs and the note wired to it. What a row says and
 * opens to is
 * apps/web/tests/unit/components/SmartRefinementsWindow.test.tsx's and
 * ItemForm.test.tsx's, and the values it is drawn from are
 * apps/api/tests/integration/http/rewrite-history.test.ts's.
 */
const NO_KEY = 'Nothing was enriched: this environment has no ANTHROPIC_API_KEY';

test.describe('Capture', () => {
  test.describe('What Cockpit changed is reached from the Inbox menu and from an item’s own form, as a tab and a note under the tabs', () => {
    test('shows the same refinement across the Inbox, and an item’s own changes on its form', async ({ page, isMobile }) => {
      await openInbox(page, isMobile);
      const title = uniqueTitle('call the plumber about the leak');
      await capture(page, title, isMobile);

      // The heading and its menu sit in the band above the Inbox's own
      // landmark, not inside it (Layout.tsx), so this is asked for on the
      // page rather than scoped to `inbox(page)`.
      await press(page.getByRole('button', { name: 'Actions for the Inbox' }), isMobile);
      await press(page.getByRole('menuitem', { name: 'What Cockpit changed…' }), isMobile);
      const workspaceDialog = page.getByRole('dialog', { name: 'What Cockpit changed' });
      await expect(workspaceDialog).toBeVisible();
      await expect(workspaceDialog.getByText('How Cockpit refined the items in this Inbox, and when.')).toBeVisible();
      // Every visible item's refinements, with an Item column naming which.
      await expect(workspaceDialog.getByRole('columnheader', { name: 'Item' })).toBeVisible();
      await expect(workspaceDialog.getByRole('cell', { name: NO_KEY }).first()).toBeVisible();
      await press(workspaceDialog.getByRole('button', { name: 'Done' }), isMobile);
      await expect(workspaceDialog).not.toBeVisible();

      // An item's own menu has nothing for it: it is on the form.
      await press(itemRow(page, title).getByRole('button', { name: 'Item actions' }), isMobile);
      await expect(page.getByRole('menuitem', { name: /Cockpit/ })).toHaveCount(0);
      await press(page.getByRole('menuitem', { name: 'Open', exact: true }), isMobile);
      const form = page.getByRole('dialog');

      // Untouched: the tab is there, and there is no note to lead to it.
      await expect(form.getByText(/^Cockpit changed the /)).toHaveCount(0);
      await press(form.getByRole('tab', { name: 'What Cockpit changed' }), isMobile);
      await expect(form.getByText('Cockpit has not changed anything on this item.')).toBeVisible();
      await press(form.getByRole('button', { name: 'Cancel' }), isMobile);
      await expect(form).not.toBeVisible();

      // The history of the same item, now with a change in it.
      await page.route('**/v1/items/*/rewrite-history', async (route) => {
        const itemId = new URL(route.request().url()).pathname.split('/').at(-2)!;
        await route.fulfill({
          json: {
            entries: [
              {
                id: 'attempt-e2e',
                itemId,
                titleBefore: title,
                titleAfter: 'Call the plumber about the leak',
                descriptionBefore: null,
                descriptionAfter: null,
                proposedPanelName: null,
                status: 'rewritten',
                message: null,
                attemptedAt: '2026-10-01T09:00:00.000Z',
                looksAt: 'texts-and-panel',
                suggestedPanelBefore: null,
                suggestedPanelAfter: null,
              },
            ],
          },
        });
      });

      await press(itemRow(page, title).getByRole('button', { name: 'Item actions' }), isMobile);
      await press(page.getByRole('menuitem', { name: 'Open', exact: true }), isMobile);
      await expect(form.getByText('Cockpit changed the title')).toBeVisible();

      await press(form.getByRole('button', { name: 'See what changed' }), isMobile);
      await expect(form.getByRole('tab', { name: 'What Cockpit changed', selected: true })).toBeVisible();
      await expect(form.getByRole('button', { name: /Changed the title/ })).toBeVisible();
      await press(form.getByRole('button', { name: 'Cancel' }), isMobile);
      await expect(form).not.toBeVisible();

      // Seen, and it stays seen when the form is opened again.
      await press(itemRow(page, title).getByRole('button', { name: 'Item actions' }), isMobile);
      await press(page.getByRole('menuitem', { name: 'Open', exact: true }), isMobile);
      await expect(form.getByRole('tab', { name: 'What Cockpit changed' })).toBeVisible();
      await expect(form.getByText(/^Cockpit changed the /)).toHaveCount(0);
    });
  });
});
