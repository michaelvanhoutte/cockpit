import { useCallback, useEffect, useRef, useState } from 'react';
import { AGENT_DOCK_KEY } from './agentDockHidden';
import { CAPTURE_KEY } from './captureShortcut';
import { INBOX_KEY } from './inboxCollapsed';

/**
 * "Tell a mouse user the key when they click what a key also does" (issue
 * 708): a click on Capture, the Inbox's collapse control or handle, or the
 * agents' dock's hide control or strip names the key that does the same.
 *
 * **Shown and forgotten**: nothing is stored, so a tip shows on every click.
 * It listens for clicks only, so a key press never shows one and never has to
 * be told not to suspend the keys.
 */

/** How long a tip stays up before it goes of its own accord. */
export const TIP_MS = 5000;

/** The attribute a control wears to say which tip a click on it earns. */
export const TIP_ATTRIBUTE = 'data-shortcut-tip';

const TIPS: Record<string, string> = {
  capture: `Tip: press ${CAPTURE_KEY.toUpperCase()} to capture from anywhere`,
  inbox: `Tip: press ${INBOX_KEY.toUpperCase()} to collapse or open the Inbox`,
  dock: `Tip: press ${AGENT_DOCK_KEY.toUpperCase()} to hide or show the agents\u2019 dock`,
};

/**
 * The tip a click earns, or null. A keyboard activation (Enter or Space on a
 * button) arrives as a click with `detail` 0, which is how it is told from a
 * pointer's.
 */
export function tipForClick(click: { detail: number; target: EventTarget | null }): string | null {
  if (click.detail === 0) return null;
  const target = click.target;
  if (!(target instanceof Element)) return null;
  const control = target.closest(`[${TIP_ATTRIBUTE}]`)?.getAttribute(TIP_ATTRIBUTE);
  return (control && TIPS[control]) || null;
}

/**
 * The tip now showing, and what feeds it. `room` is the shell's own room check:
 * a phone has no keyboard, so it gets no tip. A new tip replaces the one
 * showing and restarts its five seconds.
 */
export function useShortcutTip(room: boolean) {
  const [tip, setTip] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const dismiss = useCallback(() => {
    clearTimeout(timer.current);
    setTip(null);
  }, []);
  const clicked = useCallback(
    (click: { detail: number; target: EventTarget | null }) => {
      const next = room ? tipForClick(click) : null;
      if (next === null) return;
      clearTimeout(timer.current);
      setTip(next);
      timer.current = setTimeout(() => setTip(null), TIP_MS);
    },
    [room],
  );
  useEffect(() => () => clearTimeout(timer.current), []);
  return { tip, clicked, dismiss };
}

/** The toast, at the bottom centre and clear of the agents' dock like the undo offer. */
export function ShortcutTip({ tip, onDismiss }: { tip: string | null; onDismiss: () => void }) {
  if (tip === null) return null;
  return (
    <div
      role="status"
      className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex justify-center pt-4 pr-[calc(1rem_+_var(--edge-right)_+_var(--docked-form-w,0px))] pb-[calc(1rem_+_var(--edge-bottom)_+_var(--dock-h,0px))] pl-[calc(1rem_+_var(--edge-left))]"
    >
      <div
        // Kept from the document, where an open window (Capture, opened by the
        // very click that showed this) would read a press here as one outside
        // it and close: the tip must never get in the way.
        onPointerDown={(event) => event.stopPropagation()}
        className="pointer-events-auto flex max-w-[min(32rem,calc(100vw-2rem))] items-center gap-3 rounded-lg bg-ink px-4 py-2.5 text-sm text-white shadow-lg">
        <span className="min-w-0 flex-1">{tip}</span>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss the tip"
          className="pointer-events-auto shrink-0 rounded px-2 py-1 text-white/70 hover:bg-white/10 hover:text-white"
        >
          {'\u2715'}
        </button>
      </div>
    </div>
  );
}
