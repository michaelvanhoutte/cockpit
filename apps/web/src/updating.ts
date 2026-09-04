/**
 * Picking up a new version of Cockpit (functional definition, Glossary,
 * "Updating").
 *
 * **A version mismatch is a gate, not a failure.** The sign-in is valid, the
 * data is fine and the work could carry on — the only thing wrong is that this
 * browser is running code older than the answers it is being given. So the app
 * stops, fetches the new version and carries on where it was, rather than
 * explaining itself and waiting to be clicked.
 *
 * **It stops the whole window rather than saying so in a panel**, because the
 * stored copy is no safer than the network answer. The persisted snapshot is
 * rehydrated from IndexedDB *without being parsed again* (main.tsx) — the
 * schemas guard the way in from the network, not the way out of storage — so a
 * build that cannot read what the server says cannot trust what it already
 * holds either. Carrying on is the one thing that is actively wrong.
 *
 * **Why reloading by hand never worked.** The shell is precached by a service
 * worker (apps/web/vite.config.ts). A reload does make the browser look for a
 * new `sw.js`, but the navigation it looks *during* has already been answered
 * from the old precache; the new worker installs, skips waiting and claims the
 * page a moment later, far too late for the page now on screen. So the second
 * reload would have worked and the first never could — and nobody clicks twice
 * on a button that does nothing. Waiting for the check before reloading is the
 * whole fix.
 *
 * **And "nothing newer" is conclusive rather than a guess.** `sw.js` carries
 * the precache manifest, which is content-hashed, so any changed asset changes
 * it. An update check that installs no new worker proves the server is serving
 * this same build — which is when reloading is futile however many times it is
 * asked for, and when saying so is the only honest thing left.
 */

/** A shape the server sent that this build cannot read: the whole condition. */
export function outOfDate(error: unknown): boolean {
  return error instanceof Error && error.name === 'ZodError';
}

/** What came of asking for a newer version. */
export type Update =
  /** One was there; the page is on its way to it. */
  | 'taken'
  /** There was none to take, so reloading would land on this same build. */
  | 'nothing-new';

/**
 * The two things about the browser that a test cannot have and must not need,
 * injected the way `Surroundings` is in api/loadFailure.ts.
 */
export interface Versions {
  /** Asks whatever precaches the shell to go and look for a newer one. */
  newVersionWaiting(): Promise<boolean>;
  reload(): void;
}

export const realVersions: Versions = {
  newVersionWaiting: async () => {
    const workers: ServiceWorkerContainer | undefined = globalThis.navigator?.serviceWorker;
    // Nothing precaching the shell — the dev server, or a browser without
    // service workers. A reload genuinely fetches whatever the server now has,
    // so there is nothing to ask and no reason to hold it up.
    if (!workers) return true;
    const registration = await workers.getRegistration();
    if (!registration) return true;
    await registration.update();
    // `skipWaiting` and `clientsClaim` are both in the generated worker, so one
    // that has begun installing will be the one answering the reload below.
    return Boolean(registration.installing ?? registration.waiting);
  },
  reload: () => globalThis.location.reload(),
};

const TRIED = 'cockpit.updating.tried';

/** Where the one-reload guard is kept: this tab, this visit. */
export function tabMemory(): Storage | undefined {
  try {
    return globalThis.sessionStorage;
  } catch {
    return undefined;
  }
}

/**
 * Take the new version if there is one, and otherwise say so.
 *
 * **At most one reload, by construction rather than by argument.** A build that
 * is still out of date after updating — a deployment half-swapped, an API that
 * moved again — would otherwise gate, reload, gate and reload for as long as
 * the tab is open, which is worse than the dead button this replaces. The mark
 * is written before the reload and cleared by the first read that works
 * (`working`), so it means "we reloaded and have not yet seen this build read
 * anything", which is exactly the state a loop is stuck in. A browser that
 * refuses storage keeps no mark and is left with one honest dead end instead.
 */
export async function pickUpTheNewVersion(
  versions: Versions = realVersions,
  memory: Storage | undefined = tabMemory(),
): Promise<Update> {
  if (read(memory) !== null) return 'nothing-new';

  let waiting: boolean;
  try {
    waiting = await versions.newVersionWaiting();
  } catch {
    // The check itself could not be made. Treated as nothing to take, because
    // the alternative is reloading on no evidence, which is the loop.
    return 'nothing-new';
  }
  if (!waiting) return 'nothing-new';

  write(memory);
  versions.reload();
  return 'taken';
}

/**
 * This build has read something successfully, so it is not the one that was
 * behind. Clears the guard, which is what lets a tab left open across two
 * deployments pick up the second as readily as the first.
 */
export function working(memory: Storage | undefined = tabMemory()): void {
  try {
    memory?.removeItem(TRIED);
  } catch {
    // A browser that refuses storage kept no mark to remove.
  }
}

function read(memory: Storage | undefined): string | null {
  try {
    return memory?.getItem(TRIED) ?? null;
  } catch {
    return null;
  }
}

function write(memory: Storage | undefined): void {
  try {
    memory?.setItem(TRIED, 'yes');
  } catch {
    // Nothing to do: without the mark the dead end below is reached one reload
    // later than it would have been, which is a flicker rather than a loop.
  }
}
