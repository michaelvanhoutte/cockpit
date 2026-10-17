import { useEffect, useState } from 'react';
import { CannotBeLoadedOffline } from '../offline';
import { savedReadUnusable } from '../persistence';
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
  action?: 'retry' | 'logon';
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
};

/**
 * What the person sees when a read fails, replacing the router's default
 * "Something went wrong!" box — which printed the raw `TypeError` and left
 * every failure looking identical.
 */
export function LoadFailure(props: Props) {
  // The app already knows it is offline, so there is nothing to work out.
  if (props.error instanceof CannotBeLoadedOffline) {
    return <NothingToShowOffline queryKey={props.error.queryKey} onRetry={props.onRetry} />;
  }
  return <WorkedOut {...props} />;
}

/** Offline, and the route's read is neither held nor saved here in a shape this version can read. */
function NothingToShowOffline({
  queryKey,
  onRetry,
}: {
  queryKey: readonly unknown[];
  onRetry: Props['onRetry'];
}) {
  const unreadable = savedReadUnusable(queryKey);
  return (
    <div role="alert" className="rounded-lg bg-surface p-4 shadow-panel" data-failure="offline">
      <h2 className="text-base font-semibold text-over-ink">{WORDING.offline.headline}</h2>
      <p className="mt-1 text-sm text-ink-soft">
        {unreadable
          ? "This device looks offline, and what's saved here was saved in a shape this version can't read, so it can't be shown. It will be again once you've been online with this version."
          : "This device looks offline, and nothing is saved here to show."}
      </p>
      {onRetry && <TryAgain onRetry={onRetry} />}
    </div>
  );
}

function TryAgain({ onRetry }: { onRetry: () => void }) {
  return (
    <button
      type="button"
      className="mt-3 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-on-accent"
      onClick={onRetry}
    >
      Try again
    </button>
  );
}

function WorkedOut({ error, onRetry, surroundings }: Props) {
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
      <h2 className="text-base font-semibold text-over-ink">{headline}</h2>
      <p className="mt-1 text-sm text-ink-soft">{detail}</p>
      {action === 'logon' && (
        <button
          type="button"
          className="mt-3 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-on-accent"
          onClick={goToLogonPage}
        >
          Sign in
        </button>
      )}
      {action === 'retry' && onRetry && <TryAgain onRetry={onRetry} />}
    </div>
  );
}
