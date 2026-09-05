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
  return (
    // **Stuck to the foot of the list, not placed after it.** A panel's rows
    // scroll inside a box of a fixed height, so a bar merely put below them is
    // a bar you have to scroll to - and the first thing it would be scrolled
    // away by is the row you just picked. The Inbox does not scroll, where this
    // costs nothing and reads the same. Opaque for the same reason: rows pass
    // underneath it.
    <div className="sticky bottom-0 z-10 border-t border-black/5 bg-accent-tint px-4 py-2">
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
  );
}
