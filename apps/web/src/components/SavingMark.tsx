import { useEffect, useState } from 'react';
import { useUnansweredChanges } from '../api/changes';

/** Shown only once a change has waited this long, so a quick save never flickers it. */
const AFTER_MS = 500;

/**
 * The header's saving sign: a small cloud with an up-arrow, no words, left of
 * the account menu where the Offline pill sits. It shows while a change this tab
 * made has been unanswered for longer than `AFTER_MS`, and says how many on
 * hover or a long press.
 */
export function SavingMark() {
  const count = useUnansweredChanges();
  const [shown, setShown] = useState(false);
  // Keyed on whether anything is waiting, not on how many: a second change joining
  // a first must not restart the half second the first has been waiting.
  const idle = count === 0;
  useEffect(() => {
    if (idle) {
      setShown(false);
      return;
    }
    const timer = setTimeout(() => setShown(true), AFTER_MS);
    return () => clearTimeout(timer);
  }, [idle]);
  if (!shown || idle) return null;
  const label = `Saving ${count} ${count === 1 ? 'change' : 'changes'}…`;
  return (
    <span
      role="status"
      aria-label={label}
      title={label}
      className="mr-2 mb-2 inline-flex size-6 shrink-0 items-center justify-center text-chrome-ink-soft"
    >
      <svg viewBox="0 0 24 24" className="size-4 animate-pulse" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true">
        <path d="M7 18a4.5 4.5 0 0 1-.6-8.96A6 6 0 0 1 18 8.5a4 4 0 0 1-.5 9.5H7Z" strokeLinejoin="round" />
        <path d="M12 15v-5m0 0-2 2m2-2 2 2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );
}
