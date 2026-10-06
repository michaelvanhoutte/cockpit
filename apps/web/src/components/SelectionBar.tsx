import { useLayoutEffect, useRef } from 'react';

/**
 * What is picked out of a list, and what can be done with it ("Select several
 * items, and file them all in one go", issue 169).
 *
 * **It belongs to the list, not to the screen.** A dashboard draws several
 * panels at once, so a bar laid over the window could not say which list it was
 * about - where this one is is the answer. The bar that *is* laid over the
 * window is the one offering the way back (`undo.tsx`), and there is only ever
 * one of those because there is only ever one last change.
 */
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
   * and nothing sits on the screen's edge. Observed rather than read once,
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
        root.style.setProperty('--selection-bar-h', `${el.offsetHeight}px`);
      } else {
        root.style.removeProperty('--selection-bar-h');
      }
    };
    publish();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(publish) : null;
    observer?.observe(el);
    return () => {
      observer?.disconnect();
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
    // **`z-10` on the placeholder, which is also the bar's level**: the
    // placeholder is a stacking context, so what is inside it cannot rise above
    // it, and a pinned bar belongs below `z-floating` all the same ("Elevation",
    // docs/design-system.md) - menus and the move picker draw over it, the
    // undo offer (`undo.tsx`) over both.
    <div className="sticky bottom-0 z-10 max-md:h-[var(--selection-bar-h,3rem)]">
      <div ref={bar} className="border-t border-shade/5 bg-accent-tint px-4 py-2 max-md:fixed max-md:inset-x-0 max-md:bottom-[var(--dock-h,0px)] max-md:pr-[calc(1rem_+_var(--edge-right))] max-md:pb-[calc(0.5rem_+_var(--edge-bottom))] max-md:pl-[calc(1rem_+_var(--edge-left))] max-md:shadow-lg">
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
