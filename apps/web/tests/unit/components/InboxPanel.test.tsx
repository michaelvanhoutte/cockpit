import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Filing, Item, WorkspaceSnapshot } from '@cockpit/shared';
import { InboxPanel } from '../../../src/components/InboxPanel';

/**
 * F1: what the Inbox holds is a view over the snapshot evaluated in the
 * client, and the snapshot itself does not change here - there is no query to
 * prove against a database. Which items the server puts in the snapshot at all
 * (dismissed and tombstoned ones are left out) is proved in
 * apps/api/tests/integration against a real one.
 *
 * It is asked of the Inbox itself rather than of a screen, because the Inbox is
 * rendered in two places now - a column beside the dashboards, and a screen of
 * its own on a narrow one ("Show the Inbox beside the dashboards instead of as
 * a tab", issue 117) - and what it holds cannot depend on which. Which of the
 * two a workspace shows is in tests/unit/router.test.tsx.
 */
const held = vi.hoisted(() => ({ items: [] as Item[], filings: [] as Filing[] }));

vi.mock('../../../src/api/queries', () => ({
  useCommand: () => ({ mutate: vi.fn(), reset: vi.fn(), isPending: false, error: null }),
  useSendCommand: () => vi.fn(() => Promise.resolve()),
  // Read by the picker inside the list, for the Inboxes it offers an item
  // that belongs to no workspace. Nothing here opens it, so it is empty.
  workspacesQuery: {
    queryKey: ['workspaces'],
    queryFn: () => Promise.resolve({ workspaces: [] }),
  },
  // Only read while a run of filings is in flight, which nothing here starts.
  useLatestSnapshot: () => () => Promise.resolve({ filings: [] }),
  snapshotQuery: (workspaceId: string) => ({
    queryKey: ['snapshot', workspaceId],
    queryFn: (): Promise<WorkspaceSnapshot> =>
      Promise.resolve({
        workspace: { id: workspaceId, tenantId: 'tenant', name: 'Work', color: '#6f62b5', bar: '#dbd7ee', ground: '#e3e1f2', header: '#d2cdea' },
        items: held.items,
        dashboards: [],
        panels: [],
        layouts: [],
        associations: [],
        itemTypes: [],
        filings: held.filings,
        generatedAt: '2026-08-31T09:00:00.000Z',
      } as WorkspaceSnapshot),
  }),
}));

let nextItem = 0;

function anItem(title: string, completedAt: string | null = null): Item {
  return {
    id: `11111111-1111-7111-8111-${String(nextItem++).padStart(12, '0')}`,
    tenantId: 'tenant',
    workspaceId: 'ws-work',
    workspaceDecided: true,
    source: 'internal',
    sourceId: null,
    sourceLink: null,
    sender: null,
    sourceTimestamp: null,
    title,
    preview: null,
    sourceResolvedAt: null,
    typeId: null,
    nextAction: null,
    completedAt,
    priority: null,
    dueDate: null,
    unseen: false,
    deletedAt: null,
    createdAt: '2026-08-31T08:00:00.000Z',
    updatedAt: '2026-08-31T08:00:00.000Z',
  };
}

/** The workspace as a person sees it, holding exactly these items. */
async function showWorkspace(items: Item[], filings: Filing[] = []) {
  held.items = items;
  held.filings = filings;
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <InboxPanel workspaceId="ws-work" />
    </QueryClientProvider>,
  );
  return screen.findByRole('region', { name: 'Inbox' });
}

describe('Triage', () => {
  describe('the Inbox holds every item you still have to deal with, and nothing you finished', () => {
    it.each([
      { situation: 'an item you still have to deal with', finished: null, shown: true },
      {
        situation: 'an item you are finished with',
        finished: '2026-08-31T09:00:00.000Z',
        shown: false,
      },
    ])('$situation', async ({ finished, shown }) => {
      const inbox = await showWorkspace([anItem('Buy milk', finished)]);

      const row = within(inbox).queryByRole('listitem');
      if (shown) {
        expect(row).not.toBeNull();
        expect(within(row!).getByText('Buy milk')).toBeVisible();
      } else {
        expect(row).toBeNull();
        expect(screen.queryByText('Buy milk')).toBeNull();
      }
    });
  });
});

describe('Panels', () => {
  describe('the Inbox holds every item you still have to deal with that is filed nowhere', () => {
    it('leaves out an item that is filed on a panel, and stops counting it', async () => {
      const filed = anItem('Reply to Bart');
      const loose = anItem('Buy milk');

      const inbox = await showWorkspace([filed, loose], [
        { panelId: 'p-falcon', itemId: filed.id, position: 0 },
      ]);

      expect(within(inbox).queryByText('Reply to Bart')).toBeNull();
      expect(within(inbox).getByText('Buy milk')).toBeVisible();
      expect(within(inbox).getByText('1')).toBeVisible();
    });
  });
});

describe('Capture', () => {
  describe('what you capture appears in the Inbox you captured it into', () => {
    it('offers the box as the first row of the Inbox, with the items under it', async () => {
      const inbox = await showWorkspace([anItem('Buy milk')]);

      const box = within(inbox).getByLabelText('Capture a note or to-do');
      const row = within(inbox).getByRole('listitem');
      expect(box.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });
  });
});
