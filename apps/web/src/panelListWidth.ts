import { useCallback, useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { PANEL_LIST_WIDTH_KEY } from './panelList';

/**
 * How wide the Go to panel column is drawn ("Resize the Go to panel column by
 * dragging its edge", issue 815): the Inbox column's resize (`inboxWidth.ts`)
 * applied to the column at the Dashboard's other side, from its left edge.
 *
 * **Kept out of `panelList.ts`** because that file is in the first load and
 * this is only needed once the column is drawn; only the key and the sign-out
 * forgetting live there. Remembered in the browser and forgotten at sign-out
 * for the Inbox width's reasons.
 */

/** Today's width (`w-56`), which is both the narrowest the column goes and what a double-click returns to. */
export const PANEL_LIST_WIDTH_FLOOR = 224;

/** A third of the row it shares with the Dashboard, never under the floor. */
export function panelListWidthCeiling(rowWidth: number): number {
  return Math.max(PANEL_LIST_WIDTH_FLOOR, rowWidth / 3);
}

/**
 * Pure, so the same clamp runs live during a drag and whenever the row is
 * measured again: a window narrowed after a wide choice clamps what is drawn
 * and leaves the choice, which this answers in full once the row is wide again.
 */
export function clampPanelListWidth(preferred: number, rowWidth: number): number {
  return Math.min(Math.max(preferred, PANEL_LIST_WIDTH_FLOOR), panelListWidthCeiling(rowWidth));
}

/** The stored width, or null where there is no usable one. */
export function readPanelListWidth(store: Storage | undefined): number | null {
  try {
    const raw = store?.getItem(PANEL_LIST_WIDTH_KEY);
    if (raw === null || raw === undefined) return null;
    const width = Number(raw);
    return Number.isFinite(width) && width > 0 ? width : null;
  } catch {
    return null;
  }
}

/** `null` clears the choice, back to the floor. */
export function writePanelListWidth(store: Storage | undefined, width: number | null): void {
  try {
    if (width === null) store?.removeItem(PANEL_LIST_WIDTH_KEY);
    else store?.setItem(PANEL_LIST_WIDTH_KEY, String(width));
  } catch {
    // Not remembering the width is a smaller thing than one that throws.
  }
}

type Drag = { startWidth: number; startX: number; latest: number; pointerId: number };

/**
 * The width to draw, and what the column's left edge needs to resize it.
 *
 * The drag computes from its two fixed starting points on every move, not from
 * the previous move, so retracing a drag retraces what it showed. Dragging
 * left widens the column, since the handle is its left edge. Escape or a
 * cancelled pointer abandons the drag with nothing kept; a release where it
 * began keeps nothing either.
 */
export function usePanelListWidth(store: Storage | undefined, rowWidth: number) {
  const [chosen, setChosen] = useState<number | null>(() => readPanelListWidth(store));
  const [preview, setPreview] = useState<number | null>(null);
  const drag = useRef<Drag | null>(null);
  const rowRef = useRef(rowWidth);
  rowRef.current = rowWidth;
  const column = useRef<HTMLElement>(null);
  const stop = useRef<(() => void) | null>(null);

  useEffect(() => () => stop.current?.(), []);

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (event.button !== 0 || drag.current || !column.current) return;
      event.preventDefault();
      const startWidth = column.current.getBoundingClientRect().width;
      const held: Drag = { startWidth, startX: event.clientX, latest: startWidth, pointerId: event.pointerId };
      drag.current = held;
      setPreview(startWidth);
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // The moves still arrive while the pointer is over the edge.
      }
      const end = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onCancel);
        window.removeEventListener('keydown', onKey);
        drag.current = null;
        stop.current = null;
        setPreview(null);
      };
      const onMove = (move: PointerEvent) => {
        if (move.pointerId !== held.pointerId) return;
        held.latest = clampPanelListWidth(held.startWidth + (held.startX - move.clientX), rowRef.current);
        setPreview(held.latest);
      };
      const onUp = (up: PointerEvent) => {
        if (up.pointerId !== held.pointerId) return;
        end();
        if (held.latest === held.startWidth) return;
        setChosen(held.latest);
        writePanelListWidth(store, held.latest);
      };
      const onCancel = (cancel: PointerEvent) => {
        if (cancel.pointerId === held.pointerId) end();
      };
      const onKey = (key: KeyboardEvent) => {
        if (key.key === 'Escape') end();
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onCancel);
      window.addEventListener('keydown', onKey);
      stop.current = end;
    },
    [store],
  );

  const reset = useCallback(() => {
    stop.current?.();
    setChosen(null);
    writePanelListWidth(store, null);
  }, [store]);

  const width = clampPanelListWidth(preview ?? chosen ?? PANEL_LIST_WIDTH_FLOOR, rowWidth);
  return { width, column, onPointerDown, reset };
}
