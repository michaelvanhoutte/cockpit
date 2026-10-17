import { useEffect, useState, type ReactNode } from 'react';
import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { notAnswering, realSurroundings, type Surroundings } from './api/loadFailure';
import { workspacesQuery } from './api/queries';
import { currentStanding, stand, useStanding } from './offline';
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
    if (how === 'nothing') {
      void tidySavedReads().catch(() => {});
      stand({ connecting: false });
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
    return () => {
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
