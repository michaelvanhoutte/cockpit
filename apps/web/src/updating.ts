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
 * **A new worker waits; only a click activates it.** The shell is precached by a
 * service worker (apps/web/vite.config.ts), and a worker that took over a live
 * page on install would delete the precache the page was loaded from and still
 * asks for, which is what left an open tab with "Formatting could not be
 * loaded". So a new worker installs and waits, every open page keeps serving
 * from the worker it started with, and a page learns a new version is out when
 * it finds one waiting (`checkOnOpening`, `Workers`). The click sends the
 * waiting worker a `SKIP_WAITING` message and reloads once it is active: one
 * click, one reload, no hard reload.
 *
 * The gate below, which takes the version unasked, awaits its check before
 * reloading, because a navigation is answered from the old precache before a
 * check started by the reload could finish.
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
  /**
   * Asks whatever precaches the shell to go and look for a newer one, and if
   * one is there activates it, so the reload that follows lands on it.
   */
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
    const container: ServiceWorkerContainer | undefined = globalThis.navigator?.serviceWorker;
    // Nothing precaching the shell — the dev server, or a browser without
    // service workers. A reload genuinely fetches whatever the server now has,
    // so there is nothing to ask and no reason to hold it up.
    if (!container) return true;
    const registration = await container.getRegistration();
    if (!registration) return true;
    // A refused check still leaves a worker that was already waiting.
    await registration.update().catch(() => undefined);
    if (!(await waitingIn(registration))) return false;
    // This gate takes the version unasked, so it is its own click: the worker
    // waits for a message and must be told before the reload can land on it.
    return activateWaiting(registration);
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

/** The message the generated worker (registerType 'prompt') activates on. */
const SKIP_WAITING = { type: 'SKIP_WAITING' };

/** The longest a click waits for the worker to say it is active. */
const ACTIVATION_WAIT_MS = 5_000;

/**
 * The worker waiting to take over, once any that is still installing has
 * finished: `update()` resolves when a new script is found, not when it has
 * installed.
 */
async function waitingIn(registration: ServiceWorkerRegistration): Promise<ServiceWorker | null> {
  const installing = registration.installing;
  if (installing) await settled(installing);
  return registration.waiting;
}

/** Resolves once the worker is past installing, whichever way it went. */
function settled(worker: ServiceWorker): Promise<void> {
  return new Promise((resolve) => {
    const check = () => {
      if (worker.state === 'parsed' || worker.state === 'installing') return;
      worker.removeEventListener('statechange', check);
      resolve();
    };
    worker.addEventListener('statechange', check);
    check();
  });
}

/**
 * Tell the waiting worker to take over and resolve when it has - bounded, so a
 * click is never left hanging on a worker that never answers. Resolves true
 * once active, false on a timeout or a worker that went redundant. Nothing
 * waiting (another tab already activated it) is true at once.
 */
async function activateWaiting(registration: ServiceWorkerRegistration): Promise<boolean> {
  const waiting = registration.waiting;
  if (!waiting) return true;
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), ACTIVATION_WAIT_MS);
    waiting.addEventListener('statechange', () => {
      if (waiting.state === 'activated' || waiting.state === 'redundant') {
        clearTimeout(timer);
        resolve(waiting.state === 'activated');
      }
    });
    waiting.postMessage(SKIP_WAITING);
  });
}

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
 * so a deploy replaces their names. A new worker now waits rather than taking
 * over, so an open tab keeps its files until told; what is left is the window
 * between another tab's click activating the worker and this tab's own click,
 * and a server that is ahead of the page for any other reason. The next part
 * the page asks for is then in neither the cache nor the deployment. Which the
 * gate above cannot see: the API answers this build perfectly well - an older
 * client reading a newer server is what expand-then-contract is for
 * (deployment, "Migrations and rollback") - and a file the browser fetches for
 * itself passes through neither cache the gate watches.
 *
 * **`newVersionWaiting` is deliberately not asked, because it answers the wrong
 * question.** It looks for a worker installing or waiting, and by the time a
 * part has gone missing the worker has usually been activated by another tab,
 * so it reports nothing waiting, and reporting nothing waiting is right: what
 * is out of step here is the page against its worker, not the worker against
 * the server.
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

/**
 * Knowing a new version is out, and loading it on a click - the service worker
 * half of "Never run an old version". The worker itself waits (see the top of
 * this file); these are the page's questions of it, injected like `Versions`.
 */
export interface Workers {
  /** Whether this browser has a service worker to ask at all. */
  supported(): boolean;
  /** A worker already waiting, known without the network. */
  waiting(): Promise<boolean>;
  /**
   * Asks the server for a newer worker and resolves true once one is installed
   * and waiting. Rejects where the question could not be asked.
   */
  check(): Promise<boolean>;
  /** Tells the waiting worker to take over; true once it has (or none waits), false if it did not. */
  activate(): Promise<boolean>;
  /** The worker serving this page changed under it - another tab's click. */
  onTakenOver(listener: () => void): () => void;
}

export const realWorkers: Workers = {
  supported: () => Boolean(globalThis.navigator?.serviceWorker),
  waiting: async () => Boolean((await registered())?.waiting),
  check: async () => {
    const registration = await registered();
    if (!registration) return false;
    await registration.update();
    return Boolean(await waitingIn(registration));
  },
  activate: async () => {
    const registration = await registered();
    return registration ? activateWaiting(registration) : true;
  },
  onTakenOver: (listener) => {
    const container = globalThis.navigator?.serviceWorker;
    container?.addEventListener('controllerchange', listener);
    return () => container?.removeEventListener('controllerchange', listener);
  },
};

async function registered(): Promise<ServiceWorkerRegistration | undefined> {
  return globalThis.navigator?.serviceWorker?.getRegistration();
}

/**
 * How long opening waits for the check before showing the app anyway
 * (architecture, "Performance budgets"): scoping's answer to a cold open that
 * now has a network question in it.
 */
export const OPENING_CHECK_MS = 1_500;

/** What opening Cockpit learned about a new version. */
export interface Opening {
  /** `new` shows the message and not the app; `open` shows the app. */
  now: 'new' | 'open';
  /** An answer that missed the bound: true means show the message over the app. */
  later: Promise<boolean>;
}

/**
 * Decide what opening shows. A worker already waiting from an earlier visit is
 * answered with no network at all; otherwise the browser is asked for a newer
 * one, for at most `boundMs`. An answer that does not come in time, an error,
 * and being offline all open the old version - a gate that cannot be tested
 * must not block offline use - and the same question is asked again at the next
 * trigger (`RECONNECTED`, the tab coming back into view).
 */
export async function checkOnOpening(
  workers: Workers,
  boundMs: number = OPENING_CHECK_MS,
): Promise<Opening> {
  const never = Promise.resolve(false);
  if (!workers.supported()) return { now: 'open', later: never };
  if (await workers.waiting().catch(() => false)) return { now: 'new', later: never };

  const answer = workers.check().catch(() => false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<'late'>((resolve) => {
    timer = setTimeout(() => resolve('late'), boundMs);
  });
  const first = await Promise.race([answer, late]);
  clearTimeout(timer);
  if (first === 'late') return { now: 'open', later: answer };
  return { now: first ? 'new' : 'open', later: never };
}

/**
 * The click: activate the waiting worker, then reload once onto it. Resolves
 * false, with no reload, when the worker did not activate: reloading would land
 * on the old version with the same worker still waiting.
 *
 * Marked with the same tab memory as the gate, so a version that is *still*
 * behind after the click is not taken a second time automatically (the gate
 * answers `nothing-new` for it). A second click while this one is in flight is
 * the caller's to ignore; asking twice here still reloads once per call, so it
 * is not left to chance there.
 */
export async function continueToNewVersion(
  workers: Workers,
  versions: Versions = realVersions,
  memory: Storage | undefined = tabMemory(),
): Promise<boolean> {
  const active = await workers.activate().catch(() => false);
  if (!active) return false;
  take(versions, memory, versions.thisBuild(), TRIED_FROM);
  return true;
}

/**
 * Dispatched on `globalThis` by the live-updates stream each time it comes up
 * again after a drop. A deploy drops every open stream, so this is the signal a
 * new build is out and the server announces nothing (useServerEvents.ts).
 */
export const RECONNECTED = 'cockpit:stream-reconnected';
