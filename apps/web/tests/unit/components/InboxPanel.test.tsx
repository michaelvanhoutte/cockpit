import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Filing, Item, WorkspaceSnapshot } from '@cockpit/shared';
import { InboxHeading, InboxPanel } from '../../../src/components/InboxPanel';

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
 *
 * The name and the count are a component of their own, because on a wide screen
 * they are drawn in the dashboard band rather than over the column ("Cockpit
 * Shell Explorations", artboard 2c). Both are rendered here, which is the pair
 * a person actually sees; that the shell puts them in the two places is in
 * tests/unit/pages/Layout.test.tsx.
 */
const held = vi.hoisted(() => ({ items: [] as Item[], filings: [] as Filing[] }));

vi.mock('../../../src/api/queries', () => ({
  useCommand: () => ({ mutate: vi.fn(), reset: vi.fn(), isPending: false, error: null }),
  useSendCommand: () => vi.fn(() => Promise.resolve()),
  // An Inbox row takes no agent, so nothing here starts one.
  useStartAgent: () => ({ mutateAsync: () => Promise.resolve() }),
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
        attachments: [],
        itemTypes: [],
    itemFormPresentation: 'centered',
    duplicates: [],
        filings: held.filings,
        agents: [],
        hiddenAgents: [],
        hasClaudeCodeConnection: false,
        agentRuns: [],
        claudeCodeFailing: null,
        generatedAt: '2026-08-31T09:00:00.000Z',
      } as WorkspaceSnapshot),
  }),
  // Read by the Inbox heading's own "What Cockpit changed…" entry: one
  // refinement, saying which query it came from.
  rewriteHistoryForWorkspaceQuery: (workspaceId: string) => ({
    queryKey: ['rewriteHistory', 'workspace', workspaceId],
    queryFn: () =>
      Promise.resolve({
        entries: [
          {
            id: 'refinement-1',
            itemId: '11111111-1111-7111-8111-000000000099',
            titleBefore: 'call ann',
            titleAfter: null,
            descriptionBefore: null,
            descriptionAfter: null,
            proposedPanelName: null,
            status: 'left-as-is',
            message: `read across ${workspaceId}`,
            attemptedAt: '2026-10-01T09:00:00.000Z',
            looksAt: 'texts-and-panel',
            suggestedPanelBefore: null,
            suggestedPanelAfter: null,
          },
        ],
      }),
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
    capturedMessage: null,
    description: null,
    textsSettledAt: null,
    textsProposedAt: null,
    readings: null,
    proposedPanelId: null,
    proposedPanelReason: null,
    sourceResolvedAt: null,
    typeId: null,
    nextAction: null,
    completedAt,
    startedAt: null,
    priority: null,
    dueDate: null,
    dueDateSetAt: null,
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
  const { container } = render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <InboxHeading workspaceId="ws-work" />
      <InboxPanel workspaceId="ws-work" />
    </QueryClientProvider>,
  );
  // The heading is up before the snapshot, on no data at all: the panel is
  // drawn once it has arrived.
  await waitFor(() => expect(screen.queryByText('Loading…')).toBeNull());
  return container;
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

describe('Onboarding', () => {
  describe('the Inbox says nothing about how to file, whatever has been filed', () => {
    it.each([
      { situation: 'it holds something and nothing has been filed', filedToo: false },
      { situation: 'it holds something and something has been filed elsewhere', filedToo: true },
    ])('when $situation', async ({ filedToo }) => {
      const filed = anItem('Reply to Bart');
      const loose = anItem('Buy milk');

      const inbox = await showWorkspace(
        filedToo ? [filed, loose] : [loose],
        filedToo ? [{ panelId: 'p-falcon', itemId: filed.id, position: 0 }] : [],
      );

      expect(within(inbox).getByText('Buy milk')).toBeVisible();
      expect(within(inbox).queryByText(/to file it/)).toBeNull();
    });
  });
});

describe('Capture', () => {
  describe('the header is the only way in to capturing', () => {
    it('has no note box and no capture button in the Inbox', async () => {
      const inbox = await showWorkspace([anItem('Buy milk')]);

      expect(within(inbox).queryByLabelText('Capture a note or to-do')).toBeNull();
      expect(within(inbox).queryByRole('button', { name: 'Capture' })).toBeNull();
    });
  });
});

describe('What Cockpit changed', () => {
  describe('is named for what it is wherever a person meets it, and an item row has no entry for it', () => {
    it("opens the Inbox's own changes from the Inbox menu, in a window of the same name", async () => {
      const user = userEvent.setup();
      await showWorkspace([anItem('Buy milk')]);

      await user.click(screen.getByRole('button', { name: 'Actions for the Inbox' }));
      await user.click(await screen.findByRole('menuitem', { name: 'What Cockpit changed…' }));

      const dialog = await screen.findByRole('dialog', { name: 'What Cockpit changed' });
      expect(await within(dialog).findByText('Read across ws-work')).toBeVisible();
      expect(within(dialog).getByRole('columnheader', { name: 'Item' })).toBeVisible();
    });
  });
});
