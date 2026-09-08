import type { ScreenSize } from '@cockpit/shared';
import { namedTheSame } from './names.js';

/**
 * Making and naming a screen size ("Draw a dashboard against the screen sizes
 * its account has", issue 263). Pure, like every other handler here: whether a
 * name is taken is decided entirely from the sizes handed in.
 */

/**
 * The one of `taken` already going by this name, or undefined - `namedTheSame`
 * the way a Workspace's name and a Layout's are, since a screen size is named
 * by exactly the same rule: required, trimmed, unique whatever the
 * capitalization. Unique in the *account's* whole list rather than in one
 * Dashboard's, which is the whole point of the size belonging to the account.
 */
export function screenSizeNamed(
  taken: readonly ScreenSize[],
  name: string,
  except?: string,
): ScreenSize | undefined {
  return namedTheSame(taken, name, except);
}
