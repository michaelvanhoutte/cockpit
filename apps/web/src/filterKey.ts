import { useEffect, useRef } from 'react';
import { isTypedInto, somethingIsOpenOverThePage, type KeyPress } from './inboxCollapsed';

/**
 * The key that opens a Dashboard's filter bar and puts the cursor in
 * *Containing…* ("Open a Dashboard's filter bar with F", issue 811), named in
 * the funnel's tooltip and in the tip a click on it shows.
 */
export const FILTER_KEY = 'f';

/**
 * Whether this key press is F: not while typing, not with a modifier held, not
 * while a menu or a window is open, and not for a key held down - the guards
 * the other keys carry, for the same reasons.
 */
export function pressesFilterKey(press: KeyPress, covered: boolean): boolean {
  if (press.key.toLowerCase() !== FILTER_KEY) return false;
  if (press.ctrlKey || press.altKey || press.metaKey) return false;
  if (press.repeat || press.defaultPrevented) return false;
  return !press.typing && !covered;
}

/**
 * What F does to a bar. **It never clears a filter**, unlike the funnel on the
 * open tab: a key that silently drops a filter is too easy to press by
 * accident. So F closes only a bar that is open with nothing set; everywhere
 * else it puts the cursor in *Containing…*, opening the bar first if need be.
 */
export function whatFDoes(open: boolean, filtering: boolean): 'open' | 'focus' | 'close' {
  if (filtering) return 'focus';
  return open ? 'close' : 'open';
}

/** Whose *Containing…* field has been asked for the cursor, until it takes it. */
let wanted: string | null = null;
const takers = new Set<() => void>();

/** Asks the bar of this filter to put the cursor in *Containing…*, as soon as it is drawn. */
export function askForTheContainingField(filterId: string): void {
  wanted = filterId;
  for (const take of takers) take();
}

/**
 * Gives the cursor to the field once it is asked for. Runs after every render,
 * since the field only exists once the bar has opened.
 */
export function useContainingFieldFocus(filterId: string, field: { current: HTMLInputElement | null }) {
  useEffect(() => {
    const take = () => {
      if (wanted !== filterId || !field.current) return;
      wanted = null;
      field.current.focus();
    };
    take();
    takers.add(take);
    return () => void takers.delete(take);
  });
}

/**
 * Listens for F while `listening` (a bar is on screen at desk width). `act` is
 * read at press time so the one listener never goes stale.
 */
export function useFilterKey(listening: boolean, act: () => void): void {
  const now = useRef(act);
  now.current = act;
  useEffect(() => {
    if (!listening) return;
    const onKey = (event: KeyboardEvent) => {
      const presses = pressesFilterKey(
        {
          key: event.key,
          ctrlKey: event.ctrlKey,
          altKey: event.altKey,
          metaKey: event.metaKey,
          repeat: event.repeat,
          defaultPrevented: event.defaultPrevented,
          typing: isTypedInto(event.target),
        },
        somethingIsOpenOverThePage(),
      );
      if (!presses) return;
      // Kept from the field it is about to focus, which would otherwise type an f.
      event.preventDefault();
      now.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [listening]);
}
