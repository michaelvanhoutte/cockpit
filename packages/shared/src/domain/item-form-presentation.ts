import { z } from 'zod';

/**
 * How the Item's form is drawn: centered over the page it opened on, or
 * docked to the right edge, full height and resizable, with that page still
 * usable behind it ("Let the item's form dock to the side of the screen
 * instead of opening as a dialog", issue 481).
 *
 * **Account-wide, not per-device** - the same choice on every device the
 * account signs into, the pattern `accountTextRules` (`apps/api/src/accounts/
 * schema.ts`) already takes for a setting that is the account's rather than
 * the browser's. The width the docked form is dragged to is the opposite of
 * that, and stays per-device (`apps/web/src/itemFormDockedWidth.ts`), the same
 * as the centered form's own dragged size already does.
 */
export const ITEM_FORM_PRESENTATIONS = ['centered', 'docked'] as const;
export const itemFormPresentationSchema = z.enum(ITEM_FORM_PRESENTATIONS);
export type ItemFormPresentation = z.infer<typeof itemFormPresentationSchema>;

/** Never chosen is centered - today's only presentation, before this issue. */
export const DEFAULT_ITEM_FORM_PRESENTATION: ItemFormPresentation = 'centered';
