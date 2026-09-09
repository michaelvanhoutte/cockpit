import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, focusManager, useQuery } from '@tanstack/react-query';
import userEvent from '@testing-library/user-event';
import type { Item, WorkspaceSnapshot } from '@cockpit/shared';
import {
  snapshotQuery,
  useCommand,
  useLatestSnapshot,
  type CommandArgs,
} from '../../../src/api/queries';
import { fetchSnapshot, sendCommand } from '../../../src/api/client';
import { ItemForm } from '../../../src/components/ItemForm';

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
}));

const reads = vi.mocked(fetchSnapshot);
const sends = vi.mocked(sendCommand);

/**
 * The item's form is rendered for real by the last rule here, because what it
 * is about is the form and the copy it is filled from together. Only the two
 * things it reaches outside this file are replaced: the address it is opened
 * and closed by, and its 115KB editor.
 */
const opened = vi.hoisted(() => ({ item: undefined as string | undefined }));

vi.mock('@tanstack/react-router', () => ({ useParams: () => ({ workspaceId: 'ws-work' }) }));

vi.mock('../../../src/itemForm', () => ({
  useItemForm: () => ({
    openItemId: opened.item,
    close: () => {
      opened.item = undefined;
    },
  }),
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
  itemTypes: [],
    screenSizes: [],
  filings: [],
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

    it('waits for the re-read before it is finished filing, so the next filing has this one', async () => {
      // **The bug this is here for.** Filing an item onto a panel sends that
      // panel's whole order, and the server checks it against the order it
      // holds - so filing a second item straight after the first sent an order
      // built from a workspace that did not have the first item in it yet, and
      // was refused. It is a race, and it was only ever lost on a machine slow
      // enough to lose it.
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

      expect(done.yet).toBe(false);
      letTheRereadFinish();

      await waitFor(() => expect(done.yet).toBe(true));
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
    readings: null,
    sourceResolvedAt: null,
    title: 'Part 11',
    description: null,
    typeId: null,
    nextAction: null,
    completedAt: null,
    priority: null,
    dueDate: null,
    unseen: false,
    deletedAt: null,
    createdAt: '2026-08-31T10:00:00.000Z',
    updatedAt: '2026-08-31T10:00:00.000Z',
    ...over,
  };
}

describe('Item editing', () => {
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
     * **The re-read is slow rather than held open by hand**, which is what puts
     * the failure on the last line rather than only on the guard above it. The
     * item is opened again the moment the form closes, so the two worlds differ
     * exactly where the bug is: without the wait the form closes at once
     * and the reopen lands inside the re-read, and with it the form closes only
     * after that read is in. Released by hand instead, the reopen could only
     * ever follow the release, and the last line would pass either way - which
     * is how the first version of this test read.
     *
     * A slow API rather than a fast machine is also how this class is found at
     * all (the `testing` skill, "Flakiness").
     *
     * **A second, not a tenth of one**, because fake time here advances with
     * real time: the guard below reads "the form has not closed yet" one poll
     * after the change was taken, and a run descheduled for longer than this
     * would find the read already in and the form gone, failing for the
     * contention rather than for the bug. A second is far more than any poll
     * gap and costs this one test the same second.
     */
    const SLOW = 1_000;

    it('is not finished saving until the workspace has been read back', async () => {
      const written = 'Tolerances, and the sign-off date';
      reads.mockReset();
      reads
        .mockResolvedValueOnce({ ...snapshot, items: [anItem()] })
        .mockImplementation(
          () =>
            new Promise((resolve) => {
              setTimeout(() => resolve({ ...snapshot, items: [anItem({ description: written })] }), SLOW);
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

      // The server has taken the change and the re-read is still out, which is
      // the window this whole rule is about: the form is still up, so there is
      // nothing to open again on text that is about to be replaced.
      await waitFor(() => expect(reads).toHaveBeenCalledTimes(2));
      expect(opened.item).toBe('item-1');

      // Opened again the moment it closes, which is what the row's menu allows
      // and what the walk does.
      //
      // **This is the one wait that spans the arranged delay, so it is the one
      // that has to be told to outlast it.** `waitFor` allows 1000ms by default
      // (@testing-library/dom, unoverridden here), which is `SLOW` itself - so
      // left alone this deadline races the delay it is waiting on, and the test
      // written to catch a race would lose one of its own.
      await waitFor(() => expect(opened.item).toBeUndefined(), { timeout: SLOW * 3 });
      rerender(shell());
      opened.item = 'item-1';
      rerender(shell());

      // Waiting here cannot hide the bug rather than find it: a form is filled
      // once and never refilled, so a box that opened empty stays empty however
      // long this waits, and the read landing under it changes nothing.
      await waitFor(() => expect(screen.getByLabelText('Description')).toHaveValue(written));
    });
  });
});
