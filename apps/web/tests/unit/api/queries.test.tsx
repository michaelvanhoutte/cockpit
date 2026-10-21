import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, focusManager, useQuery } from '@tanstack/react-query';
import userEvent from '@testing-library/user-event';
import type { Item, WorkspaceSnapshot } from '@cockpit/shared';
import {
  accountHoldingsQuery,
  snapshotQuery,
  useCommand,
  useLatestSnapshot,
  type CommandArgs,
} from '../../../src/api/queries';
import { fetchAccountHoldings, fetchSnapshot, sendCommand } from '../../../src/api/client';
import { ItemForm } from '../../../src/components/ItemForm';
import { changes } from '../../../src/api/changes';

/**
 * F1, and deliberately not a browser test: whether a screen refreshes itself
 * when you come back to it is decided by the query options this app declares,
 * and the library exposes the "you are back" signal directly. Driving that
 * signal is the real code path. Going through a browser instead means
 * emulating tab visibility, which three separate attempts showed cannot be
 * produced reliably from a test harness — two of them returned a confident
 * null result for a transition that never actually happened.
 *
 * Only the read is replaced, at the edge. The query's own options — including
 * the staleness window this rule is about — are the app's real ones.
 */
vi.mock('../../../src/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/api/client')>()),
  fetchSnapshot: vi.fn(),
  sendCommand: vi.fn(),
  fetchAccountHoldings: vi.fn(),
}));

const reads = vi.mocked(fetchSnapshot);
const sends = vi.mocked(sendCommand);
const holds = vi.mocked(fetchAccountHoldings);

/**
 * The item's form is rendered for real by the last rule here, because what it
 * is about is the form and the copy it is filled from together. Only the two
 * things it reaches outside this file are replaced: the address it is opened
 * and closed by, and its 115KB editor.
 */
const opened = vi.hoisted(() => ({ item: undefined as string | undefined }));

vi.mock('@tanstack/react-router', () => ({ useParams: () => ({ workspaceId: 'ws-work' }) }));

vi.mock('../../../src/itemForm', () => ({
  useReportDocked: () => () => {},
  useQuietOpening: () => () => false,
  useSettleQuietOpening: () => () => {},
  useItemForm: () => ({
    openItemId: opened.item,
    close: () => {
      opened.item = undefined;
    },
  }),
  // The form reaches for this to open a note it may be repeating ("Flag a
  // captured note that says what another one already said", issue 407);
  // nothing in this file draws one, so it only has to exist.
  useOpenItem: () => (itemId: string) => {
    opened.item = itemId;
  },
}));

vi.mock('../../../src/description/RichDescription', () => ({
  default: ({
    initial,
    onChange,
    editable,
  }: {
    initial: string;
    onChange: (markdown: string) => void;
    editable: boolean;
  }) => (
    <textarea
      aria-label="Description"
      disabled={!editable}
      value={initial}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
}));

const snapshot: WorkspaceSnapshot = {
  workspace: { id: 'ws-work', tenantId: 'tenant', name: 'Work', color: '#6f62b5', bar: '#dbd7ee', ground: '#e3e1f2', header: '#d2cdea' },
  items: [],
  dashboards: [],
  panels: [],
  layouts: [],
  associations: [],
  attachments: [],
    itemFormPresentation: 'centered',
    duplicates: [],
  filings: [],
  agentRuns: [],
  generatedAt: '2026-08-31T10:00:00.000Z',
};

function WorkspaceScreen() {
  const { data } = useQuery(snapshotQuery('ws-work'));
  return <p>{data ? 'showing the workspace' : 'still loading'}</p>;
}

async function openTheScreen() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <WorkspaceScreen />
    </QueryClientProvider>,
  );
  await screen.findByText('showing the workspace');
}

beforeEach(() => {
  reads.mockReset();
  sends.mockReset();
  reads.mockResolvedValue(snapshot);
  // Which item's form is open outlives the test that opened one, and a form
  // left open would be drawn by the next test to render anything.
  opened.item = undefined;
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
  // The manual focus state outlives the test that set it.
  focusManager.setFocused(undefined);
  // A saved text stays drawn until a read covers it; the next test starts without it.
  changes.forgetAnswered();
});

describe('Deleting', () => {
  describe('the question about deleting somebody never answers from an earlier count', () => {
    /**
     * **The bug this is here for.** The count was served from the copy kept
     * since the question was last asked, drawn - and answerable - before the
     * fresh one landed; after deleting somebody and adding a person under the
     * same name, that copy was the previous person's.
     */
    it('knows nothing of the count until it has been asked again', async () => {
      holds.mockReset();
      holds.mockResolvedValueOnce({ workspaces: 3, empty: false });
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      function Question() {
        const { data } = useQuery(accountHoldingsQuery('user-ada'));
        return <p>{data ? `${data.workspaces} workspaces` : 'not known yet'}</p>;
      }

      const first = render(
        <QueryClientProvider client={client}>
          <Question />
        </QueryClientProvider>,
      );
      await screen.findByText('3 workspaces');
      first.unmount();
      // A moment between closing the question and asking it again, and the
      // second answer still out when it opens.
      await vi.advanceTimersByTimeAsync(10);
      holds.mockReturnValueOnce(new Promise(() => {}));
      render(
        <QueryClientProvider client={client}>
          <Question />
        </QueryClientProvider>,
      );

      expect(screen.getByText('not known yet')).toBeVisible();
    });
  });
});

describe('Offline', () => {
  describe('coming back to Cockpit brings a screen that has gone stale up to date', () => {
    it('reads the workspace again when you return to it after it has aged', async () => {
      await openTheScreen();
      expect(reads).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(20_000);
      focusManager.setFocused(true);

      await waitFor(() => expect(reads).toHaveBeenCalledTimes(2));
    });

    it('leaves a screen that is still fresh alone', async () => {
      await openTheScreen();

      await vi.advanceTimersByTimeAsync(5_000);
      focusManager.setFocused(true);
      await vi.advanceTimersByTimeAsync(1_000);

      expect(reads).toHaveBeenCalledTimes(1);
    });
  });
});

/** A control that asks for one change, so a click drives the real mutation. */
function Change({ args }: { args: CommandArgs }) {
  const command = useCommand();
  return (
    <button type="button" onClick={() => command.mutate(args)}>
      go
    </button>
  );
}

const AT = '2026-08-31T10:00:00.000Z';

describe('Workspace management', () => {
  describe('what a deleted workspace held is not kept to be shown again', () => {
    it.each([
      {
        situation: 'a workspace that was deleted, whose contents are gone for good',
        args: {
          name: 'delete_workspace',
          payload: { commandId: 'c1', issuedAt: AT, workspaceId: 'ws-work' },
        },
        keptAfterwards: false,
      },
      {
        // The other half of the branch: everything else still has a workspace
        // to re-read, so its copy is marked stale rather than thrown away.
        situation: 'a workspace that was renamed, which is still there to re-read',
        args: {
          name: 'rename_workspace',
          payload: { commandId: 'c2', issuedAt: AT, workspaceId: 'ws-work', name: 'Accounts' },
        },
        keptAfterwards: true,
      },
    ] as { situation: string; args: CommandArgs; keptAfterwards: boolean }[])(
      '$situation',
      async ({ args, keptAfterwards }) => {
        sends.mockResolvedValue({ ok: true, applied: true });
        const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
        // What the person was last shown of that workspace, the way a week-long
        // stored copy holds it (main.tsx).
        client.setQueryData(['snapshot', 'ws-work'], snapshot);
        // The suite runs on fake timers; userEvent needs to drive them or its
        // own waits never elapse.
        const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
        render(
          <QueryClientProvider client={client}>
            <Change args={args} />
          </QueryClientProvider>,
        );

        await user.click(screen.getByRole('button', { name: 'go' }));

        await waitFor(() => expect(sends).toHaveBeenCalledTimes(1));
        await waitFor(() =>
          expect(client.getQueryData(['snapshot', 'ws-work']) !== undefined).toBe(keptAfterwards),
        );
      },
    );
  });
});

describe('Panels', () => {
  describe('one change after another sends what the one before it left behind', () => {
    /**
     * The re-read is held open rather than resolved at once, which is what
     * makes these able to fail: with both reads instant, waiting for the
     * re-read and not waiting for it look exactly the same, and the first
     * version of this test passed against the bug it was written for.
     */
    async function changeSomething(args: CommandArgs) {
      const filed: WorkspaceSnapshot = {
        ...snapshot,
        filings: [{ panelId: 'p-falcon', itemId: 'i-bart', position: 0 }],
      };
      let letTheRereadFinish!: () => void;
      reads.mockReset();
      reads.mockResolvedValueOnce(snapshot).mockImplementation(
        () =>
          new Promise((resolve) => {
            letTheRereadFinish = () => resolve(filed);
          }),
      );
      sends.mockResolvedValue({ ok: true, applied: true });

      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const done: { yet: boolean } = { yet: false };

      function DoIt() {
        const { data } = useQuery(snapshotQuery('ws-work'));
        const command = useCommand();
        return data ? (
          <button
            type="button"
            onClick={() => command.mutate(args, { onSuccess: () => void (done.yet = true) })}
          >
            do it
          </button>
        ) : (
          <p>still loading</p>
        );
      }

      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      render(
        <QueryClientProvider client={client}>
          <DoIt />
        </QueryClientProvider>,
      );
      await user.click(await screen.findByRole('button', { name: 'do it' }));
      // The server has taken the change and the re-read is still out, which is
      // the window everything here is about.
      await waitFor(() => expect(reads).toHaveBeenCalledTimes(2));
      return { done, letTheRereadFinish: () => letTheRereadFinish() };
    }

    it('is finished when the server has accepted it, with the re-read still out', async () => {
      // Filing an item onto a panel sends that panel's whole order, and the
      // server checks it against the order it holds, so a second filing has to be
      // built on the first. It is: the screen draws the first over the copy it
      // holds (`drawnAhead.ts`) and the next filing is built on that, so nothing
      // waits for the re-read.
      const { done, letTheRereadFinish } = await changeSomething({
        name: 'move_item_to_panel',
        payload: {
          commandId: 'c3',
          issuedAt: AT,
          workspaceId: 'ws-work',
          itemId: 'i-bart',
          panelId: 'p-falcon',
          order: ['i-bart'],
        },
      });

      await waitFor(() => expect(done.yet).toBe(true));
      letTheRereadFinish();
    });

    it('does not hold up a change that nothing is built on, so adding a dashboard still goes there at once', async () => {
      // **The other half, and it is not symmetry for its own sake.** Making
      // every change wait was the first fix and it broke this one: adding a
      // dashboard re-reads and then navigates to what it made, so waiting first
      // put the new dashboard in the bar *before* that navigation ran - and the
      // navigation could then land while somebody was already typing a panel
      // name on the dashboard they were still on, taking it with them.
      const { done } = await changeSomething({
        name: 'add_dashboard',
        payload: {
          commandId: 'c4',
          issuedAt: AT,
          workspaceId: 'ws-work',
          dashboardId: 'd-today',
          panelId: 'p-today',
          name: 'Today',
        },
      });

      await waitFor(() => expect(done.yet).toBe(true));
    });
  });

  describe('a filing is built on the copy the screen draws, with no read first', () => {
    const bart = { id: 'i-bart' } as Item;
    const held: WorkspaceSnapshot = { ...snapshot, items: [bart] };

    /** A filing the server has not answered, and then the order for the next one is asked for. */
    async function askForTheCopy(markOutOfDate: boolean) {
      const answer = Promise.withResolvers<{ ok: true; applied: true }>();
      sends.mockReturnValue(answer.promise as never);
      reads.mockReset();
      reads.mockResolvedValue({ ...held, filings: [{ panelId: 'p-anna', itemId: 'i-bart', position: 0 }] });
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      client.setQueryData(['snapshot', 'ws-work'], held);
      const filing = changes.enqueue({
        name: 'add_item_to_panel',
        payload: { commandId: 'c9', issuedAt: AT, workspaceId: 'ws-work', itemId: 'i-bart', panelId: 'p-falcon', order: ['i-bart'] },
      });
      if (markOutOfDate) await client.invalidateQueries({ queryKey: ['snapshot', 'ws-work'], refetchType: 'none' });

      let got: WorkspaceSnapshot | undefined;
      function Reader() {
        const latest = useLatestSnapshot();
        useEffect(() => {
          void latest('ws-work').then((copy) => {
            got = copy;
          });
        }, [latest]);
        return null;
      }
      render(
        <QueryClientProvider client={client}>
          <Reader />
        </QueryClientProvider>,
      );
      await waitFor(() => expect(got).toBeDefined());
      answer.resolve({ ok: true, applied: true });
      await filing;
      return got!;
    }

    it('answers from the held copy with the changes already made over it, without reading', async () => {
      const copy = await askForTheCopy(false);

      expect(copy.filings.map((filing) => filing.panelId)).toEqual(['p-falcon']);
      expect(reads).not.toHaveBeenCalled();
    });

    it('reads once when the held copy is marked out of date, and draws the changes over what it finds', async () => {
      const copy = await askForTheCopy(true);

      expect(reads).toHaveBeenCalledTimes(1);
      expect(copy.filings.map((filing) => filing.panelId).sort()).toEqual(['p-anna', 'p-falcon']);
    });
  });
});

describe('Selection', () => {
  describe('a run of changes reads the workspace as it stands, not as the screen last saw it', () => {
    it('asks the server again when nothing is watching the workspace any more', async () => {
      // The way back offered after filing several outlives the screen it was
      // made on - the bar is mounted above the router - and each change it
      // sends carries the panel's whole arrangement, built on what the panel
      // holds by then. Marking the copy stale does not refetch a query nobody
      // is watching, so reading the cache handed the undo an arrangement from
      // before the filing and the server refused it.
      const filed: WorkspaceSnapshot = {
        ...snapshot,
        filings: [{ panelId: 'p-falcon', itemId: 'i-bart', position: 0 }],
      };
      reads.mockReset();
      reads.mockResolvedValue(filed);
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      // What the screen last held, and then left behind: in the cache, stale,
      // and watched by nothing.
      client.setQueryData(['snapshot', 'ws-work'], snapshot);
      await client.invalidateQueries({ queryKey: ['snapshot', 'ws-work'] });

      let got: WorkspaceSnapshot | undefined;
      function Reader() {
        const latest = useLatestSnapshot();
        useEffect(() => {
          void Promise.resolve(latest('ws-work')).then((snapshot) => {
            got = snapshot;
          });
        }, [latest]);
        return null;
      }
      render(
        <QueryClientProvider client={client}>
          <Reader />
        </QueryClientProvider>,
      );

      await waitFor(() => expect(got?.filings).toEqual(filed.filings));
    });
  });
});

describe('Capture', () => {
  /**
   * An item that belongs to no workspace is drawn in every workspace's Inbox
   * ("Capture something before you know which workspace it belongs to", issue
   * 165), so making one and settling one change what the *other* workspaces
   * hold. The server says so too, by logging the change against the account
   * and letting the stream tell everybody - but the tab that made the change
   * would otherwise wait for its own message to come back, and until it did
   * the copy it already held stayed fresh. Switching workspace inside that
   * window painted an item that had just left, which is how the walk found it.
   */
  describe('a change every workspace can see leaves no other workspace’s copy fresh', () => {
    it.each([
      {
        situation: 'capturing something that belongs to no workspace',
        args: {
          name: 'capture_item',
          payload: {
            commandId: 'c5',
            issuedAt: AT,
            workspaceId: 'ws-work',
            itemId: '018f0000-0000-7000-8000-000000000001',
            title: 'Where does this go',
            workspaceDecided: false,
          },
        },
        stale: true,
      },
      {
        situation: 'settling one onto a panel',
        args: {
          name: 'move_item_to_panel',
          payload: {
            commandId: 'c6',
            issuedAt: AT,
            workspaceId: 'ws-work',
            itemId: '018f0000-0000-7000-8000-000000000001',
            panelId: '018f0000-0000-7000-8000-000000000002',
            order: ['018f0000-0000-7000-8000-000000000001'],
          },
        },
        stale: true,
      },
      {
        // The other half of the branch: a capture that says where it belongs
        // changes that workspace and no other, so nobody else re-reads.
        situation: 'capturing into the workspace you are in',
        args: {
          name: 'capture_item',
          payload: {
            commandId: 'c7',
            issuedAt: AT,
            workspaceId: 'ws-work',
            itemId: '018f0000-0000-7000-8000-000000000003',
            title: 'Reply to Bart',
          },
        },
        stale: false,
      },
    ] as { situation: string; args: CommandArgs; stale: boolean }[])(
      '$situation',
      async ({ args, stale }) => {
        sends.mockResolvedValue({ ok: true, applied: true });
        const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
        // A workspace the change does not name, holding what was last shown of
        // it - the other tab, or the one switched to a moment later.
        client.setQueryData(['snapshot', 'ws-personal'], snapshot);
        const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
        render(
          <QueryClientProvider client={client}>
            <Change args={args} />
          </QueryClientProvider>,
        );

        await user.click(screen.getByRole('button', { name: 'go' }));

        await waitFor(() => expect(sends).toHaveBeenCalledTimes(1));
        // Stale rather than gone: the copy is still painted at once, it is
        // simply read again rather than trusted for the whole staleTime.
        await waitFor(() =>
          expect(client.getQueryState(['snapshot', 'ws-personal'])?.isInvalidated).toBe(stale),
        );
      },
    );
  });
});

/**
 * The item this rule saves and opens again. Its description is empty to start
 * with, which is the state a captured thought is in and the one the browser
 * walk is in when it first presses Save.
 */
function anItem(over: Partial<Item> = {}): Item {
  return {
    id: 'item-1',
    tenantId: 'tenant',
    workspaceId: 'ws-work',
    workspaceDecided: true,
    source: 'internal',
    sourceId: null,
    sourceLink: null,
    sender: null,
    sourceTimestamp: null,
    capturedMessage: 'Ask Novy about part 11',
    textsSettledAt: null,
    textsProposedAt: null,
    readings: null,
    proposedPanelId: null,
    proposedPanelReason: null,
    proposedPanelFit: null,
    claudeProposals: null,
    sourceResolvedAt: null,
    title: 'Part 11',
    description: null,
    nextAction: null,
    completedAt: null,
    startedAt: null,
    priority: null,
    prioritySetAt: null,
    dueDateChosenAt: null,
    capturedTimeZone: null,
    dueDate: null,
    dueDateSetAt: null,
    unseen: false,
    deletedAt: null,
    createdAt: '2026-08-31T10:00:00.000Z',
    updatedAt: '2026-08-31T10:00:00.000Z',
    ...over,
  };
}

describe('Item editing', () => {
  describe('a change is finished when the server has accepted it, not when the workspace has been read back', () => {
    // An Item's fields are drawn at once and stay drawn until a read that began
    // after the answer lands, so nothing built on them has a read to wait for
    // (`changeQueue.ts`), and a filing is the same.
    it.each([
      {
        situation: 'a priority',
        change: {
          name: 'set_priority',
          payload: { commandId: 'c5', issuedAt: AT, workspaceId: 'ws-work', itemId: 'i-bart', priority: 'high' },
        } as CommandArgs,
      },
      {
        situation: 'a due date',
        change: {
          name: 'set_due_date',
          payload: { commandId: 'c6', issuedAt: AT, workspaceId: 'ws-work', itemId: 'i-bart', dueDate: '2026-09-30' },
        } as CommandArgs,
      },
    ])('$situation', async ({ change }) => {
      let letTheRereadFinish!: () => void;
      reads.mockReset();
      reads.mockResolvedValueOnce(snapshot).mockImplementation(
        () =>
          new Promise((resolve) => {
            letTheRereadFinish = () => resolve(snapshot);
          }),
      );
      sends.mockResolvedValue({ ok: true, applied: true });

      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const done: { yet: boolean } = { yet: false };

      function DoIt() {
        const { data } = useQuery(snapshotQuery('ws-work'));
        const command = useCommand();
        return data ? (
          <button type="button" onClick={() => command.mutate(change, { onSuccess: () => void (done.yet = true) })}>
            do it
          </button>
        ) : (
          <p>still loading</p>
        );
      }

      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      render(
        <QueryClientProvider client={client}>
          <DoIt />
        </QueryClientProvider>,
      );
      await user.click(await screen.findByRole('button', { name: 'do it' }));

      // The server has taken the change and the re-read is still out.
      await waitFor(() => expect(reads).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(done.yet).toBe(true));

      letTheRereadFinish();
    });
  });

  describe('an item opened again holds the text it was last saved with', () => {
    /**
     * **The bug this is here for.** A form fills its boxes from the copy the
     * cache holds and never refills them, so a form opened again while the
     * workspace was still being read back after the save opened on the text
     * from *before* it - and stayed there, since a later read does not refill a
     * form already filled. The browser walk lost that race in CI with the
     * re-read out for 215ms, and read the description it had just written as
     * empty (tests/e2e/item-editing.test.ts, "the formatted description and its
     * source are one text").
     *
     * It used to be answered by Save waiting for the re-read. It is answered
     * now by drawing the saved text over the copy until a read that began after
     * the answer has landed, so Save closes on the server's acceptance and the
     * reopened form has the text with the re-read still out.
     */
    it('is saved on the server’s acceptance, and opens again on the saved text with the re-read still out', async () => {
      const written = 'Tolerances, and the sign-off date';
      let letTheRereadFinish!: () => void;
      reads.mockReset();
      reads
        .mockResolvedValueOnce({ ...snapshot, items: [anItem()] })
        .mockImplementation(
          () =>
            new Promise((resolve) => {
              letTheRereadFinish = () => resolve({ ...snapshot, items: [anItem({ description: written })] });
            }),
        );
      sends.mockResolvedValue({ ok: true, applied: true });

      opened.item = 'item-1';
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      // A fresh element each time: passing the identical one back lets React
      // bail out of the re-render, and the form never sees the address change.
      const shell = () => (
        <QueryClientProvider client={client}>
          <ItemForm />
        </QueryClientProvider>
      );
      const { rerender } = render(shell());
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      // The editor is fetched behind the form, so for a tick the description is
      // the read-only stand-in. Typing into that would be typing into nothing.
      await waitFor(() =>
        expect(screen.getByLabelText('Description')).not.toHaveAttribute('readonly'),
      );

      await user.type(screen.getByLabelText('Description'), written);
      await user.click(screen.getByRole('button', { name: 'Save' }));

      // The form has closed with the re-read still out.
      await waitFor(() => expect(opened.item).toBeUndefined());
      await waitFor(() => expect(reads).toHaveBeenCalledTimes(2));

      // Opened again the moment it closes, which is what the row's menu allows
      // and what the walk does.
      rerender(shell());
      opened.item = 'item-1';
      rerender(shell());

      await waitFor(() => expect(screen.getByLabelText('Description')).toHaveValue(written));

      // The read lands with the same text and the drawn copy gives way to it.
      letTheRereadFinish();
      await waitFor(() => expect(screen.getByLabelText('Description')).toHaveValue(written));
    });
  });
});
