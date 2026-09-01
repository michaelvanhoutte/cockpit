import { DEFAULT_WORKSPACE_THEME, WORKSPACE_THEMES, themeOf } from '@cockpit/shared';
import type { CreateWorkspaceCommand, Workspace } from '@cockpit/shared';
import { foldName, namedTheSame } from './names.js';

/**
 * Pure handlers for workspaces (architecture, "Hono + Zod on Cloudflare
 * Workers": domain imports nothing from the other layers).
 */

/**
 * The tints, in the order they are handed out - one per theme, derived rather
 * than written twice, so a theme added to the palette is a color handed out
 * and the two cannot disagree about which colors exist.
 */
export const WORKSPACE_PALETTE = WORKSPACE_THEMES.map((theme) => theme.tint);

/**
 * The first color no live workspace is using, so workspaces are distinguishable
 * for as long as the palette lasts.
 *
 * Past that there is nothing left to be distinct from, and refusing to create
 * a ninth workspace over a color would be absurd, so it wraps. Wrapping on the
 * *count* rather than restarting at the first entry is what keeps two
 * workspaces created one after the other from matching, which is the only part
 * of "distinguishable" still available once every color is spoken for.
 */
export function nextColor(taken: readonly string[]): string {
  const unused = WORKSPACE_PALETTE.find((color) => !taken.includes(color));
  if (unused) return unused;
  // In range by construction. The `??` is there only because a computed index
  // is `| undefined` under noUncheckedIndexedAccess and the checker cannot see
  // that a modulo of the length never leaves the array.
  return (
    WORKSPACE_PALETTE.at(taken.length % WORKSPACE_PALETTE.length) ?? DEFAULT_WORKSPACE_THEME.tint
  );
}

/**
 * Where a workspace made now goes: after every workspace the account has, so it
 * turns up at the right of the tabs rather than in the middle of them ("Reorder
 * workspaces", issue 31). The first workspace of an account starts the count.
 *
 * `highest` is what the account's rows actually hold, deleted ones included, so
 * this never has to reason about a position coming back into use.
 */
export function nextPosition(highest: number | null): number {
  return highest === null ? 0 : highest + 1;
}

/**
 * Whether this is an order of exactly the workspaces the account has: every one
 * of them, once each, and nothing else.
 *
 * The question is asked because the list comes from a page that was painted
 * some time ago, and a workspace can have been made or deleted in another tab
 * since. Ordering that list would then either lose a workspace or give one to a
 * workspace that is not there - so a list that no longer matches is refused and
 * the person is shown the list as it now is ("Reorder workspaces", issue 31).
 *
 * Self-contained rather than leaning on the wire schema's refusal of a repeated
 * id: a function that answers "is this an order of these" has to be true on its
 * own, and counting the distinct ids costs nothing.
 */
export function ordersExactly(live: readonly Workspace[], order: readonly string[]): boolean {
  const named = new Set(order);
  if (named.size !== order.length) return false;
  if (named.size !== live.length) return false;
  return live.every((workspace) => named.has(workspace.id));
}

/**
 * The live workspace already going by this name, or undefined. The scope is
 * every live workspace of the account, which is what makes a workspace name
 * unique across it; `namedTheSame` in names.ts carries the rest.
 */
export function workspaceNamed(
  live: readonly Workspace[],
  name: string,
  except?: string,
): Workspace | undefined {
  return namedTheSame(live, name, except);
}

/**
 * `createdAt` is the client's own timestamp, like every other command, so the
 * order workspaces are listed in is the order they were made in even when a
 * create was queued offline.
 *
 * There was a `slug` here until migration 0006 dropped the column. Nothing
 * ever read it, and uniqueness moved to the name, where a person can see it.
 *
 * The whole theme goes in, not just the tint it was handed: a new workspace has
 * all three of its colors from the moment it exists, so it is never a workspace
 * wearing somebody else's page.
 *
 * `position` arrives the way `color` does, for the same reason: it is a function
 * of every workspace the account already has, and only the server can see that
 * whole set.
 */
export function workspaceFromCommand(
  cmd: CreateWorkspaceCommand,
  tenantId: string,
  color: string,
  position: number,
): Workspace & {
  foldedName: string;
  position: number;
  createdAt: string;
  deletedAt: string | null;
} {
  const theme = themeOf(color);
  return {
    id: cmd.workspaceId,
    tenantId,
    name: cmd.name,
    foldedName: foldName(cmd.name),
    color,
    ground: theme.ground,
    header: theme.header,
    position,
    createdAt: cmd.issuedAt,
    deletedAt: null,
  };
}
