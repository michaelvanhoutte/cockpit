import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { useRoomForTheInbox } from '../roomForTheInbox';

/**
 * What is picked out of a list, and what can be done with it ("Select several
 * items, and file them all in one go", issue 169).
 *
 * **It belongs to the selection, and is drawn where that selection is held.**
 * The Inbox's is stuck to the foot of the Inbox's list. A Dashboard's spans all
 * its Panels ("Select across every panel of a dashboard", issue 863), so its
 * bar is drawn once by the board, as a card stuck to the foot of the
 * Dashboard's column (`onBoard`) - never over the Inbox, which a bar laid over
 * the window would be. Where the Inbox has no room beside the dashboards, both
 * are laid over the foot of the screen instead (below), which says nothing
 * wrong: only one scope holds a selection at a time.
 */
export function SelectionBar({
  count,
  filing,
  refusal,
  saving,
  editMenu,
  dateField,
  onMoveTo,
  onClear,
  onBoard = false,
}: {
  /** How many rows of this list are picked. Never zero - the bar is not drawn. */
  count: number;
  /** That the filing is still going, so it cannot be asked for twice. */
  filing: boolean;
  /** Why the filing stopped, if it stopped. */
  refusal: string | null;
  /** Which Item of how many an edit is sending, while one is: the count then says so, and Move to… and Edit wait. */
  saving: { at: number; of: number } | null;
  /** Edit ▾ (`useEditingSeveral`), which sits between Move to… and Clear. */
  editMenu: ReactNode;
  /** The date field Pick a date… opens, drawn under the buttons. */
  dateField?: ReactNode;
  onMoveTo: () => void;
  onClear: () => void;
  /** That this is a Dashboard's bar, drawn as a card beside the Inbox rather than as the foot of a list. */
  onBoard?: boolean;
}) {
  const bar = useRef<HTMLDivElement>(null);
  /** Pinned to the screen exactly where the Inbox gets a screen of its own. */
  const pinned = !useRoomForTheInbox();

  /**
   * Publishes how far the bar's top is from the screen's foot as
   * `--selection-bar-h`, so the undo offer lifts above it the way it lifts
   * above the agents' dock (`AgentDock.tsx` does the same with `--dock-h`):
   * an edit keeps the selection held ("Change the type, priority, due date or
   * status of every selected item from the selection bar", issue 864), and the
   * offer it makes would otherwise cover the count and Move to… of the bar the
   * next edit is made from.
   *
   * **Pinned, that is the bar's height; on the board it is where the bar has
   * got to**, which moves as the page and the Panel scroll. Less the dock and
   * the safe-area edge, which the offer adds again itself. Observed rather than
   * read once, since a refusal line makes it taller; guarded for a test runner,
   * which has no layout engine to observe with. The Inbox's own bar says
   * nothing: it holds a fifth of the screen at the left, clear of the offer.
   */
  useLayoutEffect(() => {
    const el = bar.current;
    if (!el || (!pinned && !onBoard)) return;
    const root = document.documentElement;
    const publishNow = () => {
      frame = 0;
      const lift = pinned
        ? `${el.offsetHeight}px - var(--edge-bottom)`
        : `max(0px, ${Math.round(window.innerHeight - el.getBoundingClientRect().top)}px - var(--dock-h, 0px) - var(--edge-bottom))`;
      root.style.setProperty('--selection-bar-h', `calc(${lift})`);
    };
    // Once a frame at most: a scroll fires many times a frame, and each read
    // here is a layout.
    let frame = 0;
    const publish = () => {
      if (frame === 0) frame = requestAnimationFrame(publishNow);
    };
    publishNow();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(publish) : null;
    observer?.observe(el);
    if (!pinned) {
      // **And everything it stands in**, since on a board shorter than the
      // window the bar sits after the last row: an edit that finishes Items
      // takes rows away, the bar rises, and neither a scroll nor a resize says
      // so - the very offer that edit makes would be left over the bar.
      for (let up = el.parentElement; up; up = up.parentElement) observer?.observe(up);
      window.addEventListener('resize', publish);
      window.addEventListener('scroll', publish, { capture: true, passive: true });
    }
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener('resize', publish);
      window.removeEventListener('scroll', publish, { capture: true });
      root.style.removeProperty('--selection-bar-h');
    };
  }, [pinned, onBoard]);

  return (
    // **Stuck to the foot of the list, not placed after it.** A panel's rows
    // scroll inside a box of a fixed height, so a bar merely put below them is
    // a bar you have to scroll to - and the first thing it would be scrolled
    // away by is the row you just picked. The Inbox does not scroll, where this
    // costs nothing and reads the same. Opaque for the same reason: rows pass
    // underneath it.
    //
    // **Pinned to the screen's foot where the Inbox has no room beside the
    // dashboards.** There the page scrolls as well as the panel, so a panel
    // taller than what is left of the screen puts its own foot, and the bar
    // with it, below the fold. What stays in the list is a placeholder as tall
    // as the bar, so its last row can still be scrolled clear of it.
    //
    // **`z-20` on the placeholder, which is the bar's level**: it is a stacking
    // context, so what is inside cannot rise above it. That is over the board's
    // own `z-10` row seams and grips drawn after it, which would otherwise take
    // a tap meant for the bar, and below `z-floating` ("Elevation",
    // docs/design-system.md), so menus and the move picker draw over it and the
    // undo offer (`undo.tsx`) over both.
    <div
      className={`sticky bottom-0 z-20 ${
        pinned ? 'h-[calc(var(--selection-bar-h,3rem)_+_var(--edge-bottom))]' : onBoard ? 'pt-1 pb-2' : ''
      }`}
    >
      <div
        ref={bar}
        className={`bg-accent-tint px-4 py-2 ${
          pinned
            ? 'fixed inset-x-0 bottom-0 border-t border-shade/5 pr-[calc(1rem_+_var(--edge-right))] pb-[calc(0.5rem_+_var(--edge-bottom))] pl-[calc(1rem_+_var(--edge-left))] shadow-lg'
            : onBoard
              ? 'rounded-md border border-shade/10 shadow-lg'
              : 'border-t border-shade/5'
        }`}
      >
        {/* Wraps, so the Inbox's column - a fifth of the screen - puts the buttons
          on a line of their own under the count rather than breaking each
          label across two. */}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="whitespace-nowrap text-sm font-medium tabular-nums text-accent-deep">
            {saving ? `Saving ${saving.at} of ${saving.of}…` : `${count} selected`}
          </span>
          <div className="ml-auto flex items-center gap-2 whitespace-nowrap">
            <button
              type="button"
              className="rounded-sm border border-accent/40 bg-surface px-2 py-1 text-sm hover:border-accent disabled:opacity-50"
              disabled={filing || saving !== null}
              onClick={onMoveTo}
            >
              {filing ? 'Moving…' : 'Move to…'}
            </button>
            {editMenu}
            <button
              type="button"
              className="rounded-sm px-2 py-1 text-sm text-ink-soft hover:text-ink disabled:opacity-50"
              disabled={filing || saving !== null}
              onClick={onClear}
            >
              Clear
            </button>
          </div>
        </div>

        {dateField}

        {/* Where a refusal is said when the picker has already closed - which is
          what a filing that stopped part way through does, because some of it
          happened. What is left is still picked, so this sits above the ticks
          it is about. An edit's says how many were not changed and why. */}
        {refusal && (
          <p role="alert" className="pt-1 text-sm text-over-ink">
            {refusal}
          </p>
        )}
      </div>
    </div>
  );
}
