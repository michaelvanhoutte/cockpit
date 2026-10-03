import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { RewriteHistoryEntry } from '@cockpit/shared';
import { SmartRefinementsWindow } from '../../../src/components/SmartRefinementsWindow';

/**
 * F1: what the Cockpit's suggestions window draws from the rows it is handed
 * ("Rename Rewrite history to Smart refinements, and show each field's
 * change", issue 614). Which rows a refinement records, and what it records
 * in them, is apps/api/tests/integration/http/rewrite-history.test.ts against
 * a real store; that the window is reached from both menus is
 * tests/unit/components/InboxPanel.test.tsx and ItemRow.test.tsx.
 */
const held = vi.hoisted(() => ({ entries: [] as RewriteHistoryEntry[] }));

vi.mock('../../../src/api/queries', () => ({
  rewriteHistoryForWorkspaceQuery: (workspaceId: string) => ({
    queryKey: ['rewriteHistory', 'workspace', workspaceId],
    queryFn: () => Promise.resolve({ entries: held.entries }),
  }),
  rewriteHistoryForItemQuery: (itemId: string) => ({
    queryKey: ['rewriteHistory', 'item', itemId],
    queryFn: () => Promise.resolve({ entries: held.entries }),
  }),
}));

const ITEM_ID = '11111111-1111-7111-8111-000000000001';
const COMPLIANCE = { id: 'p-compliance', name: 'Compliance', dashboardName: 'Day to day' };
const VALIDATION = { id: 'p-validation', name: 'Validation', dashboardName: 'Quality' };

let nextId = 0;

/** A capture's refinement that changed nothing, unless told otherwise. */
function aRefinement(overrides: Partial<RewriteHistoryEntry> = {}): RewriteHistoryEntry {
  nextId += 1;
  return {
    id: `refinement-${nextId}`,
    itemId: ITEM_ID,
    titleBefore: 'call ann re q3 numbers',
    titleAfter: null,
    descriptionBefore: 'call ann re q3 numbers',
    descriptionAfter: null,
    proposedPanelName: null,
    status: 'rewritten',
    message: 'proposed in English',
    attemptedAt: '2026-10-01T09:00:00.000Z',
    looksAt: 'texts-and-panel',
    suggestedPanelBefore: null,
    suggestedPanelAfter: null,
    ...overrides,
  };
}

/** The window as a person opens it - from an item's menu where `fromAnItem`, else from the Inbox's. */
async function openWith(entries: RewriteHistoryEntry[], { fromAnItem = true } = {}) {
  held.entries = entries;
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <SmartRefinementsWindow
        open
        onClose={() => {}}
        workspaceId="ws-work"
        {...(fromAnItem ? { itemId: ITEM_ID } : {})}
      />
    </QueryClientProvider>,
  );
  const dialog = await screen.findByRole('dialog', { name: "Cockpit's suggestions" });
  if (entries.length > 0) await within(dialog).findByRole('table');
  return dialog;
}

/** The one refinement's own row, below the heading. */
function theRow(dialog: HTMLElement): HTMLElement {
  return within(dialog).getAllByRole('row')[1]!;
}

/** Opens the one refinement, and answers its lines as the field each names and what it says. */
async function openTheRow(dialog: HTMLElement) {
  await userEvent.setup().click(within(dialog).getByRole('button', { name: 'Show what changed' }));
  const list = within(dialog).getByLabelText('What changed');
  return within(list)
    .getAllByRole('term')
    .map((term) => ({ field: term.textContent, says: term.nextElementSibling as HTMLElement }));
}

describe("Cockpit's suggestions", () => {
  describe('closed, a row says when, why and what happened in one sentence, and only a row that changed something opens', () => {
    it.each([
      {
        situation: 'one field changed',
        entry: aRefinement({ titleAfter: 'Call Ann about the Q3 numbers' }),
        says: 'Changed the title',
        opens: true,
      },
      {
        situation: 'two fields changed',
        entry: aRefinement({ titleAfter: 'Call Ann', descriptionAfter: 'Call Ann about the Q3 numbers.' }),
        says: 'Changed the title and description',
        opens: true,
      },
      {
        situation: 'three fields changed',
        entry: aRefinement({
          titleAfter: 'Call Ann',
          descriptionAfter: 'Call Ann about the Q3 numbers.',
          suggestedPanelAfter: COMPLIANCE,
        }),
        says: 'Changed the title, description and suggested panel',
        opens: true,
      },
      {
        situation: 'rewritten, every field identical',
        entry: aRefinement({
          titleAfter: 'call ann re q3 numbers',
          descriptionAfter: 'call ann re q3 numbers',
          suggestedPanelBefore: COMPLIANCE,
          suggestedPanelAfter: COMPLIANCE,
        }),
        says: 'Nothing changed',
        opens: false,
      },
      {
        situation: 'failed',
        entry: aRefinement({ status: 'failed', message: '429 rate_limit_error' }),
        says: 'Failed: 429 rate_limit_error',
        opens: false,
      },
      {
        situation: 'still working',
        entry: aRefinement({ status: 'pending', message: null }),
        says: 'Working on it…',
        opens: false,
      },
      {
        situation: 'left as it is',
        entry: aRefinement({ status: 'left-as-is', message: 'nothing was proposed: the note says nothing to act on' }),
        says: 'Nothing was proposed: the note says nothing to act on',
        opens: false,
      },
    ])('$situation', async ({ entry, says, opens }) => {
      const dialog = await openWith([entry]);

      const row = theRow(dialog);
      expect(within(row).getByText(says)).toBeVisible();
      expect(within(row).queryByRole('button', { name: 'Show what changed' }) !== null).toBe(opens);
    });

    it.each([
      { situation: 'captured', looksAt: 'texts-and-panel' as const, why: 'When you captured it' },
      { situation: 'another item edited', looksAt: 'texts' as const, why: 'After you edited another item' },
      { situation: 'another item filed', looksAt: 'panel' as const, why: 'After you filed another item' },
    ])('says why: $situation', async ({ looksAt, why }) => {
      const dialog = await openWith([aRefinement({ looksAt })]);

      expect(within(theRow(dialog)).getByText(why)).toBeVisible();
    });

    it.each([
      { situation: 'opened from the Inbox', fromAnItem: false, itemColumn: true, says: 'How Cockpit refined the items in this Inbox, and when.' },
      { situation: 'opened from an item', fromAnItem: true, itemColumn: false, says: 'How Cockpit refined this item, and when.' },
    ])('$situation', async ({ fromAnItem, itemColumn, says }) => {
      const dialog = await openWith([aRefinement()], { fromAnItem });

      expect(within(dialog).getByText(says)).toBeVisible();
      expect(within(dialog).queryByRole('columnheader', { name: 'Item' }) !== null).toBe(itemColumn);
      expect(within(dialog).queryByText(ITEM_ID) !== null).toBe(itemColumn);
    });

    it('says nothing has been refined where nothing has', async () => {
      const dialog = await openWith([]);

      expect(await within(dialog).findByText('Nothing refined for this item yet.')).toBeVisible();
    });
  });

  describe('opened, a refinement lists one line per field it looked at, marked changed or unchanged, and leaves out the fields it did not look at', () => {
    it('strikes through what a changed field was, then gives what it became', async () => {
      const dialog = await openWith([aRefinement({ titleAfter: 'Call Ann about the Q3 numbers' })]);

      const [title] = await openTheRow(dialog);
      expect(title!.field).toBe('Title');
      expect(within(title!.says).getByRole('deletion')).toHaveTextContent('call ann re q3 numbers');
      expect(within(title!.says).getByRole('insertion')).toHaveTextContent('Call Ann about the Q3 numbers');
    });

    it('gives a field whose text came back identical as unchanged', async () => {
      const dialog = await openWith([
        aRefinement({ titleAfter: 'Call Ann', descriptionAfter: 'call ann re q3 numbers' }),
      ]);

      const [, description] = await openTheRow(dialog);
      expect(description!.field).toBe('Description');
      expect(description!.says).toHaveTextContent('call ann re q3 numbers · unchanged');
      expect(within(description!.says).queryByRole('deletion')).toBeNull();
    });

    it('says None for a description that was empty before', async () => {
      const dialog = await openWith([
        aRefinement({ descriptionBefore: null, descriptionAfter: 'Call Ann about the Q3 numbers.' }),
      ]);

      const [, description] = await openTheRow(dialog);
      expect(within(description!.says).getByRole('deletion')).toHaveTextContent('None');
      expect(within(description!.says).getByRole('insertion')).toHaveTextContent('Call Ann about the Q3 numbers.');
    });

    it('lists only the suggested panel for a refresh after a filing', async () => {
      const dialog = await openWith([
        aRefinement({ looksAt: 'panel', suggestedPanelBefore: COMPLIANCE, suggestedPanelAfter: VALIDATION }),
      ]);

      const lines = await openTheRow(dialog);
      expect(lines.map((line) => line.field)).toEqual(['Suggested panel']);
      expect(within(lines[0]!.says).getByRole('deletion')).toHaveTextContent('Day to day ▸ Compliance');
      expect(within(lines[0]!.says).getByRole('insertion')).toHaveTextContent('Quality ▸ Validation');
    });

    it('names a suggested panel deleted since as a deleted panel', async () => {
      const dialog = await openWith([
        aRefinement({ looksAt: 'panel', suggestedPanelBefore: { id: 'p-gone', name: null, dashboardName: null }, suggestedPanelAfter: null }),
      ]);

      const [panel] = await openTheRow(dialog);
      expect(within(panel!.says).getByRole('deletion')).toHaveTextContent('a deleted panel');
      expect(within(panel!.says).getByRole('insertion')).toHaveTextContent('None');
    });
  });

  describe('a row recorded before this shipped shows what it has and says what it lacks', () => {
    it('gives no reason why, its title change as recorded, and the suggested panel as not recorded', async () => {
      const dialog = await openWith([
        aRefinement({ looksAt: null, titleAfter: 'Call Ann about the Q3 numbers', proposedPanelName: 'Compliance' }),
      ]);

      const row = theRow(dialog);
      expect(within(row).getByText('Changed the title')).toBeVisible();
      for (const why of ['When you captured it', 'After you edited another item', 'After you filed another item']) {
        expect(within(row).queryByText(why)).toBeNull();
      }
      const lines = await openTheRow(dialog);
      expect(lines.map((line) => line.field)).toEqual(['Title', 'Description', 'Suggested panel']);
      expect(within(lines[0]!.says).getByRole('insertion')).toHaveTextContent('Call Ann about the Q3 numbers');
      expect(lines[2]!.says).toHaveTextContent('not recorded');
    });
  });
});
