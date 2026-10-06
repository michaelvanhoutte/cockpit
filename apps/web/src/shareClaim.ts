import { useEffect, useRef, useState } from 'react';
import type { Arrived, HoldingArea } from './shares';

/**
 * The two places the app reaches the holding area (`shares.ts`), kept apart
 * from it so its storage and reading are fetched only when used: the initial
 * bundle has no room for them.
 */

const browserArea = async (): Promise<HoldingArea> => (await import('./shares')).browserHoldingArea();

/**
 * Claims what is held, once, where the page is signed in and shows the form.
 * Where storage cannot be read there is nothing to claim.
 *
 * **`taken` clears it once a capture has been made.** Its caller outlives the
 * form - `CaptureForms` stays mounted across Write | Car - so until then a form drawn again
 * has the share back, and after it a form drawn again does not.
 */
export function useArrived(
  claiming: boolean,
  area: () => HoldingArea | Promise<HoldingArea> = browserArea,
): { arrived: Arrived | null; taken: () => void } {
  const [arrived, setArrived] = useState<Arrived | null>(null);
  const started = useRef(false);
  useEffect(() => {
    if (!claiming || started.current) return;
    started.current = true;
    // Never cancelled: the claim has emptied the area, so dropping its answer would lose the share.
    Promise.resolve()
      .then(() => area())
      .then((held) => Promise.all([held.takeAll(), import('./shares')]))
      .then(([held, { whatArrived }]) => setArrived(whatArrived(held)))
      .catch(() => {});
  }, [claiming, area]);
  return { arrived, taken: () => setArrived(null) };
}

/** Signing out: nothing shared stays for whoever signs in next. */
export async function emptyHoldingArea(area: () => HoldingArea | Promise<HoldingArea> = browserArea): Promise<void> {
  try {
    await (await area()).empty();
  } catch {
    // Storage that cannot be written to holds nothing this could remove.
  }
}
