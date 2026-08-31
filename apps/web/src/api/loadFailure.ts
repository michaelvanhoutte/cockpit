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
  /** Nothing could be reached at all. The stored copy is still readable (§10). */
  | 'offline'
  /** The deployment is fine; this browser needs to sign in again. */
  | 'signed-out'
  /** Reached, and unwell. */
  | 'trouble'
  /** The answer did not match what this build of the app understands. */
  | 'outdated';

export type Reach =
  /** Answered, and said it and its database are fine. */
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
    try {
      const res = await fetch('/health', { cache: 'no-store' });
      if (!res.ok) return 'unhealthy';
      const body: unknown = await res.json();
      return (body as { ok?: unknown } | null)?.ok === true ? 'healthy' : 'unhealthy';
    } catch {
      return 'unreachable';
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
    // A perimeter that answers rather than redirects still means "sign in".
    return status === '401' || status === '403' ? 'signed-out' : 'trouble';
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
    case 'healthy':
      return 'signed-out';
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
 * Sends the browser through the perimeter's sign-in and back to where it was.
 *
 * A plain reload cannot do this: the service worker answers navigations from
 * its own cache without touching the network, so nothing ever gets the chance
 * to redirect. `/v1/*` is on the service worker's denylist (see
 * `navigateFallbackDenylist` in apps/web/vite.config.ts), so this leaves the
 * browser for real, and the Worker's /v1/relogin sends us back afterwards.
 */
export function signInAgain(returnTo: string): void {
  try {
    sessionStorage.setItem(ATTEMPT_KEY, '1');
  } catch {
    // Losing the guard is survivable; failing to sign in is not.
  }
  window.location.assign(`/v1/relogin?return=${encodeURIComponent(returnTo)}`);
}
