import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * "Tell a mouse user the key when they click what a key also does" (issue
 * 708): a click on Capture, the Inbox's collapse control or handle, or the
 * agents' dock's hide control or strip names the key that does the same.
 *
 * **Shown and forgotten**: nothing is stored, so a tip shows on every click.
 * It listens for clicks only, so a key press never shows one and never has to
 * be told not to suspend the keys.
 *
 * Which control was clicked is decided here, in the shell; what the tip says
 * and the toast that says it are `components/ShortcutTip.tsx`, fetched on the
 * first tip rather than in the initial bundle.
 */

/** How long a tip stays up before it goes of its own accord. */
export const TIP_MS = 5000;

/** The attribute a control wears to say which tip a click on it earns. */
export const TIP_ATTRIBUTE = 'data-shortcut-tip';

/** The controls that have a key, as their `data-shortcut-tip` names them. */
export type TipControl = 'capture' | 'inbox' | 'dock';
const CONTROLS: readonly string[] = ['capture', 'inbox', 'dock'] satisfies TipControl[];

/** What of a click decides its tip; a `MouseEvent` is one. */
type Click = {
  detail: number;
  target: EventTarget | null;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
};

/**
 * The control whose tip a click earns, or null. A keyboard activation (Enter
 * or Space on a button) arrives as a click with `detail` 0, which is how it is
 * told from a pointer's.
 */
export function tipForClick(click: Click): TipControl | null {
  if (click.detail === 0) return null;
  // A modified press (a new tab, a new window) does something the key does not.
  if (click.ctrlKey || click.metaKey || click.shiftKey || click.altKey) return null;
  const target = click.target;
  if (!(target instanceof Element)) return null;
  const control = target.closest(`[${TIP_ATTRIBUTE}]`)?.getAttribute(TIP_ATTRIBUTE);
  return control && CONTROLS.includes(control) ? (control as TipControl) : null;
}

/**
 * The tip now showing, and what feeds it. `room` is the shell's own room check:
 * a phone has no keyboard, so it gets no tip. A new tip replaces the one
 * showing and restarts its five seconds.
 */
export function useShortcutTip(room: boolean) {
  const [tip, setTip] = useState<TipControl | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const dismiss = useCallback(() => {
    clearTimeout(timer.current);
    setTip(null);
  }, []);
  const clicked = useCallback(
    (click: Click) => {
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
