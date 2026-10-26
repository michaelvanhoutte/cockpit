import 'fake-indexeddb/auto';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { CommandResult, Item, WorkspaceSnapshot } from '@cockpit/shared';
import { changes } from '../../../src/api/changes';
import { fetchFinishedItems, fetchSnapshot, fetchWorkspaces, sendCommand } from '../../../src/api/client';
import { readForAnnouncement } from '../../../src/api/snapshotReads';
import { useSendCommand } from '../../../src/api/queries';
import AllItemsBoard from '../../../src/components/AllItemsBoard';
import { ItemForm } from '../../../src/components/ItemForm';
import { resetStanding } from '../../../src/offline';
import { UndoWhatJustHappened } from '../../../src/undo';

/**
 * A Workspace's finished Items, read for *All items* beside the Workspace's own
 * read, with the server holding the answers - the frontend-with-its-own-backend
 * level (F2), run in this runner as `ChangesAtOnce.test.tsx` is ("Fetch a
 * Workspace's finished Items the first time All items opens", issue 1434). The
 * screens, the queries, the tab's queue and its reads are the app's own and only
 * the network is replaced, by a server that keeps its Items and answers a read
 * with what it holds. **Its Workspace read carries open Items only**, so that a
 * finished Item can only reach the screen through the finished read: the merge
 * itself is tests/unit/finishedItems.test.ts, and what the read answers is
 * apps/api/tests/integration/http/finished-items.test.ts.
 */

const opened = vi.hoisted(() => ({ item: undefined as string | undefined, close: vi.fn() }));

vi.mock('../../../src/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/api/client')>()),
  fetchSnapshot: vi.fn(),
  fetchFinishedItems: vi.fn(),
  fetchWorkspaces: vi.fn(),
  sendCommand: vi.fn(),
}));

vi.mock('@tanstack/react-router', async () => ({
  ...(await vi.importActual<typeof import('@tanstack/react-router')>('@tanstack/react-router')),
  useNavigate: () => vi.fn(() => Promise.resolve()),
  useParams: () => ({ workspaceId: 'ws-work' }),
}));

vi.mock('../../../src/itemForm', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/itemForm')>()),
  useReportDocked: () => () => {},
  useQuietOpening: () => () => false,
  useSettleQuietOpening: () => () => {},
  useItemForm: () => ({ openItemId: opened.item, close: opened.close }),
  useOpenItem: () => (itemId: string) => {
    opened.item = itemId;
  },
  useDockedItem: () => ({ openId: null, show: () => {} }),
}));

/** The description's editor, as a box that takes text. */
vi.mock('../../../src/description/RichDescription', () => ({
  default: function FakeRichDescription({ initial }: { initial: string }) {
    const [value, setValue] = useState(initial);
    return <textarea aria-label="Description" value={value} onChange={(event) => setValue(event.target.value)} />;
  },
}));

function anItem(id: string, title: string, over: Partial<Item> = {}): Item {
  return {
    id,
    tenantId: 'tenant',
    workspaceId: 'ws-work',
    workspaceDecided: true,
    source: 'internal',
    sourceId: null,
    sourceLink: null,
    sender: null,
    sourceTimestamp: null,
    capturedMessage: null,
    capturedTimeZone: null,
    title,
    description: null,
    textsSettledAt: null,
    textsProposedAt: null,
    readings: null,
    proposedPanelId: null,
    proposedPanelReason: null,
    proposedPanelFit: null,
    claudeProposals: null,
    seriesId: null,
    waitingSince: null,
    sourceResolvedAt: null,
    nextAction: null,
    completedAt: null,
    startedAt: null,
    priority: null,
    prioritySetAt: null,
    dueDate: null,
    dueDateSetAt: null,
    dueDateChosenAt: null,
    unseen: false,
    deletedAt: null,
    createdAt: '2026-10-01T08:00:00.000Z',
    updatedAt: '2026-10-01T08:00:00.000Z',
    ...over,
  };
}

const finishedOn = (day: string, id: string, title: string) =>
  anItem(id, title, { completedAt: `${day}T09:00:00.000Z`, updatedAt: `${day}T09:00:00.000Z` });

/** Everything the server holds: its Workspace read is the open ones, its finished read the done ones. */
let stored: Item[];
/** How many times each read has been made. */
let reads: { workspace: number; finished: number };
/** Holds the finished read until the test lets it land, when set. */
let finishedGate: Promise<void> | null;
/** The server's own clock, which every change moves and every read says it is built on. */
let clock: number;

const stamp = () => `2026-10-20T10:00:${String(clock).padStart(2, '0')}.000Z`;

function theWorkspace(): WorkspaceSnapshot {
  return {
    workspace: { id: 'ws-work', tenantId: 'tenant', name: 'Work', color: '#6f62b5', bar: '#dbd7ee', ground: '#e3e1f2', header: '#d2cdea' },
    items: stored.filter((item) => item.completedAt === null),
    dashboards: [],
    panels: [],
    layouts: [],
    associations: [],
    attachments: [],
    itemFormPresentation: 'centered',
    followUpDays: 3,
    duplicates: [],
    filings: [],
    agentRuns: [],
    generatedAt: '2026-10-20T09:00:00.000Z',
    upTo: stamp(),
  } as unknown as WorkspaceSnapshot;
}

let client: QueryClient;

function theBoard() {
  return (
    <QueryClientProvider client={client}>
      <AllItemsBoard workspaceId="ws-work" />
    </QueryClientProvider>
  );
}

/** What a Done Item's form sends to reopen it, from a control of the test's own: the form's wiring is ItemForm.test.tsx. */
function Reopen({ itemId }: { itemId: string }) {
  const send = useSendCommand();
  return (
    <button
      type="button"
      onClick={() => void send({ name: 'set_done', payload: { commandId: 'c-1', issuedAt: '2026-10-20T10:30:00.000Z', workspaceId: 'ws-work', itemId, done: false } })}
    >
      Reopen
    </button>
  );
}

const rowOf = (id: string) => document.querySelector<HTMLElement>(`[data-item-id="${id}"]`);
const statusOf = (id: string) => within(rowOf(id)!).getAllByRole('cell')[1]?.textContent;
const titles = () => screen.queryAllByRole('row').slice(1).map((row) => within(row).getAllByRole('cell')[0]?.textContent);

/** The server answers the change it is holding. */
let waiting: { answer: () => void }[];

beforeEach(() => {
  localStorage.clear();
  resetStanding();
  stored = [anItem('open-1', 'Reply to Bart'), finishedOn('2026-09-01', 'old-1', 'Pay the September invoice')];
  reads = { workspace: 0, finished: 0 };
  finishedGate = null;
  clock = 1;
  waiting = [];
  opened.item = undefined;
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.mocked(fetchWorkspaces).mockResolvedValue({ workspaces: [] } as never);
  vi.mocked(fetchSnapshot).mockImplementation(async () => {
    reads.workspace += 1;
    return theWorkspace();
  });
  vi.mocked(fetchFinishedItems).mockImplementation(async () => {
    reads.finished += 1;
    const answer = { items: stored.filter((item) => item.completedAt !== null), filings: [], attachments: [], upTo: stamp() };
    await finishedGate;
    return answer;
  });
  vi.mocked(sendCommand).mockImplementation(
    (_name, payload) =>
      new Promise<CommandResult>((resolve) => {
        waiting.push({
          answer: () => {
            const { itemId, done, issuedAt } = payload as { itemId: string; done: boolean; issuedAt: string };
            clock += 1;
            stored = stored.map((item) => (item.id === itemId ? { ...item, completedAt: done ? issuedAt : null, updatedAt: issuedAt } : item));
            resolve({ ok: true, applied: true, at: stamp() });
          },
        });
      }),
  );
});

afterEach(async () => {
  cleanup();
  resetStanding();
  await act(async () => waiting.splice(0).forEach((request) => request.answer()));
  changes.forgetAnswered();
});

/** Another device marks this Item done, and the server announces it. */
async function doneElsewhere(itemId: string) {
  clock += 1;
  stored = stored.map((item) => (item.id === itemId ? { ...item, completedAt: '2026-10-20T10:20:00.000Z', updatedAt: '2026-10-20T10:20:00.000Z' } : item));
  await act(async () => readForAnnouncement(client, { type: 'snapshot_invalidated', workspaceId: 'ws-work', at: stamp() }));
}

describe('Dashboards', () => {
  describe('All items fetches the finished Items once per tab and draws them with the open ones', () => {
    it('reads them the first time it opens, saying so while they arrive, then draws them beside the open ones', async () => {
      let arrive: () => void = () => {};
      finishedGate = new Promise<void>((resolve) => {
        arrive = resolve;
      });
      render(theBoard());

      expect(await screen.findByRole('status')).toHaveTextContent('Loading finished items…');
      expect(titles()).toEqual(['Reply to Bart']);
      await act(async () => arrive());

      await waitFor(() => expect(titles()).toEqual(['Reply to Bart', 'Pay the September invoice']));
      expect(statusOf('old-1')).toBe('Done');
      expect(reads.finished).toBe(1);
    });

    it('reads nothing more for a second opening in the same tab', async () => {
      const first = render(theBoard());
      await waitFor(() => expect(titles()).toHaveLength(2));
      first.unmount();

      render(theBoard());

      await waitFor(() => expect(titles()).toHaveLength(2));
      expect(reads.finished).toBe(1);
    });
  });

  describe('the finished copy stays current', () => {
    it('lists an Item marked Done elsewhere, once the announcement has been read for, while All items is on screen', async () => {
      render(theBoard());
      await waitFor(() => expect(titles()).toHaveLength(2));
      expect(statusOf('open-1')).toBe('To do');

      await doneElsewhere('open-1');

      await waitFor(() => expect(statusOf('open-1')).toBe('Done'));
      expect(reads).toEqual({ workspace: 2, finished: 2 });
    });

    it('reads the finished Items on the next opening, and not at the announcement, when All items is not on screen', async () => {
      const first = render(theBoard());
      await waitFor(() => expect(titles()).toHaveLength(2));
      first.unmount();

      await doneElsewhere('open-1');
      expect(reads.finished).toBe(1);

      render(theBoard());

      await waitFor(() => expect(statusOf('open-1')).toBe('Done'));
      expect(reads.finished).toBe(2);
    });

    it('reads no finished Items for an announcement before All items was ever opened', async () => {
      await doneElsewhere('open-1');

      expect(reads.finished).toBe(0);
    });
  });

  describe('a change to a finished Item shows at once', () => {
    it('reads To do on a Done Item’s row the moment it is reopened, before the server has answered', async () => {
      render(
        <QueryClientProvider client={client}>
          <Reopen itemId="old-1" />
          <AllItemsBoard workspaceId="ws-work" />
        </QueryClientProvider>,
      );
      await waitFor(() => expect(statusOf('old-1')).toBe('Done'));

      act(() => screen.getByRole('button', { name: 'Reopen' }).click());

      await waitFor(() => expect(statusOf('old-1')).toBe('To do'));
      expect(waiting).toHaveLength(1);
    });

    it('goes on reading To do after the answer, once the Workspace and the finished Items have been read again', async () => {
      render(
        <QueryClientProvider client={client}>
          <Reopen itemId="old-1" />
          <AllItemsBoard workspaceId="ws-work" />
        </QueryClientProvider>,
      );
      await waitFor(() => expect(statusOf('old-1')).toBe('Done'));
      act(() => screen.getByRole('button', { name: 'Reopen' }).click());
      await waitFor(() => expect(waiting).toHaveLength(1));

      await act(async () => waiting.shift()!.answer());

      await waitFor(() => expect(reads).toEqual({ workspace: 2, finished: 2 }));
      expect(statusOf('old-1')).toBe('To do');
      expect(titles()).toHaveLength(2);
    });
  });

  describe('an address names an Item the Workspace read does not hold', () => {
    const theForm = () => (
      <QueryClientProvider client={client}>
        <UndoWhatJustHappened>
          <ItemForm />
        </UndoWhatJustHappened>
      </QueryClientProvider>
    );

    it('opens the form of a finished Item after the finished read, saying it is opening until then', async () => {
      let arrive: () => void = () => {};
      finishedGate = new Promise<void>((resolve) => {
        arrive = resolve;
      });
      opened.item = 'old-1';
      render(theForm());

      await waitFor(() => expect(reads.finished).toBe(1));
      expect(screen.getByText('Opening…')).toBeInTheDocument();
      expect(screen.queryByText('That item is not here any more.')).toBeNull();
      await act(async () => arrive());

      expect(await screen.findByDisplayValue('Pay the September invoice')).toBeInTheDocument();
    });

    it('says the Item is not here any more only after the finished read, for an Item in neither read', async () => {
      opened.item = 'nowhere';
      render(theForm());

      expect(await screen.findByText('That item is not here any more.')).toBeInTheDocument();
      expect(reads.finished).toBe(1);
    });

    it('reads no finished Items for an Item the Workspace read holds', async () => {
      opened.item = 'open-1';
      render(theForm());

      expect(await screen.findByDisplayValue('Reply to Bart')).toBeInTheDocument();
      expect(reads.finished).toBe(0);
    });
  });
});
