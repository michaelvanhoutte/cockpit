import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ConnectedApp } from '@cockpit/shared';
import { changes } from '../../../src/api/changes';
import ManageConnectedApps from '../../../src/components/ManageConnectedApps';
import SavingMark from '../../../src/components/SavingMark';
import { resetStanding } from '../../../src/offline';
import { UndoWhatJustHappened } from '../../../src/undo';

/**
 * Disconnecting a connected app as its control makes it, with the server holding
 * the answer - the frontend-with-its-own-backend level (F2), run in this runner as
 * `ConnectionsAtOnce.test.tsx` is. The window, its queries and the tab's queue are
 * the app's own and only the network is replaced: a server that answers when the
 * test says and keeps the apps it is told to. What a disconnect draws is
 * tests/unit/connectedAppsDrawnAhead.test.ts and when it stops being drawn is
 * tests/unit/changeQueue.test.ts; what is asked here is that the control is wired
 * to them, and that the saving sign and the leave-site prompt cover it.
 */

const held = vi.hoisted(() => ({
  /** What the list of apps answers with, and how many times it has been read. */
  apps: [] as unknown[],
  reads: 0,
  /** While set, a read of the list looks at what the server holds and is then held until it is released. */
  hold: false,
  releases: [] as (() => void)[],
  /** Every disconnect the server has been sent and not yet answered, oldest first. */
  waiting: [] as { appId: string; signal: AbortSignal | undefined; answer: () => void; answerWith: (status: number) => void }[],
}));

vi.mock('../../../src/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/api/client')>()),
  api: {
    v1: {
      'connected-apps': {
        $get: async () => {
          held.reads += 1;
          const seen = structuredClone(held.apps);
          if (held.hold) await new Promise<void>((resolve) => held.releases.push(resolve));
          return Response.json({ apps: seen });
        },
        ':appId': {
          $delete: ({ param }: { param: { appId: string } }, options?: { init?: RequestInit }) =>
            new Promise<Response>((resolve) => {
              held.waiting.push({
                appId: param.appId,
                signal: options?.init?.signal ?? undefined,
                answer: () => {
                  held.apps = (held.apps as ConnectedApp[]).filter((app) => app.id !== param.appId);
                  resolve(Response.json({ disconnected: true }));
                },
                answerWith: (status) => resolve(Response.json({ error: 'The server said no.' }, { status })),
              });
            }),
        },
      },
    },
  },
}));

const CLAUDE: ConnectedApp = { id: 'grant-claude', name: 'Claude', kind: 'captures', connectedAt: '2026-09-30T09:00:00.000Z', lastCapturedAt: null, lastReadAt: null };
const QUIET: ConnectedApp = { id: 'grant-quiet', name: 'Quiet app', kind: 'captures', connectedAt: '2026-09-30T10:00:00.000Z', lastCapturedAt: null, lastReadAt: null };

let client: QueryClient;

async function show(apps: ConnectedApp[]) {
  held.apps = [...apps];
  held.reads = 0;
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <UndoWhatJustHappened>
        <SavingMark />
        <ManageConnectedApps open onClose={() => {}} />
      </UndoWhatJustHappened>
    </QueryClientProvider>,
  );
  await screen.findByText(apps[0]!.name);
  return userEvent.setup();
}

const listed = () => screen.queryAllByRole('listitem').map((row) => within(row).getByText(/^(Claude|Quiet app)$/).textContent);

/** Lets what the app does between an answer and the read behind it happen. */
const settle = () => act(async () => void (await new Promise((resolve) => setTimeout(resolve, 20))));

/** The server answers the oldest disconnect it is holding. */
async function answerNext() {
  await act(async () => held.waiting.shift()!.answer());
  await settle();
}

async function disconnect(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(await screen.findByRole('button', { name: `Actions for ${name}` }));
  await user.click(await screen.findByRole('menuitem', { name: 'Disconnect' }));
  await user.click(await screen.findByRole('button', { name: `Yes, disconnect ${name}` }));
}

const leave = () => {
  const event = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
};

beforeEach(() => {
  localStorage.clear();
  resetStanding();
  held.waiting = [];
  held.hold = false;
  held.releases = [];
});

afterEach(async () => {
  cleanup();
  resetStanding();
  for (let round = 0; round < 6 && changes.unanswered() > 0; round += 1) {
    await act(async () => held.waiting.splice(0).forEach((request) => request.answer()));
    await settle();
  }
  changes.forgetAnswered();
});

describe('MCP connections', () => {
  describe('a disconnected app shows the moment it is disconnected, with the server still holding the answer', () => {
    it('takes the row away and closes the question', async () => {
      const user = await show([CLAUDE, QUIET]);

      await disconnect(user, 'Claude');

      expect(listed()).toEqual(['Quiet app']);
      expect(screen.queryByRole('alertdialog')).toBeNull();
      expect(held.waiting.map((request) => request.appId)).toEqual(['grant-claude']);
    });

    it('says there are no connected apps once the last one is disconnected', async () => {
      const user = await show([CLAUDE]);

      await disconnect(user, 'Claude');

      expect(await screen.findByText('No connected apps')).toBeVisible();
    });
  });

  describe('a disconnected app stays gone until the list is read after its answer', () => {
    it('keeps the row gone under a read of the list begun before the answer, and shows the server’s list after one begun later', async () => {
      const user = await show([CLAUDE, QUIET]);
      await disconnect(user, 'Claude');

      // A read begins now and is held: it saw the list as the server held it before the answer.
      held.hold = true;
      void client.invalidateQueries({ queryKey: ['connectedApps'] });
      await waitFor(() => expect(held.releases).toHaveLength(1));
      await answerNext();
      held.hold = false;
      await act(async () => held.releases.splice(0).forEach((release) => release()));
      await settle();
      expect(listed()).toEqual(['Quiet app']);

      // The app is allowed again from another device once the answer has been read: that is the server's now.
      held.apps = [CLAUDE, QUIET];
      await act(async () => void (await client.invalidateQueries({ queryKey: ['connectedApps'] })));

      await waitFor(() => expect(listed()).toEqual(['Claude', 'Quiet app']));
    });

    it('reads the list once after the answers', async () => {
      const user = await show([CLAUDE, QUIET]);
      await disconnect(user, 'Claude');
      await disconnect(user, 'Quiet app');
      const before = held.reads;

      await answerNext();
      expect(held.reads).toBe(before);
      await answerNext();

      await waitFor(() => expect(held.reads).toBe(before + 1));
      await settle();
      expect(held.reads).toBe(before + 1);
      expect(screen.getByText('No connected apps')).toBeVisible();
    });

    it('treats an app already disconnected from another tab as disconnected', async () => {
      const user = await show([CLAUDE, QUIET]);
      await disconnect(user, 'Claude');

      // Another tab disconnected it first, so the server no longer holds it.
      held.apps = [QUIET];
      await act(async () => held.waiting.shift()!.answerWith(404));
      await settle();

      expect(listed()).toEqual(['Quiet app']);
      expect(screen.queryByText(/not disconnected/)).toBeNull();
    });
  });

  describe('a disconnect the server refuses puts the row back and says why', () => {
    it('brings the row back with the reason in the undo bar', async () => {
      const user = await show([CLAUDE, QUIET]);
      await disconnect(user, 'Claude');
      expect(listed()).toEqual(['Quiet app']);

      await act(async () => held.waiting.shift()!.answerWith(500));
      await settle();

      expect(listed()).toEqual(['Claude', 'Quiet app']);
      expect(await screen.findByText(/“Claude” was not disconnected\. That did not reach the server\. Try again\./)).toBeInTheDocument();
    });
  });

  describe('a disconnect counts on the saving sign and guards leaving the page until it is answered', () => {
    it('shows the sign counting it and asks before leaving, then neither once it is answered', async () => {
      const user = await show([CLAUDE, QUIET]);
      expect(leave()).toBe(false);

      await disconnect(user, 'Claude');

      expect(await screen.findByRole('status', { hidden: true, name: 'Saving 1 change…' })).toBeInTheDocument();
      expect(leave()).toBe(true);

      await answerNext();

      await waitFor(() => expect(screen.queryByRole('status', { hidden: true, name: 'Saving 1 change…' })).toBeNull());
      expect(leave()).toBe(false);
    });
  });
});
