import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, focusManager, useQuery } from '@tanstack/react-query';
import userEvent from '@testing-library/user-event';
import type { WorkspaceSnapshot } from '@cockpit/shared';
import { snapshotQuery, useCommand, type CommandArgs } from '../../../src/api/queries';
import { fetchSnapshot, sendCommand } from '../../../src/api/client';

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

const snapshot: WorkspaceSnapshot = {
  workspace: { id: 'ws-work', tenantId: 'tenant', name: 'Work', color: '#6f62b5', bar: '#dbd7ee', ground: '#e3e1f2', header: '#d2cdea' },
  items: [],
  dashboards: [],
  panels: [],
  layouts: [],
  associations: [],
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
          name: 'Today',
        },
      });

      await waitFor(() => expect(done.yet).toBe(true));
    });
  });
});
