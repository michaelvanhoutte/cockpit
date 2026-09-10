/**
 * How wide the Inbox column is beside the dashboards, past the automatic
 * fifth-of-the-row sizing `roomForTheInbox.ts` hands out for free ("Let the
 * Inbox column be resized horizontally", issue 331).
 *
 * **Remembered in the browser, not the database, for the same reason
 * `lastVisited.ts`'s views are:** this is chrome, not content, so it is one
 * width for the browser rather than a write per workspace switched into. And
 * **forgotten at sign-out for the same reason a dragged item-form size is**
 * (`itemFormSize.ts`) - a size a drag last left something at is exactly the
 * kind of thing leaving it behind hands the first person's answer to the
 * second (`session/forget.ts`), so `forgetInboxWidth` below joins the others
 * `forgetEverything` already calls.
 */

/** The narrowest the column may be dragged to - where a row can still hold a title. */
export const INBOX_WIDTH_FLOOR = 280;

const KEY = 'cockpit.inbox-width';

/**
 * What else the row it shares with the dashboard spends before either column
 * sees any of it: the resize handle itself (`w-2`) and the two `gap-1` seams
 * either side of it, in Layout.tsx's own markup. Named rather than folded into
 * the arithmetic below, so the one place that number comes from is also the
 * one place it would need to change if the handle's own width ever did.
 */
const ROW_OVERHEAD = 16;

/**
 * The widest the column may be dragged to: half of what the row it shares
 * with the dashboard actually has, so dragging can never leave the dashboard
 * with less room than the Inbox has just taken.
 */
export function inboxWidthCeiling(rowWidth: number): number {
  return Math.max(INBOX_WIDTH_FLOOR, (rowWidth - ROW_OVERHEAD) / 2);
}

/**
 * A preferred width, brought inside the floor and the row's own ceiling.
 *
 * Pure, so the same clamp runs live during a drag and again whenever the row
 * is measured a different width - a window narrowed after a wide choice
 * clamps what is drawn without touching the choice itself, and this answers
 * the original number again once the row is wide enough to hold it.
 */
export function clampInboxWidth(preferred: number, rowWidth: number): number {
  return Math.min(Math.max(preferred, INBOX_WIDTH_FLOOR), inboxWidthCeiling(rowWidth));
}

/**
 * The stored width, where there is a usable one.
 *
 * A hand-edited or stale value - not a finite positive number - answers
 * `null` rather than handing a caller something it would have to validate
 * again itself; `null` is exactly what "nothing chosen, use the automatic
 * sizing" already means to every caller.
 */
export function readInboxWidth(store: Storage | undefined): number | null {
  try {
    const raw = store?.getItem(KEY);
    if (raw === null || raw === undefined) return null;
    const width = Number(raw);
    return Number.isFinite(width) && width > 0 ? width : null;
  } catch {
    return null;
  }
}

/** `null` clears the preference, back to the automatic sizing. */
export function writeInboxWidth(store: Storage | undefined, width: number | null): void {
  try {
    if (width === null) store?.removeItem(KEY);
    else store?.setItem(KEY, String(width));
  } catch {
    // Not remembering the resize is a smaller thing than one that throws.
  }
}

/** Called from `session/forget.ts`, alongside the item form's own dragged size. */
export function forgetInboxWidth(store: Storage | undefined): void {
  writeInboxWidth(store, null);
}
