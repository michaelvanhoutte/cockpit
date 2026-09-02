import { useEffect, useState } from 'react';
import {
  diagnose,
  goToLogonPage,
  type FailureReason,
  type Surroundings,
} from '../api/loadFailure';

interface Props {
  error: unknown;
  /** Retries the read that failed. Absent when nothing can be retried in place. */
  onRetry?: () => void;
  /** F1 seam: the two facts that otherwise need a network. */
  surroundings?: Surroundings;
}

interface Wording {
  headline: string;
  detail: string;
  action?: 'retry' | 'reload' | 'logon';
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
  trouble: {
    headline: 'Cockpit is having trouble',
    detail: 'Something answered, but the read did not work. Nothing you have here is affected.',
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
export function LoadFailure({ error, onRetry, surroundings }: Props) {
  const [reason, setReason] = useState<FailureReason | null>(null);

  // Re-diagnosed on every fresh failure, because the reason genuinely moves: a
  // deployment comes back, a connection goes. What must *not* move is the way
  // out. A failure that persists is re-read for as long as this is on screen —
  // the push stream reopens on a 3s→60s backoff and re-reads the workspace each
  // time it fails (useServerEvents.ts), and every refusal arrives as its own new
  // `Error` — so clearing the reason first replaced the way out with "Working
  // out what went wrong…" for a whole `/health` round trip, over and over, and
  // the button was simply not there when it was clicked. Keeping the last
  // answer costs at worst naming a reason that is one round trip stale; taking
  // the button away costs the click.
  useEffect(() => {
    let current = true;
    void diagnose(error, surroundings).then((r) => {
      if (current) setReason(r);
    });
    return () => {
      current = false;
    };
  }, [error, surroundings]);

  if (reason === null) {
    return <p className="text-sm text-ink-faint">Working out what went wrong…</p>;
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
