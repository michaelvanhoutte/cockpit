import { capture, expect, itemRow, openInbox, press, test, uniqueTitle } from './support/app';

/**
 * F3, for the reason `text-learning-rules.test.ts` beside this file gives its
 * own walk: a menu leads to a window drawn over the workspace, and this one
 * has two doors into the same table rather than one ("See the history of
 * what Cockpit proposed for the Inbox's items", issue 444).
 *
 * **Never touches the real enrichment path**, the same rule `capture.test.ts`
 * states for the same cost reasons (money, non-determinism) - the e2e stack
 * runs with no `ANTHROPIC_API_KEY` (`scripts/e2e-stack.mjs`), so every
 * capture here settles, deterministically and for free, as the one outcome
 * that needs no model at all: Left as-is, "this environment has no
 * ANTHROPIC_API_KEY". What is walked is the two entry points and what each
 * one shows, not the write rules behind a real rewrite - those are
 * apps/api/tests/integration/http/rewrite-history.test.ts's own question,
 * against a real store.
 */
test.describe('Capture', () => {
  test.describe('what Cockpit attempted for an item is reachable from its own menu, and from the Inbox', () => {
    test('shows the same attempt scoped to the item, and again scoped to the workspace', async ({
      page,
      isMobile,
    }) => {
      await openInbox(page, isMobile);
      const title = uniqueTitle('call the plumber about the leak');
      await capture(page, title, isMobile);

      await press(itemRow(page, title).getByRole('button', { name: 'Item actions' }), isMobile);
      await press(page.getByRole('menuitem', { name: 'Rewrite history…' }), isMobile);
      const itemDialog = page.getByRole('dialog', { name: 'Rewrite history' });
      await expect(itemDialog).toBeVisible();
      await expect(itemDialog.getByText(title)).toBeVisible();
      await expect(itemDialog.getByText('Left as-is')).toBeVisible();
      // Scoped to this one item: no column naming which item each row is.
      await expect(itemDialog.getByRole('columnheader', { name: 'Item' })).toHaveCount(0);
      await press(itemDialog.getByRole('button', { name: 'Done' }), isMobile);
      await expect(itemDialog).not.toBeVisible();

      // The heading and its menu sit in the band above the Inbox's own
      // landmark, not inside it (Layout.tsx), so this is asked for on the
      // page rather than scoped to `inbox(page)`.
      await press(page.getByRole('button', { name: 'Actions for the Inbox' }), isMobile);
      await press(page.getByRole('menuitem', { name: 'Rewrite history…' }), isMobile);
      const workspaceDialog = page.getByRole('dialog', { name: 'Rewrite history' });
      await expect(workspaceDialog).toBeVisible();
      // Every visible item's records, with an Item column - the whole
      // difference from the scoped table above.
      await expect(workspaceDialog.getByRole('columnheader', { name: 'Item' })).toBeVisible();
      await expect(workspaceDialog.getByText(title)).toBeVisible();
    });
  });
});
