/**
 * Working out why the app could not load, in terms the person in front of it
 * can act on.
 *
 * The awkward fact this module exists for: **an expired sign-in and a dead
 * connection are indistinguishable from inside the page.** Both arrive as a
 * bare `TypeError: Failed to fetch`. When the perimeter answers a data request
 * with "go and sign in", that redirect points at another origin, and the
 * browser deliberately refuses both to follow it and to say that is what
 * happened — a privacy rule, not a bug, and the same in every framework.
 *
 * So the reason is *worked out* rather than read off the error, by asking
 * `/health`: the one path kept outside the gate (docs/deployment.md, "`/health`
 * must stay outside the gate"). If it answers, the deployment is healthy and
 * the problem is this browser's sign-in.
 *
 * **`navigator.onLine` is only believed when it says false.** Measured
 * 2026-08-31 against the built app: a page taken offline after loading reports
 * `false`, but a page *reloaded while already offline* reports `true`. The
 * second is the case that matters — opening the installed app on a plane — so
 * trusting a `true` would confidently give the wrong reason in exactly the
 * situation the local copy exists for. It stays as a fast path out, never as
 * evidence that anything is reachable.
 */

export type FailureReason =
  /**
   * Nothing could be reached at all. The stored copy is still readable
   * (functional definition, "Offline / local-first behavior", §10).
   */
  | 'offline'
  /**
   * Cockpit itself said no: this browser is not signed in to the application.
   * The way on is Cockpit's own logon page.
   */
  | 'signed-out'
  /**
   * The deployment is fine and Cockpit never got the chance to answer - so what
   * stopped the request is the gate *in front of* the deployment (Cloudflare
   * Access, docs/deployment.md, "The cost of gating production, stated
   * plainly"). The way on is back out through that gate, which is a navigation
   * rather than a page this app can render.
   *
   * Kept apart from `signed-out` because the two need opposite moves, and
   * offering the wrong one is a dead end either way round: Cockpit's logon page
   * cannot be reached from behind an expired perimeter, and going back out
   * through a perimeter that is perfectly happy fixes nothing.
   */
  | 'gate-expired'
  /** Reached, and unwell. */
  | 'trouble'
  /** The answer did not match what this build of the app understands. */
  | 'outdated';

export type Reach =
  /** Answered, and said its register and an account store are both fine. */
  | 'healthy'
  /** Answered, but not well: something is up with the deployment itself. */
  | 'unhealthy'
  /** Did not answer at all, so nothing at the other end could be seen. */
  | 'unreachable';

/**
 * The facts about the world that cannot be learned from the error object.
 * Injected so the rules can be proved without a network (F1 keeps no real
 * dependencies).
 */
export interface Surroundings {
  /** False is trustworthy; true means nothing. See the note above. */
  isDefinitelyOffline(): boolean;
  reachServer(): Promise<Reach>;
}

export const realSurroundings: Surroundings = {
  isDefinitelyOffline: () => navigator.onLine === false,
  reachServer: async () => {
    let res: Response;
    try {
      res = await fetch('/health', { cache: 'no-store' });
    } catch {
      // Nothing came back at all: this is the only genuinely unreachable case.
      return 'unreachable';
    }
    if (!res.ok) return 'unhealthy';
    try {
      const body: unknown = await res.json();
      return (body as { ok?: unknown } | null)?.ok === true ? 'healthy' : 'unhealthy';
    } catch {
      // It answered, just not with our JSON — a login page or something else
      // standing in front of the Worker. Answering badly is not the same as
      // not answering, and calling it unreachable would tell the person their
      // connection is down when it plainly is not. The runbook's "Diagnosing
      // a broken environment" lists this as its own case for the same reason.
      return 'unhealthy';
    }
  },
};

/** `workspaces failed: 503` — the shape apps/web/src/api/client.ts throws. */
const STATUS = /failed: (\d{3})$/;

export async function diagnose(
  error: unknown,
  surroundings: Surroundings = realSurroundings,
): Promise<FailureReason> {
  // A shape mismatch means the running API and this build of the app disagree,
  // which is only ever fixed by picking up the newer build.
  if (error instanceof Error && error.name === 'ZodError') return 'outdated';

  const status = error instanceof Error ? STATUS.exec(error.message)?.[1] : undefined;
  if (status) {
    // A 401 is Cockpit's own gate, which answers in the application's format
    // and is the only thing that does. A 403 is somebody else's - a perimeter
    // that refuses rather than redirects - and is treated as such.
    if (status === '401') return 'signed-out';
    if (status === '403') return 'gate-expired';
    return 'trouble';
  }

  // Nothing came back at all, so ask the world instead of guessing.
  return diagnoseConnection(surroundings);
}

/**
 * The same question with no error to go on: "nothing is getting through — why?"
 *
 * The push stream needs exactly this and has no error object to offer, because
 * `EventSource` reports that it stopped and never why (see useServerEvents.ts).
 */
export async function diagnoseConnection(
  surroundings: Surroundings = realSurroundings,
): Promise<FailureReason> {
  if (surroundings.isDefinitelyOffline()) return 'offline';
  switch (await surroundings.reachServer()) {
    // The deployment answered while our request did not get through at all -
    // no status, no body, nothing to read. Cockpit's own gate would have
    // answered with one, so what swallowed the request is in front of it.
    case 'healthy':
      return 'gate-expired';
    case 'unhealthy':
      return 'trouble';
    // Not one byte came back from anywhere. Strictly that is "the connection,
    // or the whole edge", and the app claims only the former: a dropped
    // connection is overwhelmingly the likelier of the two, and what to do
    // about it is the same either way.
    default:
      return 'offline';
  }
}

/**
 * Remembers that this tab has already been sent through sign-in once.
 *
 * Without it the app can spin: "healthy deployment, refused data request" is
 * strong evidence of a stale sign-in, but it is not proof, and anything else
 * that blocks `/v1` while leaving `/health` alone — an extension, a proxy, a
 * broken service worker, or simply a deployment with no gate in front of it —
 * produces the same evidence. Signing in would then fix nothing and the app
 * would bounce through it forever. One attempt per tab; after that the person
 * is asked instead of moved.
 *
 * `sessionStorage` throws outright in some privacy modes, so every use is
 * guarded and a failure degrades to "never attempted", never to a crash.
 */
const ATTEMPT_KEY = 'cockpit-sign-in-attempted';

export function signInAlreadyAttempted(): boolean {
  try {
    return sessionStorage.getItem(ATTEMPT_KEY) !== null;
  } catch {
    return false;
  }
}

/** Called once a read succeeds, so a later expiry is handled automatically again. */
export function clearSignInAttempt(): void {
  try {
    sessionStorage.removeItem(ATTEMPT_KEY);
  } catch {
    // Nothing to clear if it could never be set.
  }
}

/**
 * To Cockpit's own logon page.
 *
 * A whole-page navigation rather than a route change, and for a reason: this is
 * reached from a failure screen that may be rendered anywhere, including
 * outside the router's own error boundary, and the point of arriving at the
 * logon page is to be holding nothing of the last visit. Reloading guarantees
 * that in a way unmounting components does not.
 */
export function goToLogonPage(): void {
  window.location.assign('/signin');
}

/**
 * Sends the browser through the perimeter's sign-in and back to where it was.
 *
 * A plain reload cannot do this: the service worker answers navigations from
 * its own cache without touching the network, so nothing ever gets the chance
 * to redirect. `/v1/*` is on the service worker's denylist (see
 * `navigateFallbackDenylist` in apps/web/vite.config.ts), so this leaves the
 * browser for real, and the Worker's /v1/relogin sends us back afterwards.
 *
 * The same reasoning applies to where Access sends the browser *back* to, and
 * missing it is what once stopped signing in from finishing at all: the
 * callback at `/cdn-cgi/access/authorized` is a navigation too, so it has to be
 * on that denylist for the same reason this path is.
 */
export function signInAgain(returnTo: string): void {
  try {
    sessionStorage.setItem(ATTEMPT_KEY, '1');
  } catch {
    // Losing the guard is survivable; failing to sign in is not.
  }
  window.location.assign(`/v1/relogin?return=${encodeURIComponent(returnTo)}`);
}
