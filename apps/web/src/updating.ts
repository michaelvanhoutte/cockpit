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
 * rehydrated from IndexedDB *without being parsed again* (persistence.tsx) —
 * the schemas guard the way in from the network, not the way out of storage —
 * so a build that cannot read what the server says cannot trust what it already
 * holds either. Carrying on is the one thing that is actively wrong.
 *
 * That the restore now re-reads everything on the way out of itself
 * ("Re-read the stored copy on load instead of trusting how fresh it looks",
 * issue 162) is what usually raises this gate: it is the first read to come
 * back in a shape this build cannot understand, so the mismatch surfaces on the
 * load rather than whenever something next happens to re-read.
 *
 * **Why reloading by hand never worked.** The shell is precached by a service
 * worker (apps/web/vite.config.ts). A reload does make the browser look for a
 * new `sw.js`, but the navigation it looks *during* has already been answered
 * from the old precache; the new worker installs, skips waiting and claims the
 * page a moment later, far too late for the page now on screen. So the second
 * reload would have worked and the first never could — and nobody clicks twice
 * on a button that does nothing. Waiting for the check before reloading is the
 * whole fix. Measured against a real service worker: one bare reload serves the
 * old build, two serve the new, and awaiting the check first serves the new on
 * one.
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
 * The three things about the browser that a test cannot have and must not need,
 * injected the way `Surroundings` is in api/loadFailure.ts.
 */
export interface Versions {
  /** Asks whatever precaches the shell to go and look for a newer one. */
  newVersionWaiting(): Promise<boolean>;
  /** Which build this page is running, so an attempt can be told from a repeat. */
  thisBuild(): string;
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

  /**
   * The module script's own address, which Vite content-hashes
   * (`/assets/index-DgOhHjV4.js`), so it changes exactly when the build does.
   *
   * A build identity rather than a version number because nothing has to
   * generate, inject or bump it: it is already in the page, and it is already
   * what the precache is keyed on.
   */
  thisBuild: () =>
    globalThis.document?.querySelector('script[type="module"][src]')?.getAttribute('src') ??
    'unknown',

  reload: () => globalThis.location.reload(),
};

const TRIED_FROM = 'cockpit.updating.tried-from';

/** Where the guard is kept: this tab, this visit. */
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
 * **Never twice from the same build, which is what makes a loop impossible.** A
 * build still out of date *after* updating — a half-swapped deployment, an API
 * that moved again — would otherwise gate, reload, gate and reload for as long
 * as the tab is open, which is far worse than the dead button this replaces.
 *
 * The mark is the build it was written from, not the bare fact that an attempt
 * happened, and that distinction is the whole guard. "We already tried" has to
 * be cleared at some point, or a tab open across two deployments takes only the
 * first — and clearing it on a read that worked does not do it, because on a
 * build that is behind the reads that *do* work answer first: `me` parses its
 * own schema perfectly well a moment before the workspace fails to parse, so
 * the mark would be gone by the time the gate rose. That was the first version
 * of this guard, and it looped. Comparing builds needs no clearing and no
 * timer: landing on the same build says the reload changed nothing, and a
 * different one is by definition a version this tab has not tried yet.
 *
 * A browser that refuses storage keeps no mark and is left with one honest dead
 * end instead.
 */
export async function pickUpTheNewVersion(
  versions: Versions = realVersions,
  memory: Storage | undefined = tabMemory(),
): Promise<Update> {
  const build = versions.thisBuild();
  if (read(memory) === build) return 'nothing-new';

  let waiting: boolean;
  try {
    waiting = await versions.newVersionWaiting();
  } catch {
    // The check itself could not be made. Treated as nothing to take, because
    // the alternative is reloading on no evidence, which is the loop.
    return 'nothing-new';
  }
  if (!waiting) return 'nothing-new';

  write(memory, build);
  versions.reload();
  return 'taken';
}

function read(memory: Storage | undefined): string | null {
  try {
    return memory?.getItem(TRIED_FROM) ?? null;
  } catch {
    return null;
  }
}

function write(memory: Storage | undefined, build: string): void {
  try {
    memory?.setItem(TRIED_FROM, build);
  } catch {
    // Nothing to do: without the mark a build that is still behind reaches the
    // dead end one reload later than it would have, rather than never.
  }
}
