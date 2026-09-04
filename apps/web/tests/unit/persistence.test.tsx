import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { QueryClient, useQuery } from '@tanstack/react-query';
import { persistQueryClientSave } from '@tanstack/react-query-persist-client';
import { CACHE_BUSTER, PaintedFromTheStoredCopy, persister } from '../../src/persistence';

/**
 * F1: what a visit does with the copy the last one left behind. The rules are
 * about wiring rather than logic - the copy is drawn without waiting, and it is
 * still asked about - so they are stated as what ends up on screen.
 *
 * The browser's own storage is the boundary being replaced, at the edge:
 * `idb-keyval` is the whole of what this module asks of IndexedDB, and jsdom
 * has none. That a *sign-out* empties it is proved against the real thing in
 * tests/e2e/sign-in.test.ts; nothing here re-proves it.
 *
 * The walk that says a resize really survives the page being thrown away is
 * tests/e2e/panels.test.ts. It reaches this rule only when the timing is
 * against it, which is why the rule is stated here as well: a stored copy
 * written a second ago is exactly the one `staleTime` would call fresh.
 */

const stored = new Map<string, unknown>();
vi.mock('idb-keyval', () => ({
  get: (key: string) => Promise.resolve(stored.get(key)),
  set: (key: string, value: unknown) => {
    stored.set(key, value);
    return Promise.resolve();
  },
  del: (key: string) => {
    stored.delete(key);
    return Promise.resolve();
  },
}));

const WHAT_THE_WORKSPACE_HOLDS = ['snapshot', 'ws-work'];

/** A copy written by a visit that has just ended, so nothing about it is old. */
async function aStoredCopySaying(what: string): Promise<void> {
  const lastVisit = new QueryClient();
  lastVisit.setQueryData(WHAT_THE_WORKSPACE_HOLDS, what);
  await persistQueryClientSave({ queryClient: lastVisit, persister, buster: CACHE_BUSTER });
}

/**
 * A screen reading the workspace the way the app reads it: from the cache,
 * which is asked again only when what it holds has gone stale.
 */
function Screen({ theServer }: { theServer: () => Promise<string> }) {
  const { data } = useQuery({
    queryKey: WHAT_THE_WORKSPACE_HOLDS,
    queryFn: theServer,
    staleTime: 15_000,
  });
  return <p>{data ?? 'nothing yet'}</p>;
}

/** A server that has not answered yet, and a hand on when it does. */
function aServerSaying(what: string): [() => Promise<string>, () => void] {
  let answer: () => void = () => {};
  const answered = new Promise<string>((resolve) => {
    answer = () => resolve(what);
  });
  return [() => answered, () => answer()];
}

function open(theServer: () => Promise<string>) {
  render(
    <PaintedFromTheStoredCopy client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <Screen theServer={theServer} />
    </PaintedFromTheStoredCopy>,
  );
}

beforeEach(() => {
  stored.clear();
});

describe('Offline', () => {
  describe('opening Cockpit draws the copy it already holds and then what the server has', () => {
    it('draws the copy before the server has said anything', async () => {
      await aStoredCopySaying('three panels');
      const [theServer] = aServerSaying('four panels');

      open(theServer);

      expect(await screen.findByText('three panels')).toBeInTheDocument();
    });

    it('asks anyway, however recently the copy was written', async () => {
      // Written a moment ago, which is the case that goes wrong: a copy this
      // fresh is one nothing would otherwise re-read, so a change made just
      // before the page was thrown away would be missing from what is drawn
      // and stay missing.
      await aStoredCopySaying('three panels');
      const [theServer, answer] = aServerSaying('four panels');

      open(theServer);
      expect(await screen.findByText('three panels')).toBeInTheDocument();
      await act(async () => answer());

      expect(await screen.findByText('four panels')).toBeInTheDocument();
    });

    it('leaves the copy on screen when the server cannot be reached', async () => {
      await aStoredCopySaying('three panels');

      open(() => Promise.reject(new Error('offline')));

      expect(await screen.findByText('three panels')).toBeInTheDocument();
    });
  });
});
