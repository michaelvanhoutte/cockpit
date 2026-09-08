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
  | 'nothing-new'
  /**
   * The server could not be asked - offline, refused, or answering something
   * that is not the page. Deliberately not folded into `nothing-new`: saying
   * "you are already up to date" on the strength of a question nobody answered
   * is the one thing here that would be a lie.
   */
  | 'could-not-ask';

/**
 * The four things about the browser that a test cannot have and must not need,
 * injected the way `Surroundings` is in api/loadFailure.ts.
 */
export interface Versions {
  /** Asks whatever precaches the shell to go and look for a newer one. */
  newVersionWaiting(): Promise<boolean>;
  /** Which build this page is running, so an attempt can be told from a repeat. */
  thisBuild(): string;
  /**
   * Which build is being served now, in the same terms `thisBuild` answers in,
   * or null where the question could not be asked at all.
   *
   * **Null is not "the same one".** A browser that is offline, behind a proxy
   * that ate the request, or on a connection that dropped answers nothing here,
   * and nothing is the one answer that must not be read as evidence either way
   * - it is the difference between "there is nothing newer" and "I could not
   * find out", which is a difference somebody is told about.
   */
  servedBuild(): Promise<string | null>;
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
  thisBuild: () => buildOf(globalThis.document) ?? 'unknown',

  /**
   * The same question asked of the page the server would hand out now, rather
   * than of the one this tab is running.
   *
   * `no-store` so the browser's own cache cannot answer with the copy this page
   * came from, which would make every build look current. The service worker
   * may still answer it, and that is right: its precache belongs to whichever
   * worker is installed, so a page left behind by a takeover is compared
   * against the build that took over.
   *
   * Anything at all going wrong is null rather than a guess - a refusal, a
   * connection that is not there, a page with no module script in it.
   */
  servedBuild: async () => {
    try {
      const answer = await fetch('/index.html', { cache: 'no-store' });
      if (!answer.ok) return null;
      return buildOf(new DOMParser().parseFromString(await answer.text(), 'text/html'));
    } catch {
      return null;
    }
  },

  reload: () => globalThis.location.reload(),
};

/** Which build a page is, read the one way that is already content-hashed. */
function buildOf(page: Document | undefined): string | null {
  return page?.querySelector('script[type="module"][src]')?.getAttribute('src') ?? null;
}

/**
 * Where each way of taking a new version keeps its own mark. Two keys and not
 * one: they ask different questions from the same tab, and a mark written by
 * one is no answer at all to the other.
 */
const TRIED_FROM = 'cockpit.updating.tried-from';
const MISSING_FILE = 'cockpit.updating.tried-from-missing-file';

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
  if (read(memory, TRIED_FROM) === build) return 'nothing-new';

  let waiting: boolean;
  try {
    waiting = await versions.newVersionWaiting();
  } catch {
    // The check itself could not be made. Treated as nothing to take, because
    // the alternative is reloading on no evidence, which is the loop.
    return 'nothing-new';
  }
  if (!waiting) return 'nothing-new';

  return take(versions, memory, build, TRIED_FROM);
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
 * **The file being missing is not on its own evidence that anything is newer.**
 * A part of the shell fails to arrive for the dull reasons too - a connection
 * that dropped, a proxy that ate the request - and *those* reloads land back on
 * the same page with the same thing broken, having thrown away whatever was
 * half-written. So what is compared is the page this tab is running against the
 * page the server would hand out now, which is the question actually being
 * asked, and a build that cannot be asked about is said to be unknown rather
 * than assumed either way.
 *
 * **Its own mark, not the gate's.** They answer different questions from the
 * same tab, and one key for both lets the gate's reload - which returns `true`
 * from `newVersionWaiting` merely for there being no worker registered yet -
 * mark a build and leave this one telling somebody they are up to date while a
 * file of theirs is provably gone.
 */
export async function takeTheNewVersion(
  versions: Versions = realVersions,
  memory: Storage | undefined = tabMemory(),
): Promise<Update> {
  const build = versions.thisBuild();
  if (read(memory, MISSING_FILE) === build) return 'nothing-new';

  const served = await versions.servedBuild();
  if (served === null) return 'could-not-ask';
  if (served === build) return 'nothing-new';

  return take(versions, memory, build, MISSING_FILE);
}

/** Mark the build being left, then leave it. */
function take(
  versions: Versions,
  memory: Storage | undefined,
  build: string,
  mark: string,
): Update {
  write(memory, build, mark);
  versions.reload();
  return 'taken';
}

function read(memory: Storage | undefined, mark: string): string | null {
  try {
    return memory?.getItem(mark) ?? null;
  } catch {
    return null;
  }
}

function write(memory: Storage | undefined, build: string, mark: string): void {
  try {
    memory?.setItem(mark, build);
  } catch {
    // Nothing to do: without the mark a build that is still behind reaches the
    // dead end one reload later than it would have, rather than never.
  }
}
