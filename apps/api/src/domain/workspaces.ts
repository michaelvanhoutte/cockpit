import type { CreateWorkspaceCommand, Workspace } from '@cockpit/shared';
import { foldName, namedTheSame } from './names.js';

/**
 * Pure handlers for workspaces (architecture, "Hono + Zod on Cloudflare
 * Workers": domain imports nothing from the other layers).
 */

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
 * Only the tint is stored: the band, top bar and page grey are the palette's,
 * found by that tint whenever the workspace is read.
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
): Pick<Workspace, 'id' | 'tenantId' | 'name' | 'color'> & {
  foldedName: string;
  position: number;
  createdAt: string;
  deletedAt: string | null;
} {
  return {
    id: cmd.workspaceId,
    tenantId,
    name: cmd.name,
    foldedName: foldName(cmd.name),
    color,
    position,
    createdAt: cmd.issuedAt,
    deletedAt: null,
  };
}
