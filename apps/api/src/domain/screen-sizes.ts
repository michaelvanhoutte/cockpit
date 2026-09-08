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

/**
 * The id the account's *Default* screen size has, derived rather than sent -
 * the same rule `firstDashboardId` follows (domain/dashboards.ts), and for the
 * same reason: `save_layout` makes this size at most once per account, and a
 * server-generated id would let a retry under a fresh request id make a second
 * one. Derived from the tenant's own id, there is only ever one to conflict
 * with.
 */
export function defaultScreenSizeId(tenantId: string): string {
  return `${tenantId}-screen-size-default`;
}
