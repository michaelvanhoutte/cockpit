import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { clear, createStore, del, entries, get, set } from 'idb-keyval';
import type { WorkspaceSnapshot } from '@cockpit/shared';
import {
  CACHE_MAX_AGE_MS,
  restoreSavedReads,
  saveRead,
  saveReadsAsTheyAnswer,
  tidySavedReads,
} from '../../src/persistence';
import { changes } from '../../src/api/changes';
import { fetchSnapshot, sendCommand } from '../../src/api/client';
import { useSnapshot } from '../../src/api/useSnapshot';
import { aWorkspace, anItem, itemId } from './support/savedReads';

vi.mock('../../src/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/api/client')>()),
  fetchSnapshot: vi.fn(),
  sendCommand: vi.fn(),
}));

/**
 * F1: what a visit does with the reads the last ones saved, against a fake
 * IndexedDB. Whether a saved read converts is tests/unit/savedReads.test.ts;
 * here it is what is drawn, what is asked, and what is kept on disk.
 *
 * That a *sign-out* empties it is tests/unit/session/forget.test.ts, and
 * against the real browser tests/e2e/sign-in.test.ts.
 */

const WORK = ['snapshot', 'ws-work'];
const HOME = ['snapshot', 'ws-home'];
const DAY = 24 * 60 * 60 * 1000;

const savedReads = createStore('cockpit-saved-reads', 'reads');
const outbox = createStore('cockpit-capture-outbox', 'entries');

const titled = (title: string) => aWorkspace([anItem(1, { title })]);

async function savedAt(key: readonly unknown[]): Promise<number | undefined> {
  const found = await entries<string, { queryKey: unknown[]; savedAt: number }>(savedReads);
  return found.find(([, read]) => JSON.stringify(read.queryKey) === JSON.stringify(key))?.[1].savedAt;
}

async function savedKeys(): Promise<string[]> {
  const found = await entries<string, { queryKey: unknown[] }>(savedReads);
  return found.map(([, read]) => String(read.queryKey[0])).sort();
}

/** A screen reading one Workspace the way the app reads it: from the cache, asked again once stale. */
function Screen({ queryKey, theServer }: { queryKey: unknown[]; theServer: () => Promise<WorkspaceSnapshot> }) {
  const { data, isError } = useQuery({ queryKey, queryFn: theServer, staleTime: 15_000 });
  return (
    <>
      <p>{data ? data.items.map((item) => item.title).join(', ') : 'nothing yet'}</p>
      {isError && <p>could not reach the server</p>}
    </>
  );
}

const offline = () => Promise.reject(new Error('offline'));

/**
 * The offline half of an open: the saved reads put in memory, a screen reading
 * one Workspace over them, and every answer saved as it comes.
 */
async function open(
  theServer: () => Promise<WorkspaceSnapshot>,
  queryKey: unknown[] = WORK,
): Promise<QueryClient> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  saveReadsAsTheyAnswer(client);
  await restoreSavedReads(client);
  render(
    <QueryClientProvider client={client}>
      <Screen queryKey={queryKey} theServer={theServer} />
    </QueryClientProvider>,
  );
  return client;
}

beforeEach(async () => {
  await clear(savedReads);
  await clear(outbox);
  await del('cockpit-query-cache-v1');
});

/** The Workspace as the app draws it: the server's copy with this tab's unanswered changes over it. */
function TheWorkspace() {
  const { data } = useSnapshot('ws-work');
  return <p>{data ? data.items.map((item) => item.title).join(', ') : 'nothing yet'}</p>;
}

describe('Offline', () => {
  describe('a change still waiting for the server is never saved on this device', () => {
    it('saves the copy the server sent while the screen draws the change over it', async () => {
      vi.mocked(fetchSnapshot).mockResolvedValue(titled('from the server'));
      // Taken by the server and never answered, so it is still waiting when the read is saved.
      vi.mocked(sendCommand).mockImplementation(() => new Promise(() => {}));
      void changes.enqueue({
        name: 'set_title',
        payload: { commandId: 'c1', issuedAt: '2026-10-20T09:00:00.000Z', workspaceId: 'ws-work', itemId: itemId(1), title: 'Renamed here' },
      });
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      saveReadsAsTheyAnswer(client);

      render(
        <QueryClientProvider client={client}>
          <TheWorkspace />
        </QueryClientProvider>,
      );

      expect(await screen.findByText('Renamed here')).toBeInTheDocument();
      await vi.waitFor(async () => {
        const [saved] = await entries<string, { data: WorkspaceSnapshot }>(savedReads);
        expect(saved?.[1].data.items.map((item) => item.title)).toEqual(['from the server']);
      });
    });
  });

  describe('what is saved is drawn only when the open goes offline, and only if it converts', () => {
    it('draws the checked saved read', async () => {
      await saveRead({ queryKey: WORK, data: titled('three panels'), savedAt: Date.now() });

      await open(() => new Promise(() => {}));

      expect(await screen.findByText('three panels')).toBeInTheDocument();
    });

    it('keeps what the client already holds over what was saved', async () => {
      await saveRead({ queryKey: WORK, data: titled('three panels'), savedAt: Date.now() });
      const client = new QueryClient();
      client.setQueryData(WORK, titled('four panels'));

      await restoreSavedReads(client);

      expect(client.getQueryData<WorkspaceSnapshot>(WORK)?.items[0]?.title).toBe('four panels');
    });

    it('restores once when asked twice at the same time, so the second does not clear what the first recorded', async () => {
      await saveRead({ queryKey: WORK, data: titled('three panels'), savedAt: Date.now() });
      const client = new QueryClient();

      const first = restoreSavedReads(client);
      const second = restoreSavedReads(client);

      expect(second).toBe(first);
      await first;
      expect(client.getQueryData<WorkspaceSnapshot>(WORK)?.items[0]?.title).toBe('three panels');
    });

    it('draws nothing from a saved read this version cannot convert', async () => {
      await saveRead({ queryKey: WORK, data: { ...titled('three panels'), layouts: 'old' }, savedAt: Date.now() });

      await open(offline);

      expect(await screen.findByText('could not reach the server')).toBeInTheDocument();
      expect(screen.getByText('nothing yet')).toBeInTheDocument();
    });
  });

  describe('each read is saved on its own, and replaced only by its own next answer', () => {
    it('keeps a Workspace saved yesterday when only another one is read today', async () => {
      await saveRead({ queryKey: WORK, data: titled('from yesterday'), savedAt: Date.now() - DAY });
      await open(() => Promise.resolve(titled('home today')), HOME);
      expect(await screen.findByText('home today')).toBeInTheDocument();
      await vi.waitFor(async () => expect(await savedKeys()).toEqual(['snapshot', 'snapshot']));
      cleanup();

      await open(offline, WORK);

      expect(await screen.findByText('from yesterday')).toBeInTheDocument();
    });

    it('moves the saved time of the read that answered, and of no other', async () => {
      const yesterday = Date.now() - DAY;
      await saveRead({ queryKey: WORK, data: titled('work'), savedAt: yesterday });
      await saveRead({ queryKey: HOME, data: titled('home'), savedAt: yesterday });

      await open(() => Promise.resolve(titled('work again')), WORK);
      expect(await screen.findByText('work again')).toBeInTheDocument();

      await vi.waitFor(async () => expect(await savedAt(WORK)).toBeGreaterThan(yesterday));
      expect(await savedAt(HOME)).toBe(yesterday);
    });

    it('opens past a record in a shape this version never writes, and deletes it', async () => {
      // What a later version may leave behind before a rollback.
      await set('a-later-shape', { key: WORK, data: titled('three panels') }, savedReads);

      await open(() => Promise.resolve(titled('four panels')));

      expect(await screen.findByText('four panels')).toBeInTheDocument();
      await vi.waitFor(async () => expect(await get('a-later-shape', savedReads)).toBeUndefined());
    });

    it('does not draw a read saved over a week ago', async () => {
      await saveRead({ queryKey: WORK, data: titled('last month'), savedAt: Date.now() - CACHE_MAX_AGE_MS - DAY });

      await open(offline);

      expect(await screen.findByText('could not reach the server')).toBeInTheDocument();
      expect(screen.getByText('nothing yet')).toBeInTheDocument();
    });

    it('never saves the register or a connection’s history', async () => {
      const client = await open(() => Promise.resolve(titled('three panels')));
      expect(await screen.findByText('three panels')).toBeInTheDocument();

      client.setQueryData(['registeredUsers'], { users: [] });
      client.setQueryData(['connectionHistory', 'ws-work', 'account-anna'], { lines: [] });
      client.setQueryData(['me'], { user: { id: 'user-anna', name: 'Anna', role: 'user' } });

      await vi.waitFor(async () => expect(await savedKeys()).toEqual(['me', 'snapshot']));
    });
  });

  describe('an open that goes to the server still clears out what can no longer be read', () => {
    it('deletes the old single copy and a read saved over a week ago, and draws nothing', async () => {
      await set('cockpit-query-cache-v1', { clientState: { queries: [] } });
      await saveRead({ queryKey: WORK, data: titled('last month'), savedAt: Date.now() - CACHE_MAX_AGE_MS - DAY });
      await saveRead({ queryKey: HOME, data: titled('yesterday'), savedAt: Date.now() - DAY });

      await tidySavedReads();

      expect(await get('cockpit-query-cache-v1')).toBeUndefined();
      expect(await savedKeys()).toEqual(['snapshot']);
    });
  });

  describe('captures waiting to send survive a new version', () => {
    it('deletes the one saved copy earlier versions kept, and leaves the outbox as it was', async () => {
      await set('cockpit-query-cache-v1', { clientState: { queries: [] } });
      await set('capture-1', { text: 'Call Ann' }, outbox);

      await open(offline);
      await screen.findByText('could not reach the server');

      expect(await get('cockpit-query-cache-v1')).toBeUndefined();
      expect(await get('capture-1', outbox)).toEqual({ text: 'Call Ann' });
    });
  });
});
