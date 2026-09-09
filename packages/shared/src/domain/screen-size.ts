import { z } from 'zod';
import { panelNameSchema } from './panel.js';

/**
 * A Screen size: a name for one of the screens you work on, and the width to
 * match a window against ("Give the account a list of screen sizes, before
 * anything reads it", issue 262).
 *
 * **It belongs to the account, not to a Dashboard**, which is the whole of why
 * it exists. A Layout used to carry its own name and width, so the screens you
 * care about were re-declared on every Dashboard: `nameForScreen` handed out
 * the same four names on each one independently, and renaming *Wide* across six
 * Dashboards was six renames. One list, renamed once.
 *
 * **Nothing writes one yet.** This release adds the table, the column that
 * points at it and the field on the snapshot, so that "Draw a dashboard against
 * the screen sizes its account has" (issue 263) changes behaviour rather than
 * shape. Until it lands the list is empty in every account.
 */

/**
 * A Screen size's name obeys exactly the rules a Panel's title does, by being
 * the same schema: required, trimmed, single-line, at most 60 characters. What
 * differs is only the scope uniqueness is decided in - the account, the scope a
 * Type's name uses - and that is not a shape, so it is not here.
 */
export const screenSizeNameSchema = panelNameSchema;

/**
 * How wide a window may be said to be.
 *
 * Bounded because a screen is matched to "the size closest to this window", so
 * one absurd width would win that comparison everywhere or never. The same
 * bound `layouts.screen_width` carries today, moved to where the width now
 * lives.
 */
export const MIN_SCREEN_WIDTH = 1;
export const MAX_SCREEN_WIDTH = 100000;

/**
 * What the account's first screen size is called, where an arrangement change
 * needed one and there was none to be nearest to ("Draw a dashboard against the
 * screen sizes its account has", issue 263). The only name the product still
 * generates rather than asks for - `nameForScreen`'s four invented bands and
 * `freeName` are both gone with the rest of them.
 */
export const DEFAULT_SCREEN_SIZE_NAME = 'Default';

export const screenSizeSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  /**
   * Deliberately the permissive `z.string()` rather than `screenSizeNameSchema`,
   * for the reason a Type's name is permissive: this is the shape read *back*,
   * and a stored name should render rather than blanking the screen it appears
   * on. The rule that a name is required lives on the way in.
   */
  name: z.string(),
  /**
   * The width a window is matched against, not a breakpoint: there is no fixed
   * set of sizes to belong to, so "which size is this screen's" is a question
   * about distance rather than about membership.
   */
  width: z.number().int(),
  createdAt: z.iso.datetime(),
});
export type ScreenSize = z.infer<typeof screenSizeSchema>;

/**
 * The account's screen size nearest this window, ties going to the narrower -
 * "Draw a dashboard against the screen sizes its account has" (issue 263).
 *
 * **Shared rather than written twice**, because both halves of the app ask the
 * same question from the same list: the server resolves it when a save with
 * nothing defined has to land somewhere, and the browser resolves it to decide
 * whether a picked size has expired (`apps/web/src/panels/arrangement.ts`,
 * `layoutToDraw`). A tie-break kept in one place is a tie-break that cannot
 * answer differently on the two sides of one save.
 */
export function nearestScreenSize(
  sizes: readonly ScreenSize[],
  width: number,
): ScreenSize | null {
  return sizes.reduce<ScreenSize | null>((closest, size) => {
    if (!closest) return size;
    const near = Math.abs(size.width - width);
    const nearest = Math.abs(closest.width - width);
    if (near < nearest) return size;
    if (near === nearest && size.width < closest.width) return size;
    return closest;
  }, null);
}
