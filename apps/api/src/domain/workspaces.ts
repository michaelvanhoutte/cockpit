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
 * all four of its colors from the moment it exists, so it is never a workspace
 * wearing somebody else's page.
 */
export function workspaceFromCommand(
  cmd: CreateWorkspaceCommand,
  tenantId: string,
  color: string,
): Workspace & {
  foldedName: string;
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
    bar: theme.bar,
    ground: theme.ground,
    header: theme.header,
    createdAt: cmd.issuedAt,
    deletedAt: null,
  };
}
