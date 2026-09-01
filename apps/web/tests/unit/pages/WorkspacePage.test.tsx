import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Item, ItemStatus, WorkspaceSnapshot } from '@cockpit/shared';
import { WorkspacePage } from '../../../src/pages/WorkspacePage';

/**
 * F1: what the Inbox holds is a view over the snapshot evaluated in the
 * client, and the snapshot itself does not change here - there is no query to
 * prove against a database. Which items the server puts in the snapshot at all
 * (dismissed and tombstoned ones are left out) is proved in
 * apps/api/tests/integration against a real one.
 */
vi.mock('../../../src/router', () => ({
  inboxRoute: { useParams: () => ({ workspaceId: 'ws-work' }) },
}));

const held = vi.hoisted(() => ({ items: [] as Item[] }));

vi.mock('../../../src/api/queries', () => ({
  useCommand: () => ({ mutate: vi.fn(), isPending: false }),
  snapshotQuery: (workspaceId: string) => ({
    queryKey: ['snapshot', workspaceId],
    queryFn: (): Promise<WorkspaceSnapshot> =>
      Promise.resolve({
        workspace: { id: workspaceId, tenantId: 'tenant', name: 'Work', color: '#6f62b5', ground: '#e3e1f2', header: '#d2cdea' },
        items: held.items,
        dashboards: [],
        associations: [],
        generatedAt: '2026-08-31T09:00:00.000Z',
      } as WorkspaceSnapshot),
  }),
}));

let nextItem = 0;

function anItem(title: string, status: ItemStatus): Item {
  return {
    id: `11111111-1111-7111-8111-${String(nextItem++).padStart(12, '0')}`,
    tenantId: 'tenant',
    workspaceId: 'ws-work',
    source: 'internal',
    sourceId: null,
    sourceLink: null,
    sender: null,
    sourceTimestamp: null,
    title,
    preview: null,
    sourceResolvedAt: null,
    status,
    nextAction: null,
    focusHorizon: null,
    priority: null,
    dueDate: null,
    snoozedUntil: null,
    unseen: false,
    deletedAt: null,
    createdAt: '2026-08-31T08:00:00.000Z',
    updatedAt: '2026-08-31T08:00:00.000Z',
  };
}

/** The workspace as a person sees it, holding exactly these items. */
async function showWorkspace(items: Item[]) {
  held.items = items;
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <WorkspacePage />
    </QueryClientProvider>,
  );
  return screen.findByRole('region', { name: 'Inbox' });
}

describe('Triage', () => {
  describe('the Inbox holds every item you still have to deal with, and nothing you finished', () => {
    const situations = [
      { situation: 'an item still to process', status: 'to_process', shownAs: 'To process' },
      { situation: 'an item made a task', status: 'task', shownAs: 'Task' },
      { situation: 'an item set to waiting', status: 'waiting', shownAs: 'Waiting' },
      { situation: 'an item snoozed', status: 'snoozed', shownAs: 'Snoozed' },
      { situation: 'an item marked done', status: 'done', shownAs: null },
    ] satisfies { situation: string; status: ItemStatus; shownAs: string | null }[];

    it.each(situations)('$situation', async ({ status, shownAs }) => {
      const inbox = await showWorkspace([anItem('Buy milk', status)]);

      const row = within(inbox).queryByRole('listitem');
      if (shownAs === null) {
        expect(row).toBeNull();
        expect(screen.queryByText('Buy milk')).toBeNull();
      } else {
        expect(row).not.toBeNull();
        expect(within(row!).getByText('Buy milk')).toBeVisible();
        expect(within(row!).getByText(shownAs)).toBeVisible();
      }
    });
  });
});

describe('Capture', () => {
  describe('what you capture appears in the Inbox you captured it into', () => {
    it('offers the box as the first row of the Inbox, with the items under it', async () => {
      const inbox = await showWorkspace([anItem('Buy milk', 'to_process')]);

      const box = within(inbox).getByLabelText('Capture a note or to-do');
      const row = within(inbox).getByRole('listitem');
      expect(box.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });
  });
});
