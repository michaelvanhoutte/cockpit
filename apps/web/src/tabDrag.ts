import { useRef, useState } from 'react';
import { movedTo } from './reorder';

/**
 * Dragging a tab along its strip to where you want it ("Change a workspace or a
 * dashboard on the tab it is", issue 267).
 *
 * **The same move as the menu's**, computed through `reorder.ts` like Move left
 * and Move right, so the two cannot disagree about what moving a tab one place
 * means - which is the rule the workspaces' list was already built on
 * ("Reorder workspaces", issue 31).
 *
 * **The tabs move as the drag does.** The strip is painted in the order
 * dropping would keep, so there is nothing to read off an indicator; the same
 * choice the panels made ("Move the panels as the drag does", issue 213).
 *
 * **The pointer's alone.** An HTML5 drag is absent on a touchscreen and
 * unreachable from a keyboard, so this listens for a mouse and nothing else and
 * the menu's Move left / Move right is the path those two have - neither the
 * lesser, exactly as a panel offers both. Which also settles a collision the
 * dashboard strip already had: an *item* is dragged onto a tab to switch to it
 * ("Scroll while dragging, and switch dashboards by resting on one", issue
 * 143), and that is an HTML5 drag with its own events, so a tab moved by
 * pointer events cannot be mistaken for one.
 */
export function useTabDrag({
  order,
  onDrop,
}: {
  /** The tabs as they stand, in the order they are drawn. */
  order: string[];
  /** The whole new order, once a drag has actually moved something. */
  onDrop: (moved: string, order: string[]) => void;
}) {
  const strip = useRef<HTMLElement | null>(null);
  const [dragging, setDragging] = useState<{ id: string; to: number } | null>(null);
  /** Where a press started, until it has moved far enough to be a drag. */
  const pressed = useRef<{ id: string; x: number; pointerId: number } | null>(null);
  /** That the press became a drag, so the click ending it is not a switch. */
  const dragged = useRef(false);
  /**
   * Where the drag is, held beside the state rather than read off it: a flick
   * puts press, move and release inside one frame, and the handler that lets go
   * would still be looking at the render from before the drag started.
   */
  const live = useRef<{ id: string; to: number } | null>(null);

  /**
   * Which place the pointer is over, measured off the tabs *as painted* - which
   * already show the preview, so once the dragged tab is under the pointer it
   * stays there and the reading settles instead of flickering between two
   * places. Past the last tab means last, so dragging off the end of the strip
   * is a move rather than nothing.
   */
  const placeAt = (clientX: number) => {
    const tabs = strip.current?.querySelectorAll<HTMLElement>('[data-tab-id]');
    if (!tabs || tabs.length === 0) return null;
    for (let i = 0; i < tabs.length; i += 1) {
      if (clientX <= tabs[i]!.getBoundingClientRect().right) return i;
    }
    return tabs.length - 1;
  };

  const stop = ({ clickFollows }: { clickFollows: boolean }) => {
    pressed.current = null;
    live.current = null;
    // Cleared with the drag unless a click is still coming to be swallowed: a
    // drag released outside the window ends without one, and a flag left
    // standing would eat the next ordinary press on a tab instead.
    if (!clickFollows) dragged.current = false;
    setDragging(null);
  };

  /** What every tab in the strip carries, so a drag can start on any of them. */
  const tabProps = (id: string) => ({
    // What `placeAt` measures, and what says this element is a tab of this
    // strip rather than anything else drawn in it.
    'data-tab-id': id,
    /**
     * Not the browser's own drag, which is what a tab would otherwise get: a
     * tab is a link, and dragging a link in Chrome starts a native drag of its
     * address - which cancels the pointer the moment the gesture begins, so
     * the strip never sees a move at all. Turning it off is what makes this
     * gesture possible rather than a preference between two drags.
     */
    draggable: false,
    onPointerDown: (event: React.PointerEvent<HTMLElement>) => {
      // The primary button of a mouse. A right-click opens the tab's menu, and
      // a touch is scrolling the strip.
      if (event.button !== 0 || event.pointerType !== 'mouse') return;
      pressed.current = { id, x: event.clientX, pointerId: event.pointerId };
      dragged.current = false;
    },
    onPointerMove: (event: React.PointerEvent<HTMLElement>) => {
      const from = pressed.current;
      if (!from || from.id !== id) return;
      // Far enough across to mean it, so switching to a tab does not need a
      // steady hand: below this a press is still a press.
      if (!dragged.current && Math.abs(event.clientX - from.x) < DRAG_STARTS_AT) return;
      if (!dragged.current) {
        dragged.current = true;
        // So the rest of the drag arrives here once the tab has moved out from
        // under the pointer, which it does immediately.
        event.currentTarget.setPointerCapture(from.pointerId);
        live.current = { id, to: order.indexOf(id) };
      }
      const to = placeAt(event.clientX);
      if (to === null || live.current?.to === to) return;
      live.current = { id, to };
      setDragging(live.current);
    },
    onPointerUp: (event: React.PointerEvent<HTMLElement>) => {
      const held = live.current;
      // A release over the tab itself is followed by a click; one anywhere
      // else - the drag left the strip, or the window - is not.
      stop({ clickFollows: event.currentTarget.contains(event.target as Node) });
      if (!held) return;
      const moved = movedTo(order, held.id, held.to);
      // A drag that ends where it started asks for nothing.
      if (moved.some((at, i) => at !== order[i])) onDrop(held.id, moved);
    },
    // The browser taking the pointer back - a scroll, a window losing focus -
    // leaves the tabs where they were rather than dropping them wherever the
    // drag had got to.
    onPointerCancel: () => stop({ clickFollows: false }),
    onClickCapture: (event: React.MouseEvent) => {
      // A drag ends with a click on whatever it landed on, which would
      // otherwise switch to that tab.
      if (!dragged.current) return;
      dragged.current = false;
      event.preventDefault();
      event.stopPropagation();
    },
  });

  return {
    /** Held by the strip, which is what a drag measures the tabs inside. */
    strip,
    tabProps,
    /** The order to paint: what is stored, or where the drag would leave it. */
    shown: dragging ? movedTo(order, dragging.id, dragging.to) : order,
    /** The tab in the air, which is drawn as picked up. */
    inTheAir: dragging?.id ?? null,
  };
}

/** How far a press has to travel before it is a drag rather than a press. */
const DRAG_STARTS_AT = 5;
