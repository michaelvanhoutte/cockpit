/**
 * How wide the item's form is once it is docked to the side, past whatever it
 * opens at by default ("Let the item's form dock to the side of the screen
 * instead of opening as a dialog", issue 481).
 *
 * **Remembered in the browser, not the account, unlike the choice to dock at
 * all** (`ItemFormPresentation`, `@cockpit/shared`): a width dragged to at one
 * desk is not one worth writing, invalidating and pushing to a phone that
 * docks nothing anyway - the same split `itemFormSize.ts`'s own header draws
 * for the centered form's dragged size, and `inboxWidth.ts`'s for the Inbox
 * column beside it. **Forgotten at sign-out for the same reason**
 * (`session/forget.ts`).
 */

/** The narrowest the docked form may be dragged to - where its own two-column body can still hold its own. */
export const ITEM_FORM_DOCKED_WIDTH_FLOOR = 320;

const KEY = 'cockpit.item-form-docked-width';

/**
 * The widest the docked form may be dragged to: half of the window, so
 * dragging it can never leave the page behind it - still open, still
 * clickable - with less room than the form has just taken.
 */
export function itemFormDockedWidthCeiling(windowWidth: number): number {
  return Math.max(ITEM_FORM_DOCKED_WIDTH_FLOOR, windowWidth / 2);
}

/**
 * A preferred width, brought inside the floor and the window's own ceiling.
 *
 * Pure, so the same clamp runs live during a drag and again whenever the
 * window is measured a different width - a window narrowed after a wide
 * choice clamps what is drawn without touching the choice itself, and this
 * answers the original number again once the window is wide enough to hold
 * it (the same rule `clampInboxWidth`, `inboxWidth.ts`, follows for its own
 * row rather than a window).
 */
export function clampItemFormDockedWidth(preferred: number, windowWidth: number): number {
  return Math.min(
    Math.max(preferred, ITEM_FORM_DOCKED_WIDTH_FLOOR),
    itemFormDockedWidthCeiling(windowWidth),
  );
}

/**
 * The stored width, where there is a usable one.
 *
 * A hand-edited or stale value - not a finite positive number - answers
 * `null` rather than handing a caller something it would have to validate
 * again itself; `null` is exactly what "nothing chosen, use the default
 * width" already means to every caller.
 */
export function readItemFormDockedWidth(store: Storage | undefined): number | null {
  try {
    const raw = store?.getItem(KEY);
    if (raw === null || raw === undefined) return null;
    const width = Number(raw);
    return Number.isFinite(width) && width > 0 ? width : null;
  } catch {
    return null;
  }
}

export function writeItemFormDockedWidth(store: Storage | undefined, width: number): void {
  try {
    store?.setItem(KEY, String(width));
  } catch {
    // Not remembering the resize is a smaller thing than one that throws.
  }
}

/** Called from `session/forget.ts`, alongside the item form's own dragged size and the Inbox column's own width. */
export function forgetItemFormDockedWidth(store: Storage | undefined): void {
  try {
    store?.removeItem(KEY);
  } catch {
    // A browser that refuses storage remembered nothing to forget.
  }
}
