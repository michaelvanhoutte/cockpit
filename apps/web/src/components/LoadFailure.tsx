import { useEffect, useState } from 'react';
import {
  diagnose,
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
   * promise the app keeps offline (functional definition §10), and hijacking
   * the screen to a sign-in page would break it.
   */
  canTakeOver?: boolean;
  /** F1 seam: the two facts that otherwise need a network. */
  surroundings?: Surroundings;
}

interface Wording {
  headline: string;
  detail: string;
  action?: 'retry' | 'reload' | 'sign-in';
}

const WORDING: Record<FailureReason, Wording> = {
  offline: {
    headline: "Cockpit can't be reached",
    detail:
      'This device looks offline. What you already have stays readable, and Cockpit catches up as soon as the connection is back.',
    action: 'retry',
  },
  'signed-out': {
    headline: 'Your sign-in expired',
    detail: 'Cockpit itself is fine — this browser just needs to sign in again.',
    action: 'sign-in',
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

  useEffect(() => {
    let current = true;
    setReason(null);
    void diagnose(error, surroundings).then((r) => {
      if (current) setReason(r);
    });
    return () => {
      current = false;
    };
  }, [error, surroundings]);

  // Nothing of theirs is on screen and it is only a stale sign-in, so go and
  // fix it rather than asking them to — but at most once per tab, or a cause
  // that signing in cannot fix would bounce us round forever.
  const goByItself = reason === 'signed-out' && canTakeOver && !signInAlreadyAttempted();
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
      {action === 'sign-in' && (
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
