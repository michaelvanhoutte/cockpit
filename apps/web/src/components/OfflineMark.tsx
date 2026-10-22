import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { goOnline } from '../opening';
import { timeOfDayLabel } from '../dateFormat';
import { useIsOffline, useRefusals } from '../offline';
import { BOTTOM_CENTRE_STRIP } from '../undo';

const timeOf = timeOfDayLabel;

/**
 * The header's outlined "Offline" pill, shown exactly while offline, found or
 * chosen, with when the read on screen was saved (dropped on a phone). Pressing
 * it opens the account menu, where *Go online* is.
 */
export function OfflineMark({ savedAt, onPress }: { savedAt: number | undefined; onPress: () => void }) {
  if (!useIsOffline()) return null;
  return (
    <button
      type="button"
      onClick={onPress}
      className="mr-2 mb-1.5 inline-flex shrink-0 items-center gap-1.5 rounded-full border border-white/25 px-2.5 py-1 text-xs text-chrome-ink-soft hover:bg-white/10"
      title="Working offline - from what this device saved"
    >
      <span aria-hidden="true" className="size-1.5 rounded-full bg-chrome-ink-soft" />
      Offline
      {savedAt !== undefined && <span className="hidden sm:inline"> · saved {timeOf(savedAt)}</span>}
    </button>
  );
}

/** How long the offer stays after a change is refused. */
const OFFER_LASTS_MS = 10_000;

/**
 * Offered each time a change is refused for working offline: the refusal says
 * why where the change was made, and this is the way out of it.
 */
export function GoOnlineOffer() {
  const queryClient = useQueryClient();
  const offline = useIsOffline();
  const refusals = useRefusals();
  const [shownFor, setShownFor] = useState(0);
  useEffect(() => {
    if (refusals === 0) return;
    setShownFor(refusals);
    const timer = setTimeout(() => setShownFor(0), OFFER_LASTS_MS);
    return () => clearTimeout(timer);
  }, [refusals]);
  if (!offline || shownFor === 0) return null;
  return (
    <div role="status" className={BOTTOM_CENTRE_STRIP}>
      <div className="pointer-events-auto flex items-center gap-x-3 rounded-lg bg-toast px-4 py-2.5 text-sm text-white shadow-lg">
        <span>Go online to make changes</span>
        <button
          type="button"
          onClick={() => void goOnline(queryClient)}
          className="rounded px-2 py-1 font-medium underline hover:bg-white/10"
        >
          Go online
        </button>
      </div>
    </div>
  );
}
