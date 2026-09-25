import { useEffect } from 'react';
import { ITEM_BEING_DRAGGED } from './dropAt';

/**
 * Scrolling while dragging ("Scroll the dashboard or a panel while dragging near
 * its edge", issue 524).
 *
 * **A drag reaches only what is already on screen unless something scrolls
 * for it.** Dragging a panel by its header is a pointer gesture the browser
 * never auto-scrolls, and a native item drag scrolls the container under it in
 * some browsers and not in others, so the shell does it for both.
 *
 * **The two decisions are pure, for the reason the swipe's is** (swipe.ts):
 * jsdom scrolls nothing, so `scrollSpeed` and `boxToScroll` take pointer
 * position, box geometry and the box that was scrolling last, and the loop that
 * applies them is the browser walk's (tests/e2e/panels.test.ts).
 */

/** A scrollable box as it is on the page right now. */
export interface ScrollBox {
  id: string;
  /** A panel's own list, or the dashboard the panels are drawn in. */
  kind: 'dashboard' | 'panel';
  left: number;
  right: number;
  top: number;
  bottom: number;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

/** How far in from a box's edge a drag starts scrolling it. */
export const BAND_PX = 64;

/**
 * The slowest and the fastest a box scrolls, in pixels per frame. The slowest
 * is not zero because a browser rounds a scroll of less than a pixel to none.
 */
export const MIN_SPEED_PX = 2;
export const MAX_SPEED_PX = 22;

const eased = (fraction: number) => MIN_SPEED_PX + (MAX_SPEED_PX - MIN_SPEED_PX) * Math.min(1, fraction);

/**
 * The band is a third of the box at most, so the top's and the bottom's never
 * meet in a box too short to have a middle.
 */
const bandOf = (box: ScrollBox) => Math.min(BAND_PX, (box.bottom - box.top) / 3);

/**
 * Pixels per frame the pointer's height scrolls this box by: negative is up,
 * zero is not at all. Linear in how far into the band the pointer is, so it
 * eases in from the inner side of the band and is fastest at the edge.
 *
 * **The band is inside the edge, never past it**: above the dashboard is its
 * bar, where resting a drag on a tab switches dashboards, so a pointer past the
 * top edge is over something else and asks nothing of this box.
 */
export function scrollSpeed(y: number, box: ScrollBox): number {
  const band = bandOf(box);
  if (band <= 0 || y < box.top || y > box.bottom) return 0;
  const intoTop = box.top + band - y;
  const intoBottom = y - (box.bottom - band);
  if (intoTop > 0) {
    // Nothing above to reach.
    if (box.scrollTop <= 0) return 0;
    return -eased(intoTop / band);
  }
  if (intoBottom > 0) {
    // At its end, or nothing to scroll: a box whose content fits has no end to aim at.
    if (box.scrollTop + box.clientHeight >= box.scrollHeight - 1) return 0;
    return eased(intoBottom / band);
  }
  return 0;
}

/** Whether the pointer is in either band of the box, whether or not it can scroll. */
function inBand(point: { x: number; y: number }, box: ScrollBox): boolean {
  if (point.x < box.left || point.x >= box.right) return false;
  const band = bandOf(box);
  if (point.y < box.top || point.y > box.bottom) return false;
  return point.y < box.top + band || point.y > box.bottom - band;
}

/**
 * Which box scrolls, and how fast - one at a time.
 *
 * **The box that was scrolling keeps scrolling until the pointer leaves its
 * band**, even where it has run out of room: heading for a panel further down
 * scrolls the dashboard, and the panels sliding past under the pointer must not
 * take over. To scroll a panel's own list, go into that panel and then to its
 * edge. Otherwise the innermost box that can scroll where the pointer is wins,
 * a panel's list before the dashboard around it.
 *
 * **A panel drag scrolls only the dashboard**, since nothing in a list is
 * aimed at. The Inbox is not a box at all, so its edges ask nothing of anyone:
 * it is sorted by age and has nowhere in it to aim.
 */
export function boxToScroll(
  point: { x: number; y: number },
  boxes: readonly ScrollBox[],
  scrollingLast: string | null,
  dragging: 'item' | 'panel',
): { id: string; speed: number } | null {
  const candidates = boxes.filter((box) => dragging === 'item' || box.kind === 'dashboard');
  const held = candidates.find((box) => box.id === scrollingLast);
  if (held && inBand(point, held)) return { id: held.id, speed: scrollSpeed(point.y, held) };
  for (const kind of ['panel', 'dashboard'] as const) {
    for (const box of candidates) {
      if (box.kind !== kind || point.x < box.left || point.x >= box.right) continue;
      const speed = scrollSpeed(point.y, box);
      if (speed !== 0) return { id: box.id, speed };
    }
  }
  return null;
}

const SELECTOR = '[data-drag-scroll]';

const kind = (element: HTMLElement) =>
  element.getAttribute('data-drag-scroll') === 'dashboard' ? 'dashboard' : 'panel';

function boxesOnScreen(): { element: HTMLElement; box: ScrollBox }[] {
  return [...document.querySelectorAll<HTMLElement>(SELECTOR)].map((element, index) => {
    const at = element.getBoundingClientRect();
    return {
      element,
      box: {
        id: `${kind(element)}-${index}`,
        kind: kind(element),
        left: at.left,
        right: at.right,
        top: at.top,
        bottom: at.bottom,
        scrollTop: element.scrollTop,
        scrollHeight: element.scrollHeight,
        clientHeight: element.clientHeight,
      },
    };
  });
}

/**
 * Runs the scrolling for one drag, one step a frame, until the returned
 * function is called. `point` is where the pointer is now, or null before it
 * has moved; `afterScroll` is told when a box moved, for a drag whose drawing
 * follows the pointer and so would otherwise show the page as it was.
 */
export function scrollWhileDragging(options: {
  dragging: 'item' | 'panel';
  point: () => { x: number; y: number } | null;
  afterScroll?: () => void;
}): () => void {
  let frame = 0;
  let scrollingLast: string | null = null;
  const step = () => {
    const point = options.point();
    if (point) {
      const found = boxesOnScreen();
      const chosen = boxToScroll(
        point,
        found.map((f) => f.box),
        scrollingLast,
        options.dragging,
      );
      scrollingLast = chosen?.id ?? null;
      const target = chosen && found.find((f) => f.box.id === chosen.id);
      if (target && chosen.speed !== 0) {
        const before = target.element.scrollTop;
        target.element.scrollTop = before + chosen.speed;
        if (target.element.scrollTop !== before) options.afterScroll?.();
      }
    }
    frame = requestAnimationFrame(step);
  };
  frame = requestAnimationFrame(step);
  return () => cancelAnimationFrame(frame);
}

/**
 * Scrolls for every item drag the shell sees. Native drags fire no pointer
 * events, so the pointer is followed through `dragover`, which the page fires
 * whether or not anything accepts the drop.
 */
export function useScrollWhileDraggingAnItem(): void {
  useEffect(() => {
    let point: { x: number; y: number } | null = null;
    let stop: (() => void) | null = null;
    const finish = () => {
      stop?.();
      stop = null;
      point = null;
    };
    const onStart = (event: DragEvent) => {
      if (!event.dataTransfer?.types.includes(ITEM_BEING_DRAGGED)) return;
      finish();
      stop = scrollWhileDragging({ dragging: 'item', point: () => point });
    };
    const onOver = (event: DragEvent) => {
      point = { x: event.clientX, y: event.clientY };
    };
    document.addEventListener('dragstart', onStart);
    document.addEventListener('dragover', onOver, true);
    document.addEventListener('dragend', finish);
    document.addEventListener('drop', finish, true);
    return () => {
      finish();
      document.removeEventListener('dragstart', onStart);
      document.removeEventListener('dragover', onOver, true);
      document.removeEventListener('dragend', finish);
      document.removeEventListener('drop', finish, true);
    };
  }, []);
}
