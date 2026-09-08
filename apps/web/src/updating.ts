import { statusOf } from './api/loadFailure';

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

/**
 * The two ways the *server* can tell this build it is behind. There is a third
 * way to be behind that no answer can carry, because it is a file rather than
 * an answer - see `takeTheNewVersion`.
 *
 * **A shape it cannot read** is the first, and was for a while the whole
 * condition: the server answered something these schemas reject, so this build
 * is older than what is answering it.
 *
 * **An address that has been retired** is the second, and it is the one a
 * missing shape cannot cover ("Update instead of failing when a build asks for
 * an address that has been retired", issue 217). A read this build makes and a
 * later one does not gets no answer to misread - it gets a refusal - and
 * without this that lands on the failure panel, where *Try again* runs the same
 * doomed read for as long as anybody presses it. A build stranded that way on
 * staging is what this exists for.
 *
 * `410` and not `404`: the server says an address is *gone* only for one it
 * used to have (apps/api/src/auth/gate.ts), so it cannot be confused with a
 * mistyped URL, and it is deliberately answerable without a sign-in, since a
 * stranded browser may hold none.
 */
export function outOfDate(error: unknown): boolean {
  return (error instanceof Error && error.name === 'ZodError') || statusOf(error) === '410';
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

  return take(versions, memory, build);
}

/**
 * The third way to be behind: **a file this build named is not being served.**
 *
 * The two above are things the server *said*. This one is a file that is not
 * there: the shell is split, and the parts fetched on demand are content-hashed,
 * so a deploy replaces their names. A tab open across one keeps running the old
 * page while the new worker claims it and deletes the precache that page was
 * loaded from (vite.config.ts), and the next part it asks for is in neither the
 * cache nor the deployment. Which the gate above cannot see: the API answers
 * this build perfectly well - an older client reading a newer server is what
 * expand-then-contract is for (deployment, "Migrations and rollback") - and a
 * file the browser fetches for itself passes through neither cache the gate
 * watches.
 *
 * **`newVersionWaiting` is deliberately not asked, because it answers the wrong
 * question.** It looks for a worker installing or waiting, and by the time a
 * part has gone missing the new worker has already installed, skipped waiting
 * and claimed the page - that takeover is what took the file. So it reports
 * nothing waiting, and reporting nothing waiting is right: what is out of step
 * here is the page against its worker, not the worker against the server.
 *
 * **The missing file is the evidence, and it is better evidence than a probe.**
 * A page that asked for a part of *itself* and was told it is gone is running a
 * build that is no longer served. There is nothing left to check.
 *
 * The guard is shared with the gate above and does the same work: never twice
 * from the same build, so a reload that changes nothing says so instead of
 * going round again.
 */
export function takeTheNewVersion(
  versions: Versions = realVersions,
  memory: Storage | undefined = tabMemory(),
): Update {
  const build = versions.thisBuild();
  if (read(memory) === build) return 'nothing-new';
  return take(versions, memory, build);
}

/** Mark the build being left, then leave it. */
function take(versions: Versions, memory: Storage | undefined, build: string): Update {
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
