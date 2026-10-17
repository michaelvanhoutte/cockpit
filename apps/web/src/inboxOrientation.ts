/**
 * Keeping your place when the Inbox's rows rearrange ("Keep your place when the
 * Inbox regroups", issue 1168). Proposals arrive after a capture and filing
 * re-proposes the rest, so groups form, merge and dissolve while you look:
 * every row that stays slides from where it was to where it is, the row the
 * keyboard is on holds its place on screen, the rows you were dealing with
 * flash where they land, and a press on a row mid-slide does nothing.
 *
 * A chunk of its own, fetched right after the first paint (`ItemList`): nothing
 * regroups before proposals arrive, so it is there first, and a regroup that
 * beats it simply jumps. It keeps no state past a render and stores nothing:
 * rows are read where they were before a change lands and where they are after.
 */

export const SLIDE_MS = 250;
export const FLASH_MS = 2000;

/** The rows of a list in the order drawn, and the top of each on screen. */
export type Seen = { order: string[]; tops: Map<string, number> };

/** Under this a row has not moved: a pixel of rounding is not a slide. */
const NOTICEABLE_PX = 1;

/**
 * What a change to the rows does. Rows slide only when the order of the rows
 * that are still there changed: one arriving or leaving shifts the rest
 * without reordering any of them, and nothing animates. The same holds for the
 * flash, which marks where the rows you were on landed after a reorder.
 */
export function whatMoves(then: Seen, now: Seen, touched: readonly string[]) {
  const keptNow = now.order.filter((id) => then.tops.has(id));
  const keptThen = then.order.filter((id) => now.tops.has(id));
  const reordered = keptNow.some((id, at) => id !== keptThen[at]);
  if (!reordered) return { reordered, slides: [] as { id: string; dy: number }[], flashes: [] as string[] };
  const slides = keptNow.flatMap((id) => {
    const dy = then.tops.get(id)! - now.tops.get(id)!;
    return Math.abs(dy) > NOTICEABLE_PX ? [{ id, dy }] : [];
  });
  const flashes = [...new Set(touched)].filter((id) => now.tops.has(id));
  return { reordered, slides, flashes };
}

/** How far the list must scroll for the row the keyboard is on to be where it was. */
export function scrollToHold(then: Seen, now: Seen, focusedId: string | null): number {
  if (!focusedId) return 0;
  const was = then.tops.get(focusedId);
  const is = now.tops.get(focusedId);
  if (was === undefined || is === undefined) return 0;
  const drift = is - was;
  return Math.abs(drift) > NOTICEABLE_PX ? drift : 0;
}

const ROW = 'li[data-item-row]';

function see(box: HTMLElement): Seen {
  const rows = [...box.querySelectorAll<HTMLElement>(ROW)];
  return {
    order: rows.map((row) => row.dataset.itemId!),
    tops: new Map(rows.map((row) => [row.dataset.itemId!, row.getBoundingClientRect().top])),
  };
}

function scrollerOf(box: HTMLElement): HTMLElement | null {
  for (let at = box.parentElement; at; at = at.parentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(at).overflowY)) return at;
  }
  return null;
}

const PRESSES = ['pointerdown', 'mousedown', 'click', 'dblclick'] as const;

/**
 * Orients one list's box. `read` is called while rendering a change to the
 * rows, before it lands; `settle` once it has, with the ids of the selected
 * rows. `detach` takes the listeners off.
 */
export function orient(box: HTMLElement) {
  let seen: Seen | null = null;
  let pointerOn: string | null = null;
  let sliding = false;
  let slideOver: ReturnType<typeof setTimeout> | undefined;

  const track = (event: Event) => {
    pointerOn = (event.target as HTMLElement).closest<HTMLElement>(ROW)?.dataset.itemId ?? null;
  };
  const leave = () => {
    pointerOn = null;
  };
  // Native and in the capture phase, so it stops the press before React's own
  // handlers on the row and the chips in it see it.
  const guard = (event: Event) => {
    if (!sliding || !(event.target as HTMLElement).closest(ROW)) return;
    event.preventDefault();
    event.stopPropagation();
  };
  box.addEventListener('pointermove', track);
  box.addEventListener('pointerleave', leave);
  for (const press of PRESSES) box.addEventListener(press, guard, true);

  return {
    read() {
      seen = see(box);
    },
    settle(picked: readonly string[]) {
      const then = seen;
      seen = null;
      if (!then) return;
      const active = document.activeElement as HTMLElement | null;
      const focused = active && box.contains(active) ? active.closest<HTMLElement>(ROW) : null;
      const focusedId = focused?.dataset.itemId ?? null;

      // First the focused row back where it was, then every other row measured
      // against that, so the slide starts from where it was on screen.
      const scroller = scrollerOf(box);
      let now = see(box);
      const shift = scroller ? scrollToHold(then, now, focusedId) : 0;
      if (scroller && shift !== 0) {
        scroller.scrollTop += shift;
        now = see(box);
      }

      const { slides, flashes } = whatMoves(then, now, [...picked, ...(focusedId ? [focusedId] : []), ...(pointerOn ? [pointerOn] : [])]);
      const drawn = new Map([...box.querySelectorAll<HTMLElement>(ROW)].map((row) => [row.dataset.itemId!, row]));
      const rowOf = (id: string) => drawn.get(id);
      const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

      if (slides.length > 0 && !still) {
        for (const { id, dy } of slides) {
          rowOf(id)?.animate?.([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], {
            duration: SLIDE_MS,
            easing: 'ease-out',
          });
        }
        sliding = true;
        clearTimeout(slideOver);
        slideOver = setTimeout(() => {
          sliding = false;
        }, SLIDE_MS);
      }
      for (const id of flashes) {
        const mark = 'inset 0 0 0 2px var(--color-accent)';
        rowOf(id)?.animate?.(
          [
            { boxShadow: mark, backgroundColor: 'color-mix(in srgb, var(--color-accent) 28%, transparent)' },
            { boxShadow: mark, backgroundColor: 'color-mix(in srgb, var(--color-accent) 28%, transparent)', offset: 0.6 },
            { boxShadow: 'inset 0 0 0 2px transparent', backgroundColor: 'transparent' },
          ],
          // Starts as the slide ends, so it is seen where the row has landed.
          { duration: FLASH_MS, delay: still ? 0 : SLIDE_MS, easing: 'ease-in', fill: 'backwards' },
        );
      }
    },
    detach() {
      clearTimeout(slideOver);
      sliding = false;
      box.removeEventListener('pointermove', track);
      box.removeEventListener('pointerleave', leave);
      for (const press of PRESSES) box.removeEventListener(press, guard, true);
    },
  };
}
