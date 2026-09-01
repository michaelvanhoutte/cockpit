import { useEffect, useState } from 'react';
import {
  diagnose,
  goToLogonPage,
  signInAgain,
  signInAlreadyAttempted,
  type FailureReason,
  type Surroundings,
} from '../api/loadFailure';

interface Props {
  error: unknown;
  /** Retries the read that failed. Absent when nothing can be retried in place. */
  onRetry?: () => void;
  /**
   * True when there is nothing of the person's own work on screen, so this may
   * own the whole view and may navigate away to sign in. False when a stored
   * copy is already rendered behind it: reading what you already have is a
   * promise the app keeps offline (functional definition, "Offline /
   * local-first behavior", §10), and hijacking
   * the screen to a sign-in page would break it.
   */
  canTakeOver?: boolean;
  /** F1 seam: the two facts that otherwise need a network. */
  surroundings?: Surroundings;
}

interface Wording {
  headline: string;
  detail: string;
  action?: 'retry' | 'reload' | 'logon' | 'relogin';
}

const WORDING: Record<FailureReason, Wording> = {
  offline: {
    headline: "Cockpit can't be reached",
    detail:
      'This device looks offline. What you already have stays readable, and Cockpit catches up as soon as the connection is back.',
    action: 'retry',
  },
  'signed-out': {
    headline: "You're signed out",
    detail: 'Sign in again to pick up where you left off.',
    action: 'logon',
  },
  'gate-expired': {
    headline: 'Your sign-in expired',
    detail: 'Cockpit itself is fine — this browser just needs to sign in again.',
    action: 'relogin',
  },
  trouble: {
    headline: 'Cockpit is having trouble',
    detail: 'It answered, but not properly. Nothing you have here is affected.',
    action: 'retry',
  },
  outdated: {
    headline: 'Cockpit has been updated',
    detail: 'This tab is running an older version. Reload to pick up the new one.',
    action: 'reload',
  },
};

/**
 * What the person sees when a read fails, replacing the router's default
 * "Something went wrong!" box — which printed the raw `TypeError` and left
 * every failure looking identical.
 */
export function LoadFailure({ error, onRetry, canTakeOver = false, surroundings }: Props) {
  const [reason, setReason] = useState<FailureReason | null>(null);

  // Re-diagnosed on every fresh failure, because the reason genuinely moves: a
  // deployment comes back, a connection goes. What must *not* move is the way
  // out. A failure that persists is re-read for as long as this is on screen —
  // the push stream reopens on a 3s→60s backoff and re-reads the workspace each
  // time it fails (useServerEvents.ts), and every refusal arrives as its own new
  // `Error` — so clearing the reason first replaced "Sign in again" with
  // "Working out what went wrong…" for a whole `/health` round trip, over and
  // over, and the button was simply not there when it was clicked. Keeping the
  // last answer costs at worst naming a reason that is one round trip stale;
  // taking the button away costs the click.
  useEffect(() => {
    let current = true;
    void diagnose(error, surroundings).then((r) => {
      if (current) setReason(r);
    });
    return () => {
      current = false;
    };
  }, [error, surroundings]);

  // Nothing of theirs is on screen and it is only a stale perimeter session, so
  // go and fix it rather than asking them to — but at most once per tab, or a
  // cause that signing in cannot fix would bounce us round forever.
  //
  // Only this reason moves by itself. Being signed out *of Cockpit* is answered
  // by the router, which sends you to the logon page instead of ever rendering
  // a failure; if this screen is showing it anyway there is something on screen
  // worth not throwing away, so it offers the way on rather than taking it.
  const goByItself = reason === 'gate-expired' && canTakeOver && !signInAlreadyAttempted();
  useEffect(() => {
    if (goByItself) signInAgain(window.location.pathname + window.location.search);
  }, [goByItself]);

  if (reason === null) {
    return <p className="text-sm text-ink-faint">Working out what went wrong…</p>;
  }

  if (goByItself) {
    return <p className="text-sm text-ink-soft">Signing you back in…</p>;
  }

  const { headline, detail, action } = WORDING[reason];

  return (
    <div
      role="alert"
      className="rounded-lg bg-surface p-4 shadow-panel"
      data-failure={reason}
    >
      <h2 className="text-base font-semibold text-over">{headline}</h2>
      <p className="mt-1 text-sm text-ink-soft">{detail}</p>
      {action === 'logon' && (
        <button
          type="button"
          className="mt-3 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white"
          onClick={goToLogonPage}
        >
          Sign in
        </button>
      )}
      {action === 'relogin' && (
        <button
          type="button"
          className="mt-3 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white"
          onClick={() => signInAgain(window.location.pathname + window.location.search)}
        >
          Sign in again
        </button>
      )}
      {action === 'reload' && (
        <button
          type="button"
          className="mt-3 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white"
          onClick={() => window.location.reload()}
        >
          Reload
        </button>
      )}
      {action === 'retry' && onRetry && (
        <button
          type="button"
          className="mt-3 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white"
          onClick={onRetry}
        >
          Try again
        </button>
      )}
    </div>
  );
}
