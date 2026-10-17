import 'fake-indexeddb/auto';
import { useEffect } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { QueryClient, useQuery } from '@tanstack/react-query';
import { clear, createStore, del, entries, get, set } from 'idb-keyval';
import type { WorkspaceSnapshot } from '@cockpit/shared';
import {
  CACHE_MAX_AGE_MS,
  PaintedFromTheStoredCopy,
  saveRead,
} from '../../src/persistence';
import { aWorkspace, anItem } from './support/savedReads';

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

/** A server that has not answered yet, and a hand on when it does. */
function aServerSaying(what: WorkspaceSnapshot): [() => Promise<WorkspaceSnapshot>, () => void] {
  let answer: () => void = () => {};
  const answered = new Promise<WorkspaceSnapshot>((resolve) => {
    answer = () => resolve(what);
  });
  return [() => answered, () => answer()];
}

const offline = () => Promise.reject(new Error('offline'));

function open(theServer: () => Promise<WorkspaceSnapshot>, queryKey: unknown[] = WORK): QueryClient {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <PaintedFromTheStoredCopy client={client}>
      <Screen queryKey={queryKey} theServer={theServer} />
    </PaintedFromTheStoredCopy>,
  );
  return client;
}

beforeEach(async () => {
  await clear(savedReads);
  await clear(outbox);
  await del('cockpit-query-cache-v1');
});

describe('Offline', () => {
  describe('opening Cockpit draws the checked saved read and then what the server has', () => {
    it('draws the saved read before the server has said anything', async () => {
      await saveRead({ queryKey: WORK, data: titled('three panels'), savedAt: Date.now() });
      const [theServer] = aServerSaying(titled('four panels'));

      open(theServer);

      expect(await screen.findByText('three panels')).toBeInTheDocument();
    });

    it('asks anyway, however recently the read was saved', async () => {
      // Saved a moment ago, which is the case that goes wrong: a read this
      // fresh is one nothing would otherwise re-read, so a change made just
      // before the page was thrown away would stay missing.
      await saveRead({ queryKey: WORK, data: titled('three panels'), savedAt: Date.now() });
      const [theServer, answer] = aServerSaying(titled('four panels'));

      open(theServer);
      expect(await screen.findByText('three panels')).toBeInTheDocument();
      await act(async () => answer());

      expect(await screen.findByText('four panels')).toBeInTheDocument();
    });

    it('has the saved read in hand before anything beneath it reads it', async () => {
      // What the router does on mount: take what the cache holds, and go to the
      // server only for what it does not.
      await saveRead({ queryKey: WORK, data: titled('three panels'), savedAt: Date.now() });
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const server = vi.fn(offline);
      let found: WorkspaceSnapshot | undefined;
      function ReadsOnMount() {
        useEffect(() => {
          void client
            .ensureQueryData({ queryKey: WORK, queryFn: server })
            .then((data) => {
              found = data;
            })
            .catch(() => {});
        }, []);
        return null;
      }

      render(
        <PaintedFromTheStoredCopy client={client}>
          <ReadsOnMount />
        </PaintedFromTheStoredCopy>,
      );

      await vi.waitFor(() => expect(found?.items[0]?.title).toBe('three panels'));
      expect(server).not.toHaveBeenCalled();
    });

    it('leaves the saved read on screen when the server cannot be reached', async () => {
      await saveRead({ queryKey: WORK, data: titled('three panels'), savedAt: Date.now() });

      open(offline);

      // The failure is waited for, not the read: it is on screen from the first
      // paint, before a re-read has been attempted.
      expect(await screen.findByText('could not reach the server')).toBeInTheDocument();
      expect(screen.getByText('three panels')).toBeInTheDocument();
    });

    it('draws nothing from a saved read this version cannot convert', async () => {
      await saveRead({ queryKey: WORK, data: { ...titled('three panels'), layouts: 'old' }, savedAt: Date.now() });

      open(offline);

      expect(await screen.findByText('could not reach the server')).toBeInTheDocument();
      expect(screen.getByText('nothing yet')).toBeInTheDocument();
    });
  });

  describe('each read is saved on its own, and replaced only by its own next answer', () => {
    it('keeps a Workspace saved yesterday when only another one is read today', async () => {
      await saveRead({ queryKey: WORK, data: titled('from yesterday'), savedAt: Date.now() - DAY });
      open(() => Promise.resolve(titled('home today')), HOME);
      expect(await screen.findByText('home today')).toBeInTheDocument();
      await vi.waitFor(async () => expect(await savedKeys()).toEqual(['snapshot', 'snapshot']));
      cleanup();

      open(offline, WORK);

      expect(await screen.findByText('from yesterday')).toBeInTheDocument();
    });

    it('moves the saved time of the read that answered, and of no other', async () => {
      const yesterday = Date.now() - DAY;
      await saveRead({ queryKey: WORK, data: titled('work'), savedAt: yesterday });
      await saveRead({ queryKey: HOME, data: titled('home'), savedAt: yesterday });

      open(() => Promise.resolve(titled('work again')), WORK);
      expect(await screen.findByText('work again')).toBeInTheDocument();

      await vi.waitFor(async () => expect(await savedAt(WORK)).toBeGreaterThan(yesterday));
      expect(await savedAt(HOME)).toBe(yesterday);
    });

    it('opens past a record in a shape this version never writes, and deletes it', async () => {
      // What a later version may leave behind before a rollback.
      await set('a-later-shape', { key: WORK, data: titled('three panels') }, savedReads);

      open(() => Promise.resolve(titled('four panels')));

      expect(await screen.findByText('four panels')).toBeInTheDocument();
      await vi.waitFor(async () => expect(await get('a-later-shape', savedReads)).toBeUndefined());
    });

    it('does not draw a read saved over a week ago', async () => {
      await saveRead({ queryKey: WORK, data: titled('last month'), savedAt: Date.now() - CACHE_MAX_AGE_MS - DAY });

      open(offline);

      expect(await screen.findByText('could not reach the server')).toBeInTheDocument();
      expect(screen.getByText('nothing yet')).toBeInTheDocument();
    });

    it('never saves the register or a connection’s history', async () => {
      const client = open(() => Promise.resolve(titled('three panels')));
      expect(await screen.findByText('three panels')).toBeInTheDocument();

      client.setQueryData(['registeredUsers'], { users: [] });
      client.setQueryData(['connectionHistory', 'ws-work', 'account-anna'], { lines: [] });
      client.setQueryData(['me'], { user: { id: 'user-anna', name: 'Anna', role: 'user' } });

      await vi.waitFor(async () => expect(await savedKeys()).toEqual(['me', 'snapshot']));
    });
  });

  describe('captures waiting to send survive a new version', () => {
    it('deletes the one saved copy earlier versions kept, and leaves the outbox as it was', async () => {
      await set('cockpit-query-cache-v1', { clientState: { queries: [] } });
      await set('capture-1', { text: 'Call Ann' }, outbox);

      open(offline);
      await screen.findByText('could not reach the server');

      expect(await get('cockpit-query-cache-v1')).toBeUndefined();
      expect(await get('capture-1', outbox)).toEqual({ text: 'Call Ann' });
    });
  });
});
