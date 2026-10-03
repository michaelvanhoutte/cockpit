import { capture, expect, itemRow, openInbox, press, test, uniqueTitle } from './support/app';

/**
 * F3: a menu leads to a window drawn over the workspace, and this one has two
 * doors into the same table rather than one ("See the history of what Cockpit
 * proposed for the Inbox's items", issue 444; "Rename Rewrite history to Smart
 * refinements, and show each field's change", issue 614).
 *
 * **Never touches the real enrichment path**, the same rule `capture.test.ts`
 * states for the same cost reasons (money, non-determinism) - the e2e stack
 * runs with no `ANTHROPIC_API_KEY` (`scripts/e2e-stack.mjs`), so every
 * capture here settles, deterministically and for free, as the one outcome
 * that needs no model at all: left as it is, "this environment has no
 * ANTHROPIC_API_KEY". What is walked is the two entry points and what each
 * one shows; what a row says and opens to is
 * apps/web/tests/unit/components/SmartRefinementsWindow.test.tsx's, and the
 * values it is drawn from are apps/api/tests/integration/http/rewrite-history.test.ts's.
 */
const NO_KEY = 'Nothing was enriched: this environment has no ANTHROPIC_API_KEY';

test.describe('Capture', () => {
  test.describe("the window is reached as \"Cockpit's suggestions…\" from the Inbox menu and \"Cockpit's suggestions for this item…\" from an item menu, and is titled Cockpit's suggestions", () => {
    test('shows the same refinement scoped to the item, and again across the Inbox', async ({ page, isMobile }) => {
      await openInbox(page, isMobile);
      const title = uniqueTitle('call the plumber about the leak');
      await capture(page, title, isMobile);

      await press(itemRow(page, title).getByRole('button', { name: 'Item actions' }), isMobile);
      await press(page.getByRole('menuitem', { name: "Cockpit's suggestions for this item…" }), isMobile);
      const itemDialog = page.getByRole('dialog', { name: "Cockpit's suggestions" });
      await expect(itemDialog).toBeVisible();
      await expect(itemDialog.getByText('How Cockpit refined this item, and when.')).toBeVisible();
      await expect(itemDialog.getByRole('cell', { name: 'When you captured it' })).toBeVisible();
      await expect(itemDialog.getByRole('cell', { name: NO_KEY })).toBeVisible();
      // Scoped to this one item: no column naming which item each row is.
      await expect(itemDialog.getByRole('columnheader', { name: 'Item' })).toHaveCount(0);
      await press(itemDialog.getByRole('button', { name: 'Done' }), isMobile);
      await expect(itemDialog).not.toBeVisible();

      // The heading and its menu sit in the band above the Inbox's own
      // landmark, not inside it (Layout.tsx), so this is asked for on the
      // page rather than scoped to `inbox(page)`.
      await press(page.getByRole('button', { name: 'Actions for the Inbox' }), isMobile);
      await press(page.getByRole('menuitem', { name: "Cockpit's suggestions…" }), isMobile);
      const workspaceDialog = page.getByRole('dialog', { name: "Cockpit's suggestions" });
      await expect(workspaceDialog).toBeVisible();
      await expect(workspaceDialog.getByText('How Cockpit refined the items in this Inbox, and when.')).toBeVisible();
      // Every visible item's refinements, with an Item column - the whole
      // difference from the scoped table above.
      await expect(workspaceDialog.getByRole('columnheader', { name: 'Item' })).toBeVisible();
      await expect(workspaceDialog.getByRole('cell', { name: NO_KEY }).first()).toBeVisible();
    });
  });
});
