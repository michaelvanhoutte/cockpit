import { useEffect, useState, type ReactNode } from 'react';
import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { notAnswering, realSurroundings, type Surroundings } from './api/loadFailure';
import { workspacesQuery } from './api/queries';
import { CHOSEN_KEY, currentStanding, readChosen, rememberChosen, stand, useStanding } from './offline';
import { restoreSavedReads, saveReadsAsTheyAnswer, tidySavedReads } from './persistence';

/**
 * How Cockpit opens (architecture, "The read model: persisted snapshot,
 * revalidate, push"): **from the server's answer, never from the saved copy.**
 *
 * The app starts *connecting* and holds the router until the first read every
 * signed-in screen needs, the Workspace list, has answered. An answer makes it
 * online, and the saved reads are never drawn. If the request fails outright, or
 * nothing has answered in three seconds, or the device says it is offline, the
 * app is *offline (found)*: the checked saved reads are put in memory and drawn,
 * and an answer that comes later puts it online again and re-reads everything
 * active. Drawing the copy first and re-reading behind it is how an old saved
 * shape reached the screen.
 *
 * Capture and the Car view are the exception: they open at once from the checked
 * saved reads and ask the server behind, because a note must never wait on a
 * connection (architecture, "Capture: the one exception to 'no offline queue'").
 */

/** How long the server has to answer before the saved reads are drawn. */
export const GIVE_UP_AFTER_MS = 3_000;

/** How long a connecting app shows nothing before it says "Loading…". */
export const LOADING_AFTER_MS = 300;

export type HowToOpen =
  /** Wait for the server, up to the limit. */
  | 'server-first'
  /** Draw the checked saved reads at once and ask behind them. */
  | 'saved-first'
  /** A page that reads nothing of the account: the logon page, the guest demo. */
  | 'nothing';

export function howToOpen(pathname: string): HowToOpen {
  if (pathname === '/capture' || pathname.startsWith('/capture/')) return 'saved-first';
  if (pathname === '/signin' || pathname.startsWith('/demo/')) return 'nothing';
  return 'server-first';
}

/**
 * The read opening races, and the one *Try again* repeats: the Workspace list,
 * which every screen under the shell needs first. **Run whatever the switch
 * says** (`networkMode: 'always'`), since asking the server is how offline ends;
 * and without a retry, so a failure is known at once rather than after the
 * backoff.
 */
const askTheServer = (client: QueryClient): Promise<unknown> =>
  client.fetchQuery({ ...workspacesQuery, staleTime: 0, retry: false, networkMode: 'always' });

/** What a read of the server came to: it never rejects, so a late answer can be waited on. */
function outcomeOf(read: Promise<unknown>): Promise<'answered' | 'not-answering'> {
  return read.then(
    () => 'answered' as const,
    // A refusal or a shape this build cannot read is the server answering.
    (error: unknown) => (notAnswering(error) ? ('not-answering' as const) : ('answered' as const)),
  );
}

/** Ends offline that was found, and re-reads everything on screen. Nothing the person chose is ended. */
export function cameOnline(client: QueryClient): void {
  if (!currentStanding().found) return;
  stand({ found: false });
  void client.invalidateQueries();
}

/**
 * Moves to or from working offline without writing the choice down: what a tab
 * does when another tab of this device has changed it. Saved reads are added
 * only for what memory does not hold, and going online re-reads everything on
 * screen.
 */
async function followChoice(client: QueryClient, chosen: boolean): Promise<void> {
  if (chosen) {
    await restoreSavedReads(client).catch(() => {});
    stand({ chosen: true, connecting: false });
  } else {
    stand({ chosen: false, found: false });
    void client.invalidateQueries();
  }
}

/** *Work offline*: remembered on this device, read by every tab. */
export function workOffline(client: QueryClient): Promise<void> {
  rememberChosen(true);
  return followChoice(client, true);
}

/** *Go online*: ends the choice, and offline found with it; the next read that gets no answer finds it again. */
export function goOnline(client: QueryClient): Promise<void> {
  rememberChosen(false);
  return followChoice(client, false);
}

/**
 * Offline found in the middle of a visit: a read, or the live stream, got no
 * answer. What the visit already holds stays, and saved reads fill in what it
 * does not. Ends the way offline found at opening does (cameOnline).
 */
export async function foundOffline(client: QueryClient): Promise<void> {
  const { connecting, found, chosen } = currentStanding();
  if (connecting || found || chosen) return;
  await restoreSavedReads(client).catch(() => {});
  if (!currentStanding().chosen) stand({ found: true });
}

/** Watches reads for one the server did not answer, once the visit is open. */
function watchForSilence(client: QueryClient): () => void {
  return client.getQueryCache().subscribe((event) => {
    if (event.type !== 'updated' || event.action.type !== 'error') return;
    if (notAnswering(event.action.error)) void foundOffline(client);
  });
}

export interface Seams {
  /** The read opening races. */
  ask?: (client: QueryClient) => Promise<unknown>;
  surroundings?: Surroundings;
  giveUpAfterMs?: number;
}

/**
 * *Try again* on the failure screen: races the server once more, and ends
 * offline that was found if it answers.
 */
export async function tryTheServer(client: QueryClient, seams: Seams = {}): Promise<boolean> {
  const { ask = askTheServer, surroundings = realSurroundings, giveUpAfterMs = GIVE_UP_AFTER_MS } = seams;
  if (surroundings.isDefinitelyOffline()) return false;
  const late = outcomeOf(ask(client));
  const first = await Promise.race([late, after(giveUpAfterMs)]);
  // Ended before the caller reads the route again, not left to the handler's
  // turn; an answer after the limit ends it from there.
  if (first === 'answered') cameOnline(client);
  void late.then((outcome) => outcome === 'answered' && cameOnline(client));
  return first === 'answered';
}

function after(ms: number): Promise<'not-answering'> {
  return new Promise((resolve) => setTimeout(() => resolve('not-answering'), ms));
}

/**
 * Opens one visit. Returns what ends it, so a remount does not leave a second
 * open running behind the first.
 */
export function startVisit(client: QueryClient, how: HowToOpen, seams: Seams = {}): () => void {
  const { ask = askTheServer, surroundings = realSurroundings, giveUpAfterMs = GIVE_UP_AFTER_MS } = seams;
  let stopped = false;
  let restored = false;
  const chosen = readChosen();

  const restore = async () => {
    if (restored) return;
    restored = true;
    // A restore that throws still opens the app, from the server alone, rather
    // than leaving it blank on every load.
    await restoreSavedReads(client).catch(() => {});
  };

  const goOffline = async () => {
    await restore();
    if (stopped) return;
    stand({ found: true, connecting: false });
  };

  const findOut = async () => {
    if (surroundings.isDefinitelyOffline()) return goOffline();
    const late = outcomeOf(ask(client));
    const first = await Promise.race([late, after(giveUpAfterMs)]);
    if (stopped) return;
    if (first === 'answered') return stand({ connecting: false });
    await goOffline();
    void late.then((outcome) => {
      if (outcome === 'answered' && !stopped) cameOnline(client);
    });
  };

  void (async () => {
    if (chosen && how !== 'nothing') {
      // Working offline is remembered: nothing is asked of the server, and the
      // saved reads are drawn at once.
      await restore();
      if (!stopped) stand({ connecting: false, chosen: true });
    } else if (how === 'nothing') {
      void tidySavedReads().catch(() => {});
      stand({ connecting: false, chosen });
    } else if (how === 'server-first') {
      void tidySavedReads().catch(() => {});
      await findOut();
    } else {
      await restore();
      if (stopped) return;
      stand({ connecting: false });
      void client.invalidateQueries();
      // Asked behind the open screen: a server that does not answer makes the
      // rest of the visit offline, which the screen is already drawn from.
      const late = outcomeOf(
        surroundings.isDefinitelyOffline() ? Promise.reject(new TypeError('offline')) : ask(client),
      );
      const first = await Promise.race([late, after(giveUpAfterMs)]);
      if (stopped || first === 'answered') return;
      stand({ found: true });
      void late.then((outcome) => {
        if (outcome === 'answered' && !stopped) cameOnline(client);
      });
    }
  })();

  return () => {
    stopped = true;
  };
}

/**
 * The query client's provider, with the visit opened under it and every answer
 * saved as it comes (`persistence.tsx`). Above the new-version check so the two
 * start together: opening is held for the slower of them, not for both in turn.
 */
export function Opening({
  client,
  how = howToOpen(globalThis.location?.pathname ?? '/'),
  seams,
  children,
}: {
  client: QueryClient;
  how?: HowToOpen;
  seams?: Seams;
  children: ReactNode;
}) {
  useEffect(() => {
    const stopSaving = saveReadsAsTheyAnswer(client);
    const stopVisit = startVisit(client, how, seams);
    const stopWatching = watchForSilence(client);
    // Another tab of this device chose, or ended, working offline.
    const followOtherTabs = (event: StorageEvent) => {
      if (event.key === CHOSEN_KEY || event.key === null) void followChoice(client, readChosen());
    };
    window.addEventListener('storage', followOtherTabs);
    return () => {
      window.removeEventListener('storage', followOtherTabs);
      stopWatching();
      stopVisit();
      stopSaving();
    };
  }, [client, how, seams]);
  return (
    <QueryClientProvider client={client}>
      {children}
      <LoadingLine />
    </QueryClientProvider>
  );
}

/**
 * Holds what is inside until the visit has decided between the server and the
 * saved reads, so nothing reads the cache before it is what the screen is drawn
 * from.
 */
export function HoldForTheServer({ children }: { children: ReactNode }) {
  const { connecting } = useStanding();
  return connecting ? null : children;
}

/**
 * Nothing for 300 ms, then one quiet line in the faint text the failure screen
 * already uses. Over the page rather than in it, since what it stands in for is
 * not mounted yet.
 */
function LoadingLine() {
  const { connecting } = useStanding();
  const [showing, setShowing] = useState(false);
  useEffect(() => {
    if (!connecting) {
      setShowing(false);
      return;
    }
    const timer = setTimeout(() => setShowing(true), LOADING_AFTER_MS);
    return () => clearTimeout(timer);
  }, [connecting]);
  if (!connecting || !showing) return null;
  return (
    <p
      role="status"
      className="pointer-events-none fixed inset-0 z-40 flex items-center justify-center text-sm text-ink-faint"
    >
      Loading…
    </p>
  );
}
