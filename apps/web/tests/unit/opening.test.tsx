import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, renderHook, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider, skipToken, useQuery } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';

import type { Workspace } from '@cockpit/shared';
import { fetchMe, fetchSnapshot, fetchWorkspaces, sendCommand } from '../../src/api/client';
import { LoadFailure } from '../../src/components/LoadFailure';
import { Updating } from '../../src/components/Updating';
import { resetStanding, stand, isOffline, CannotBeLoadedOffline } from '../../src/offline';
import {
  GIVE_UP_AFTER_MS,
  HoldForTheServer,
  Opening,
  howToOpen,
  startVisit,
  tryTheServer,
  type Seams,
} from '../../src/opening';
import { forgetEverySavedRead, restoreSavedReads, saveRead } from '../../src/persistence';
import { refusalFrom, useCommand } from '../../src/api/queries';
import { createAppRouter } from '../../src/router';
import { aWorkspace, anItem } from './support/savedReads';
import type { Workers } from '../../src/updating';
import type { Surroundings } from '../../src/api/loadFailure';

/**
 * F1: how Cockpit opens, with the timer faked and the server a stub that
 * decides every branch. Only `setTimeout` is faked, so the fake IndexedDB the
 * saved reads live in keeps running. What a real browser adds (paused queries,
 * the service worker's shell, real IndexedDB) is the one walk in
 * tests/e2e/load-failure.test.ts.
 */
vi.mock('../../src/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/api/client')>()),
  fetchWorkspaces: vi.fn(),
  fetchSnapshot: vi.fn(),
  fetchMe: vi.fn(),
  sendCommand: vi.fn(),
}));

const work: Workspace = { id: 'ws-work', tenantId: 'tenant', name: 'Work', color: '#6f62b5', bar: '#dbd7ee', ground: '#e3e1f2', header: '#d2cdea' };
const savedList = { workspaces: [{ ...work, name: 'Saved Work' }] };
const freshList = { workspaces: [{ ...work, name: 'Fresh Work' }] };


/** Shows the Workspace list as the app holds it, and nothing else. */
function Names() {
  const { data } = useQuery({ queryKey: ['workspaces'], queryFn: skipToken });
  const names = (data as typeof freshList | undefined)?.workspaces.map((w) => w.name).join(', ');
  return <p>{names ?? 'no list'}</p>;
}

/** The server's answer to the Workspace list, held until `answer` is called. */
function serverAnswering() {
  let answer: () => void = () => {};
  let fail: (error: unknown) => void = () => {};
  const read = vi.fn(
    () =>
      new Promise<typeof freshList>((resolve, reject) => {
        answer = () => resolve(freshList);
        fail = reject;
      }),
  );
  return { read, answer: () => answer(), fail: (error: unknown) => fail(error) };
}

const online: Surroundings = { isDefinitelyOffline: () => false, reachServer: async () => 'reachable' };
const deviceOffline: Surroundings = { isDefinitelyOffline: () => true, reachServer: async () => 'unreachable' };

function askingWith(read: () => Promise<unknown>, surroundings = online): Seams {
  return {
    surroundings,
    ask: (client) => client.fetchQuery({ queryKey: ['workspaces'], queryFn: read, staleTime: 0, retry: false, networkMode: 'always' }),
  };
}

function openApp(seams: Seams, how: Parameters<typeof startVisit>[1] = 'server-first') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <Opening client={client} how={how} seams={seams}>
      <HoldForTheServer>
        <Names />
      </HoldForTheServer>
    </Opening>,
  );
  return client;
}

const at = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  stand({ connecting: true, found: false, chosen: false });
  await forgetEverySavedRead();
  await saveRead({ queryKey: ['workspaces'], data: savedList, savedAt: Date.now() });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  resetStanding();
  vi.clearAllMocks();
});

describe('Offline', () => {
  describe('online, the open draws only from the server’s answer', () => {
    it('draws the server’s answer, and never the saved read, when it answers in 200 ms', async () => {
      const server = serverAnswering();
      openApp(askingWith(server.read));

      await at(200);
      expect(screen.queryByText('Saved Work')).toBeNull();
      expect(screen.queryByText('Loading…')).toBeNull();
      server.answer();
      await at(0);

      expect(screen.getByText('Fresh Work')).toBeInTheDocument();
      expect(screen.queryByText('Saved Work')).toBeNull();
      expect(isOffline()).toBe(false);
    });

    it('shows nothing for 300 ms, then Loading…, then the answer', async () => {
      const server = serverAnswering();
      openApp(askingWith(server.read));

      await at(299);
      expect(screen.queryByText('Loading…')).toBeNull();
      await at(1);
      expect(screen.getByText('Loading…')).toBeInTheDocument();
      server.answer();
      await at(0);

      expect(screen.getByText('Fresh Work')).toBeInTheDocument();
      expect(screen.queryByText('Loading…')).toBeNull();
    });

    it('treats a refusal as an answer: online, nothing drawn from the saved read', async () => {
      const server = serverAnswering();
      openApp(askingWith(server.read));

      server.fail(new Error('workspaces failed: 401'));
      await at(0);

      expect(screen.queryByText('Saved Work')).toBeNull();
      expect(isOffline()).toBe(false);
    });

    it('runs the check for a new version alongside the wait, not after it', async () => {
      const server = serverAnswering();
      const workers: Workers = {
        supported: () => true,
        waiting: async () => false,
        check: () => new Promise((resolve) => setTimeout(() => resolve(false), 1_400)),
        activate: async () => true,
        onTakenOver: () => () => {},
      };
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      render(
        <Opening client={client} how="server-first" seams={askingWith(server.read)}>
          <Updating workers={workers}>
            <HoldForTheServer>
              <Names />
            </HoldForTheServer>
          </Updating>
        </Opening>,
      );

      await at(1_000);
      server.answer();
      await at(399);
      expect(screen.queryByText('Fresh Work')).toBeNull();
      await at(1);

      // 1.4 s, the slower of the two, rather than 1 s then 1.4 s.
      expect(screen.getByText('Fresh Work')).toBeInTheDocument();
    });
  });

  describe('no answer in 3 s, or none at all, draws the checked saved reads', () => {
    it('draws them at 3 s and is offline, found', async () => {
      const server = serverAnswering();
      openApp(askingWith(server.read));

      await at(GIVE_UP_AFTER_MS - 1);
      expect(screen.queryByText('Saved Work')).toBeNull();
      await at(1);

      await vi.waitFor(() => expect(screen.getByText('Saved Work')).toBeInTheDocument());
      await vi.waitFor(() => expect(isOffline()).toBe(true));
    });

    it.each([
      { situation: 'the request fails outright at once', surroundings: online, fails: true },
      { situation: 'the device says it is offline', surroundings: deviceOffline, fails: false },
    ])('draws them without waiting when $situation', async ({ surroundings, fails }) => {
      const server = serverAnswering();
      openApp(askingWith(server.read, surroundings));

      if (fails) server.fail(new TypeError('Failed to fetch'));
      await at(0);

      await vi.waitFor(() => expect(screen.getByText('Saved Work')).toBeInTheDocument());
      await vi.waitFor(() => expect(isOffline()).toBe(true));
    });

    it('still waits the 3 s when the device says it is online and nothing answers', async () => {
      const server = serverAnswering();
      openApp(askingWith(server.read, online));

      await at(2_000);

      expect(screen.queryByText('Saved Work')).toBeNull();
      expect(isOffline()).toBe(false);
    });

    it('is a gateway standing in for a server that is down, also not an answer', async () => {
      const server = serverAnswering();
      openApp(askingWith(server.read));

      server.fail(new Error('workspaces failed: 504'));
      await at(0);

      await vi.waitFor(() => expect(screen.getByText('Saved Work')).toBeInTheDocument());
    });
  });

  describe('a late answer replaces the saved reads and ends offline', () => {
    it('re-reads what is drawn when the server answers at 5 s', async () => {
      const server = serverAnswering();
      const client = openApp(askingWith(server.read));
      await at(GIVE_UP_AFTER_MS);
      await vi.waitFor(() => expect(screen.getByText('Saved Work')).toBeInTheDocument());
      const reread = vi.fn(() => Promise.resolve('read again'));
      const observer = renderHook(() => useQuery({ queryKey: ['something-drawn'], queryFn: reread }), {
        wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
      });
      expect(observer.result.current.data).toBeUndefined();

      await at(2_000);
      server.answer();
      await at(0);

      expect(screen.getByText('Fresh Work')).toBeInTheDocument();
      expect(isOffline()).toBe(false);
      expect(reread).toHaveBeenCalled();
    });
  });

  describe('Capture opens at once from the checked saved reads and sends when the server answers', () => {
    it.each(['/capture', '/capture/car'])('%s is drawn before the server has said anything', async (path) => {
      expect(howToOpen(path)).toBe('saved-first');
      const server = serverAnswering();
      openApp(askingWith(server.read), 'saved-first');

      await at(0);

      await vi.waitFor(() => expect(screen.getByText('Saved Work')).toBeInTheDocument());
      expect(isOffline()).toBe(false);
    });

    it('makes the rest of the visit offline when the server does not answer in 3 s', async () => {
      const server = serverAnswering();
      openApp(askingWith(server.read), 'saved-first');
      await vi.waitFor(() => expect(screen.getByText('Saved Work')).toBeInTheDocument());

      await at(GIVE_UP_AFTER_MS);

      await vi.waitFor(() => expect(isOffline()).toBe(true));
    });
  });

  describe('offline with nothing to show says why, and Try again races again', () => {
    const queryKey = ['snapshot', 'ws-work'];

    it('says nothing is saved here to show', () => {
      render(<LoadFailure error={new CannotBeLoadedOffline(queryKey)} onRetry={() => {}} />);

      expect(screen.getByRole('heading', { name: "Cockpit can't be reached" })).toBeVisible();
      expect(screen.getByText('This device looks offline, and nothing is saved here to show.')).toBeVisible();
      expect(screen.getByRole('button', { name: 'Try again' })).toBeVisible();
    });

    it('says what is saved was saved in a shape this version can’t read', async () => {
      // A Workspace saved with a property this version no longer has.
      await saveRead({ queryKey, data: { ...aWorkspace([anItem(1)]), layouts: 'old' }, savedAt: Date.now() });
      await restoreSavedReads(new QueryClient());

      render(<LoadFailure error={new CannotBeLoadedOffline(queryKey)} onRetry={() => {}} />);

      expect(
        screen.getByText(/what's saved here was saved in a shape this version can't read, so it can't be shown/),
      ).toBeVisible();
    });

    it('goes online when the server now answers', async () => {
      stand({ found: true, connecting: false });
      const server = serverAnswering();
      const client = new QueryClient();

      const asking = tryTheServer(client, askingWith(server.read));
      server.answer();

      expect(await asking).toBe(true);
      expect(isOffline()).toBe(false);
    });

    it('stays offline when the server still does not answer', async () => {
      stand({ found: true, connecting: false });
      const server = serverAnswering();
      const asking = tryTheServer(new QueryClient(), askingWith(server.read));

      await at(GIVE_UP_AFTER_MS);

      expect(await asking).toBe(false);
      await vi.waitFor(() => expect(isOffline()).toBe(true));
    });
  });

  describe('a route says it can’t be loaded offline instead of waiting on a read that never settles', () => {
    const snapshot = {
      workspace: work,
      items: [],
      dashboards: [{ id: 'd1', tenantId: 'tenant', workspaceId: 'ws-work', name: 'Dashboard 1' }],
      panels: [],
      layouts: [],
      associations: [],
      attachments: [],
      itemFormPresentation: 'centered' as const,
      duplicates: [],
      filings: [],
      agentRuns: [],
      generatedAt: '2026-08-31T10:00:00.000Z',
    };

    class NoStream {
      addEventListener() {}
      close() {}
    }

    function offlineAt(path: string, held: (client: QueryClient) => void) {
      vi.useRealTimers();
      vi.stubGlobal('EventSource', NoStream);
      vi.mocked(fetchMe).mockResolvedValue({ user: { id: 'u', name: 'Michael', role: 'user' } });
      stand({ found: true, connecting: false });
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      held(client);
      window.history.pushState({}, '', path);
      render(
        <QueryClientProvider client={client}>
          <RouterProvider router={createAppRouter(client)} />
        </QueryClientProvider>,
      );
    }

    afterEach(() => vi.unstubAllGlobals());

    it('draws the board from what the client holds, asking the server for nothing', async () => {
      offlineAt('/w/ws-work/d/d1', (client) => {
        client.setQueryData(['workspaces'], savedList);
        client.setQueryData(['snapshot', 'ws-work'], snapshot);
      });

      expect(await screen.findByRole('heading', { name: 'Dashboard 1' })).toBeVisible();
      expect(fetchWorkspaces).not.toHaveBeenCalled();
      expect(fetchSnapshot).not.toHaveBeenCalled();
    });

    it('says so for a Workspace that was never opened here', async () => {
      offlineAt('/w/ws-work/d/d1', (client) => client.setQueryData(['workspaces'], savedList));

      expect(
        await screen.findByText('This device looks offline, and nothing is saved here to show.', {}, { timeout: 5_000 }),
      ).toBeVisible();
      expect(fetchSnapshot).not.toHaveBeenCalled();
    });
  });

  describe('while offline was found, changes are refused with "You\'re working offline"', () => {
    const wrapper = (client: QueryClient) =>
      function Wrap({ children }: { children: React.ReactNode }) {
        return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
      };
    const client = () => new QueryClient({ defaultOptions: { mutations: { networkMode: 'always' } } });
    const payload = (name: 'set_title' | 'capture_item') =>
      ({ name, payload: { workspaceId: 'ws-work', itemId: 'i', commandId: 'c', issuedAt: 'now', title: 't', message: 'm' } }) as never;

    it('does not send a change, and says why', async () => {
      stand({ found: true, connecting: false });
      const { result } = renderHook(() => useCommand(), { wrapper: wrapper(client()) });

      await act(async () => {
        result.current.mutate(payload('set_title'));
      });

      await vi.waitFor(() => expect(refusalFrom(result.current)).toBe("You're working offline"));
      expect(sendCommand).not.toHaveBeenCalled();
    });

    it('still sends a capture, which the outbox holds until the server answers', async () => {
      stand({ found: true, connecting: false });
      vi.mocked(sendCommand).mockResolvedValue({ ok: true } as never);
      const { result } = renderHook(() => useCommand(), { wrapper: wrapper(client()) });

      await act(async () => {
        result.current.mutate(payload('capture_item'));
      });

      expect(sendCommand).toHaveBeenCalledTimes(1);
      expect(refusalFrom(result.current)).toBeNull();
    });
  });
});
