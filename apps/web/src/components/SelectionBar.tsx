import { useLayoutEffect, useRef } from 'react';

/**
 * What is picked out of a list, and what can be done with it ("Select several
 * items, and file them all in one go", issue 169).
 *
 * **It belongs to the list, not to the screen, from 768px up.** A dashboard
 * draws several panels at once there, so a bar laid over the window could not
 * say which list it was about - where this one is is the answer. Narrower, it
 * is laid over the foot of the screen instead (below), which says nothing
 * wrong: only one list holds a selection at a time.
 */

/** Where the bar is pinned: under 768px, the Inbox's own threshold (`roomForTheInbox.ts`). */
const PINNED = '(width < 768px)';
export function SelectionBar({
  count,
  filing,
  refusal,
  onMoveTo,
  onClear,
}: {
  /** How many rows of this list are picked. Never zero - the bar is not drawn. */
  count: number;
  /** That the filing is still going, so it cannot be asked for twice. */
  filing: boolean;
  /** Why the filing stopped, if it stopped. */
  refusal: string | null;
  onMoveTo: () => void;
  onClear: () => void;
}) {
  const bar = useRef<HTMLDivElement>(null);

  /**
   * Publishes the bar's height as `--selection-bar-h` for as long as it is
   * pinned to the screen, so the undo offer lifts above it the way it lifts
   * above the agents' dock (`AgentDock.tsx` does the same with `--dock-h`).
   * Read only while the bar is `fixed`: at 768px and wider it stays in its list
   * and nothing sits on the screen's edge. Watched rather than read once,
   * since a refusal line makes it taller and the window crossing 768px changes
   * whether it is pinned at all; and guarded for a test runner, which has no
   * layout engine to observe with.
   */
  useLayoutEffect(() => {
    const el = bar.current;
    if (!el) return;
    const root = document.documentElement;
    const publish = () => {
      if (getComputedStyle(el).position === 'fixed') {
        // Less the safe-area edge, which the bar's own padding already holds
        // and whatever stacks on this adds again.
        root.style.setProperty(
          '--selection-bar-h',
          `calc(${el.offsetHeight}px - var(--edge-bottom))`,
        );
      } else {
        root.style.removeProperty('--selection-bar-h');
      }
    };
    publish();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(publish) : null;
    observer?.observe(el);
    // Crossing the width can leave the bar's size as it was, which the
    // observer would not report.
    const width = globalThis.matchMedia?.(PINNED);
    width?.addEventListener('change', publish);
    return () => {
      observer?.disconnect();
      width?.removeEventListener('change', publish);
      root.style.removeProperty('--selection-bar-h');
    };
  }, []);

  return (
    // **Stuck to the foot of the list, not placed after it.** A panel's rows
    // scroll inside a box of a fixed height, so a bar merely put below them is
    // a bar you have to scroll to - and the first thing it would be scrolled
    // away by is the row you just picked. The Inbox does not scroll, where this
    // costs nothing and reads the same. Opaque for the same reason: rows pass
    // underneath it.
    //
    // **Below 768px, stuck to the screen instead** - the width under which
    // the Inbox gets a screen of its own (`roomForTheInbox.ts`). There the page
    // scrolls as well as the panel, so a panel taller than what is left of the
    // screen puts its own foot, and the bar with it, below the fold. Only one
    // list holds a selection at a time (`useOnlyOneListSelecting`), so a bar
    // over the screen is still unambiguously that list's. The placeholder left
    // in the list, as tall as the bar, is so its last row can still be scrolled
    // clear of it.
    //
    // **The placeholder's level is the bar's**: it is a stacking context, so
    // what is inside cannot rise above it. Pinned, it is `z-20`, over the
    // board's own `z-10` handles drawn after it - a row's seam crossing the
    // screen's foot would otherwise take the tap meant for **Move to…** - and
    // still below `z-floating` ("Elevation", docs/design-system.md), so menus
    // and the move picker draw over it, the undo offer (`undo.tsx`) over both.
    //
    // `max-[768px]` rather than `max-md`, which is in rems and so moves with
    // the browser's font size, where the Inbox's own width does not.
    <div className="sticky bottom-0 z-10 max-[768px]:z-20 max-[768px]:h-[calc(var(--selection-bar-h,3rem)_+_var(--edge-bottom))]">
      <div ref={bar} className="border-t border-shade/5 bg-accent-tint px-4 py-2 max-[768px]:fixed max-[768px]:inset-x-0 max-[768px]:bottom-[var(--dock-h,0px)] max-[768px]:pr-[calc(1rem_+_var(--edge-right))] max-[768px]:pb-[calc(0.5rem_+_var(--edge-bottom))] max-[768px]:pl-[calc(1rem_+_var(--edge-left))] max-[768px]:shadow-lg">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium tabular-nums text-accent-deep">
            {count} selected
          </span>
          <button
            type="button"
            className="ml-auto rounded-sm border border-accent/40 bg-surface px-2 py-1 text-sm hover:border-accent disabled:opacity-50"
            disabled={filing}
            onClick={onMoveTo}
          >
            {filing ? 'Moving…' : 'Move to…'}
          </button>
          <button
            type="button"
            className="rounded-sm px-2 py-1 text-sm text-ink-soft hover:text-ink disabled:opacity-50"
            disabled={filing}
            onClick={onClear}
          >
            Clear
          </button>
        </div>

        {/* Where a refusal is said when the picker has already closed - which is
          what a filing that stopped part way through does, because some of it
          happened. What is left is still picked, so this sits above the ticks
          it is about. */}
        {refusal && (
          <p role="alert" className="pt-1 text-sm text-over">
            {refusal}
          </p>
        )}
      </div>
    </div>
  );
}
