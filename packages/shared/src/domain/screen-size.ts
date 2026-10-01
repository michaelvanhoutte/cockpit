import { z } from 'zod';
import { panelNameSchema } from './panel.js';

/**
 * A Screen size: a name for one of the screens you work on, and the width to
 * match a window against ("Give the account a list of screen sizes, before
 * anything reads it", issue 262; architecture.md §4.4, "packages/shared:
 * schema and command rationale", for why it belongs to the account rather
 * than to a Dashboard).
 */

/** A Screen size's name obeys exactly the rules a Panel's title does, by being the same schema. */
export const screenSizeNameSchema = panelNameSchema;

/**
 * How wide a window may be said to be. Bounded because a screen is matched to "the size closest to this window" (architecture.md §4.4).
 *
 * **The floor is where a phone ends.** A window narrower than this is drawn one
 * Panel across and offers no arranging at all, so a Screen size below it would
 * be a width nothing is ever matched to or made at (`isPhoneWidth`). It is the
 * width the repo's own phone viewport sits under (`playwright.config.ts`).
 * Only making one is bounded by it: a size stored before the floor rose stays
 * as it is, which is why the stored column's own check still starts at 1.
 */
export const MIN_SCREEN_WIDTH = 480;
export const MAX_SCREEN_WIDTH = 100000;

/** Whether a window is a phone's: too narrow for any Layout to be read or made on it. */
export function isPhoneWidth(width: number): boolean {
  return width < MIN_SCREEN_WIDTH;
}

/** What the account's first screen size is called, made the first time an arrangement change needs one ("Draw a dashboard against the screen sizes its account has", issue 263; architecture.md §4.4). */
export const DEFAULT_SCREEN_SIZE_NAME = 'Default';

export const screenSizeSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  /** Permissive read-back field, for the reason a Type's name is (architecture.md §4.4). */
  name: z.string(),
  /** The width a window is matched against, not a breakpoint. */
  width: z.number().int(),
  createdAt: z.iso.datetime(),
});
export type ScreenSize = z.infer<typeof screenSizeSchema>;

/**
 * The account's screen size nearest this window, ties going to the narrower
 * (issue 263). Shared rather than written twice, since server and client both
 * ask the same question from the same list — the client calls this from
 * `apps/web/src/panels/arrangement.ts`'s `layoutToDraw`, to decide whether a
 * picked size has expired (architecture.md §4.4).
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
