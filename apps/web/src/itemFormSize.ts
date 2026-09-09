/**
 * The size someone drags the item form to, remembered per browser rather than
 * per item ("Fix the item form's resize jank, and let it be resized", issue
 * 295) - the box a drag leaves the dialog at is the box every item's form
 * opens at next, not a size that belongs to whichever item happened to be
 * open when it was dragged.
 *
 * **Remembered in the browser, not in the database**, for the reason the last
 * visited view is (`lastVisited.ts`): a size chosen at a desk is not one
 * worth writing, invalidating and pushing to a phone that cannot show it
 * anyway.
 *
 * **Clamping to the current screen is left to CSS.** The dialog keeps the
 * same `max-width`/`max-height` it always sized itself by; an inline
 * `width`/`height` reads only what is stored here, verbatim, so a size that
 * no longer fits is clamped by the browser's own box model on the way to the
 * screen rather than by a copy of that arithmetic kept here - and what is
 * stored is never rewritten by a clamp that only ever touches what is drawn.
 */

export interface Size {
  width: number;
  height: number;
}

const KEY = 'cockpit.item-form-size';

function isSize(value: unknown): value is Size {
  const { width, height } = (value ?? {}) as Partial<Size>;
  return (
    typeof width === 'number' &&
    Number.isFinite(width) &&
    width > 0 &&
    typeof height === 'number' &&
    Number.isFinite(height) &&
    height > 0
  );
}

/**
 * What was remembered, or nothing where there is nothing usable to read.
 *
 * Anything that is not a size of two positive numbers answers "nothing
 * remembered": the value is a browser's, so it can be missing, hand-edited or
 * left by an older version, and none of those is worth failing the dialog
 * open over.
 */
export function rememberedItemFormSize(store: Storage | undefined): Size | null {
  try {
    const raw = store?.getItem(KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isSize(parsed) ? { width: parsed.width, height: parsed.height } : null;
  } catch {
    return null;
  }
}

export function rememberItemFormSize(store: Storage | undefined, size: Size): void {
  try {
    store?.setItem(KEY, JSON.stringify(size));
  } catch {
    // Not remembering is a smaller thing than failing to resize.
  }
}

/**
 * Forgets the remembered size, on signing out.
 *
 * A size dragged to is a preference about the browser, not about the person -
 * but it is still drawn from what they did in it, so it goes with the rest of
 * what a sign-out clears (`session/forget.ts`) rather than outliving them for
 * whoever signs in next.
 */
export function forgetItemFormSize(store: Storage | undefined): void {
  try {
    store?.removeItem(KEY);
  } catch {
    // A browser that refuses storage remembered nothing to forget.
  }
}
