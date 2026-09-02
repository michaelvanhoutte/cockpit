/**
 * Working out why the app could not load, in terms the person in front of it
 * can act on.
 *
 * The awkward fact this module exists for: **a refused request and a dead
 * connection are indistinguishable from inside the page.** Both arrive as a
 * bare `TypeError: Failed to fetch`. So the reason is *worked out* rather than
 * read off the error, by asking `/health` — the one path outside Cockpit's own
 * gate. Something answering there means the connection is alive and the fault
 * is nearer to hand.
 *
 * **`navigator.onLine` is only believed when it says false.** Measured
 * 2026-08-31 against the built app: a page taken offline after loading reports
 * `false`, but a page *reloaded while already offline* reports `true`. The
 * second is the case that matters — opening the installed app on a plane — so
 * trusting a `true` would give the wrong reason in exactly the situation the
 * local copy exists for. A fast path out, never evidence that anything is
 * reachable.
 */

export type FailureReason =
  /**
   * Nothing could be reached at all. The stored copy is still readable
   * (functional definition, "Offline / local-first behavior").
   */
  | 'offline'
  /**
   * Cockpit itself said no: this browser is not signed in to the application.
   * The way on is Cockpit's own logon page.
   */
  | 'signed-out'
  /** Something answered, and the read still did not work. Trying again is the move. */
  | 'trouble'
  /** The answer did not match what this build of the app understands. */
  | 'outdated';

export type Reach =
  /**
   * Something answered. Whether it answered *well* is deliberately not asked:
   * the app does the same thing either way, and `/health`'s own reading of
   * itself is for the deploy check and the uptime monitor to act on.
   */
  | 'reachable'
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
      await fetch('/health', { cache: 'no-store' });
      return 'reachable';
    } catch {
      // Nothing came back at all: the only genuinely unreachable case. A bad
      // answer is still an answer, and calling that unreachable would tell the
      // person their connection is down when it plainly is not.
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
    // A 401 is Cockpit's own gate, which answers in the application's format
    // and is the only thing that does. Every other refusal is somebody else's,
    // and this app cannot say whose.
    if (status === '401') return 'signed-out';
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
  // Something answered while our own request did not get through at all — no
  // status, no body. Cockpit's gate would have answered with one, so whatever
  // swallowed it sits between this browser and the Worker: an extension, a
  // proxy, or a connection that dropped just this request.
  if ((await surroundings.reachServer()) === 'reachable') return 'trouble';
  // Not one byte came back from anywhere. Strictly that is "the connection, or
  // the whole edge", and the app claims only the former: a dropped connection
  // is overwhelmingly the likelier, and what to do about it is the same either
  // way.
  return 'offline';
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
