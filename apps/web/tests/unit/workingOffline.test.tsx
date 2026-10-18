import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, renderHook, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider, skipToken, useQuery } from '@tanstack/react-query';

import type { Workspace } from '@cockpit/shared';
import { GoOnlineOffer } from '../../src/components/OfflineMark';
import { mayReachServer } from '../../src/captureOutboxSender';
import { CHOSEN_KEY, isOffline, readChosen, refuseWhileOffline, resetStanding, stand, currentStanding } from '../../src/offline';
import { HoldForTheServer, Opening, foundOffline, goOnline, workOffline, type Seams } from '../../src/opening';
import { forgetEverySavedRead, saveRead } from '../../src/persistence';
import { useServerEvents } from '../../src/api/useServerEvents';
import { diagnoseConnection } from '../../src/api/loadFailure';

/**
 * F1: working offline, chosen from the account menu. The Offline mark and the
 * menu entry are in tests/unit/pages/offlineMark.test.tsx; the walk through the
 * real app is tests/e2e/offline.test.ts.
 */
vi.mock('../../src/api/loadFailure', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/api/loadFailure')>()),
  diagnoseConnection: vi.fn(),
}));

const work: Workspace = { id: 'ws-work', tenantId: 'tenant', name: 'Work', color: '#6f62b5', bar: '#dbd7ee', ground: '#e3e1f2', header: '#d2cdea' };
const savedList = { workspaces: [{ ...work, name: 'Saved Work' }] };
const freshList = { workspaces: [{ ...work, name: 'Fresh Work' }] };

function Names() {
  const { data } = useQuery({ queryKey: ['workspaces'], queryFn: skipToken });
  return <p>{(data as typeof freshList | undefined)?.workspaces.map((w) => w.name).join(', ') ?? 'no list'}</p>;
}

const seams = (read: () => Promise<unknown>): Seams => ({
  surroundings: { isDefinitelyOffline: () => false, reachServer: async () => 'reachable' },
  ask: (client) => client.fetchQuery({ queryKey: ['workspaces'], queryFn: read, staleTime: 0, retry: false, networkMode: 'always' }),
});

function openApp(read: () => Promise<unknown>) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <Opening client={client} how="server-first" seams={seams(read)}>
      <HoldForTheServer>
        <Names />
      </HoldForTheServer>
    </Opening>,
  );
  return client;
}

const wrapperFor = (client: QueryClient) =>
  function Wrap({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };

beforeEach(async () => {
  resetStanding();
  stand({ connecting: true });
  await forgetEverySavedRead();
  await saveRead({ queryKey: ['workspaces'], data: savedList, savedAt: Date.now() });
});

afterEach(() => {
  cleanup();
  resetStanding();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('Offline', () => {
  describe('working offline reads nothing and draws only what was saved', () => {
    it('draws a saved read memory does not hold, asking the server for nothing', async () => {
      const client = new QueryClient();
      const read = vi.fn(() => Promise.resolve('read'));
      stand({ connecting: false });
      render(<QueryClientProvider client={client}><Names /></QueryClientProvider>);
      renderHook(() => useQuery({ queryKey: ['never-saved'], queryFn: read }), { wrapper: wrapperFor(client) });
      await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));

      await act(() => workOffline(client));
      await act(() => client.invalidateQueries());

      expect(await screen.findByText('Saved Work')).toBeInTheDocument();
      expect(read).toHaveBeenCalledTimes(1);
      expect(isOffline()).toBe(true);
    });

    it('keeps what the visit already holds over a saved read', async () => {
      const client = new QueryClient();
      client.setQueryData(['workspaces'], freshList);
      stand({ connecting: false });
      render(<QueryClientProvider client={client}><Names /></QueryClientProvider>);

      await act(() => workOffline(client));

      expect(screen.getByText('Fresh Work')).toBeInTheDocument();
      expect(screen.queryByText('Saved Work')).toBeNull();
    });
  });

  describe('working offline is remembered on this device; offline found never is', () => {
    it('opens a reload from the saved reads at once, asking the server nothing', async () => {
      localStorage.setItem(CHOSEN_KEY, '1');
      const read = vi.fn(() => new Promise<never>(() => {}));

      openApp(read);

      expect(await screen.findByText('Saved Work')).toBeInTheDocument();
      expect(read).not.toHaveBeenCalled();
      expect(currentStanding()).toMatchObject({ chosen: true, found: false, connecting: false });
    });

    it('races the server again on a reload after offline was found', async () => {
      const read = vi.fn(() => Promise.reject(new TypeError('Failed to fetch')));
      openApp(read);
      await vi.waitFor(() => expect(currentStanding().found).toBe(true));
      expect(readChosen()).toBe(false);
      cleanup();
      stand({ connecting: true, found: false });
      read.mockClear();

      openApp(read);

      await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    });

    it('is followed by another tab of this device, and ended by it', async () => {
      const client = openApp(() => Promise.resolve(freshList));
      await screen.findByText('Fresh Work');
      const reread = vi.fn(() => Promise.resolve('again'));
      renderHook(() => useQuery({ queryKey: ['on-screen'], queryFn: reread }), { wrapper: wrapperFor(client) });
      await vi.waitFor(() => expect(reread).toHaveBeenCalledTimes(1));

      localStorage.setItem(CHOSEN_KEY, '1');
      act(() => void window.dispatchEvent(new StorageEvent('storage', { key: CHOSEN_KEY })));
      await vi.waitFor(() => expect(currentStanding().chosen).toBe(true));

      localStorage.removeItem(CHOSEN_KEY);
      act(() => void window.dispatchEvent(new StorageEvent('storage', { key: CHOSEN_KEY })));
      await vi.waitFor(() => expect(currentStanding().chosen).toBe(false));
      await vi.waitFor(() => expect(reread).toHaveBeenCalledTimes(2));
    });
  });

  describe('Go online ends offline and re-reads everything on screen', () => {
    it.each([
      { situation: 'chosen', start: () => workOffline },
      { situation: 'found', start: () => async (client: QueryClient) => void (await foundOffline(client)) },
    ])('after it was $situation', async ({ start }) => {
      const client = new QueryClient();
      stand({ connecting: false });
      const reread = vi.fn(() => Promise.resolve('again'));
      renderHook(() => useQuery({ queryKey: ['on-screen'], queryFn: reread, staleTime: Infinity }), {
        wrapper: wrapperFor(client),
      });
      await vi.waitFor(() => expect(reread).toHaveBeenCalledTimes(1));
      await act(() => start()(client));
      expect(isOffline()).toBe(true);

      await act(() => goOnline(client));

      expect(isOffline()).toBe(false);
      expect(readChosen()).toBe(false);
      await vi.waitFor(() => expect(reread).toHaveBeenCalledTimes(2));
    });
  });

  describe('offline is also found in the middle of a visit', () => {
    it.each([
      { situation: 'a read that fails outright', error: new TypeError('Failed to fetch'), offline: true },
      { situation: 'a read answered by a gateway with 502', error: new Error('snapshot failed: 502'), offline: true },
      { situation: 'a read the server refuses', error: new Error('snapshot failed: 403'), offline: false },
    ])('$situation', async ({ error, offline }) => {
      vi.mocked(diagnoseConnection).mockResolvedValue('offline');
      const client = openApp(() => Promise.resolve(freshList));
      await screen.findByText('Fresh Work');

      renderHook(() => useQuery({ queryKey: ['on-screen'], queryFn: () => Promise.reject(error) }), {
        wrapper: wrapperFor(client),
      });

      await vi.waitFor(() => expect(isOffline()).toBe(offline));
      expect(readChosen()).toBe(false);
    });

    it('stays online when a read fails but the server can still be reached', async () => {
      vi.mocked(diagnoseConnection).mockResolvedValue('trouble');
      const client = openApp(() => Promise.resolve(freshList));
      await screen.findByText('Fresh Work');

      renderHook(() => useQuery({ queryKey: ['on-screen'], queryFn: () => Promise.reject(new TypeError('Failed to fetch')) }), {
        wrapper: wrapperFor(client),
      });

      await vi.waitFor(() => expect(diagnoseConnection).toHaveBeenCalled());
      await act(async () => {});
      expect(isOffline()).toBe(false);
    });

    it('does not flip while the open is still waiting on the server', async () => {
      const client = new QueryClient();
      await foundOffline(client);
      expect(currentStanding().found).toBe(false);
    });

    describe('the live stream', () => {
      const streams: FakeStream[] = [];
      class FakeStream {
        static CLOSED = 2;
        readyState = 0;
        listeners = new Map<string, () => void>();
        constructor() {
          streams.push(this);
        }
        addEventListener(type: string, listener: () => void) {
          this.listeners.set(type, listener);
        }
        close() {
          this.readyState = 2;
        }
      }
      beforeEach(() => {
        streams.length = 0;
        vi.stubGlobal('EventSource', FakeStream);
        stand({ connecting: false });
      });

      it('finds offline when it keeps failing and the server cannot be reached', async () => {
        vi.mocked(diagnoseConnection).mockResolvedValue('offline');
        const client = new QueryClient();
        renderHook(() => useServerEvents(), { wrapper: wrapperFor(client) });

        act(() => streams[0]!.listeners.get('error')!());

        await vi.waitFor(() => expect(isOffline()).toBe(true));
      });

      it('stays online when the server can still be reached', async () => {
        vi.mocked(diagnoseConnection).mockResolvedValue('trouble');
        const client = new QueryClient();
        renderHook(() => useServerEvents(), { wrapper: wrapperFor(client) });

        act(() => streams[0]!.listeners.get('error')!());
        await act(async () => {});

        expect(isOffline()).toBe(false);
      });

      it('is closed while working offline and opened again on Go online', async () => {
        const client = new QueryClient();
        renderHook(() => useServerEvents(), { wrapper: wrapperFor(client) });
        expect(streams).toHaveLength(1);

        await act(() => workOffline(client));
        expect(streams[0]!.readyState).toBe(2);
        expect(streams).toHaveLength(1);

        await act(() => goOnline(client));
        expect(streams).toHaveLength(2);
        expect(streams[1]!.readyState).toBe(0);
      });
    });
  });

  describe('while working offline a capture waits and other changes are refused with Go online offered', () => {
    it('does not let the outbox send while chosen, and lets it again after Go online', async () => {
      const client = new QueryClient();
      stand({ connecting: false });
      expect(mayReachServer()).toBe(true);

      await workOffline(client);
      expect(mayReachServer()).toBe(false);

      await goOnline(client);
      expect(mayReachServer()).toBe(true);
    });

    it('offers Go online when a change is refused, and Go online ends it', async () => {
      const user = userEvent.setup();
      const client = new QueryClient();
      stand({ connecting: false });
      await workOffline(client);
      render(
        <QueryClientProvider client={client}>
          <GoOnlineOffer />
        </QueryClientProvider>,
      );
      expect(screen.queryByRole('button', { name: 'Go online' })).toBeNull();

      act(() => expect(() => refuseWhileOffline()).toThrow("You're working offline"));
      await user.click(await screen.findByRole('button', { name: 'Go online' }));

      expect(isOffline()).toBe(false);
      expect(screen.queryByRole('button', { name: 'Go online' })).toBeNull();
    });
  });
});
