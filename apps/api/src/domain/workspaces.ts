import type { CreateWorkspaceCommand, Workspace } from '@cockpit/shared';

/**
 * Pure handlers for workspaces (architecture, "Hono + Zod on Cloudflare
 * Workers": domain imports nothing from the other layers).
 */

/**
 * The colors a workspace can be handed, in the order they are handed out.
 *
 * The first three are the prototype's own workspace tints (`poc/prototype/
 * app.js`), so the seeded Work, Atlas Copco and Personal keep the identity
 * they have always had; the rest continue the same saturation and lightness at
 * hues far enough apart to tell apart in a row of tabs.
 *
 * Nobody is asked to pick one. Picking is "Choose a workspace's colors from a
 * palette" (issue 79), which also replaces this single tint with the three
 * colors the prototype actually themes a page with.
 */
export const WORKSPACE_PALETTE = [
  '#6f62b5', // violet
  '#3a72c8', // blue
  '#c06a45', // terracotta
  '#3f8f78', // teal
  '#a8548c', // magenta
  '#b58a2f', // amber
  '#4f8fa8', // cyan
  '#7d8f3f', // olive
] as const;

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
  return WORKSPACE_PALETTE.at(taken.length % WORKSPACE_PALETTE.length) ?? WORKSPACE_PALETTE[0];
}

/**
 * The name with its case folded away, which is what the unique index holds and
 * the only thing that decides whether two workspaces share a name ("Workspace
 * names are only case-insensitive in ASCII", issue 91).
 *
 * Upper-then-lower, not `toLowerCase()` alone, because lowercasing is not case
 * folding: `STRASSE` lowercases to `strasse` while `Straße` stays `straße`, so
 * the two would remain different names. Uppercasing expands `ß` to `SS` first,
 * and the pair folds together. Measured, not assumed - the case table in
 * apps/api/tests/integration/http/workspace-management.test.ts is what pins it.
 *
 * Locale-independent on purpose: `toLocaleLowerCase()` would fold `I` by
 * whatever locale the Worker happens to run under, so the same two names could
 * be the same name in one deployment and not in another.
 *
 * What it deliberately does not do is normalize Unicode composition, so `é` as
 * one code point and `e` plus a combining accent still count as two names.
 * That is a real second way two names can look identical; it needs its own
 * decision about which normal form, and folding case is the half that bites.
 *
 * Dashboards get the same rule when "Add and switch dashboards" (issue 32)
 * lands, and share this function rather than growing a second one.
 */
export function foldName(name: string): string {
  return name.trim().toUpperCase().toLowerCase();
}

/**
 * The live workspace already going by this name, or undefined.
 *
 * **One function, both writers.** Creating a workspace and renaming one are
 * the two places a name is given, and they answer "is it taken?" here rather
 * than each folding and comparing for itself - which is what stops them
 * drifting apart. The unique index is the lock behind this, refusing what a
 * race gets past.
 *
 * It folds the names on the way past rather than reading `folded_name`,
 * because a row can hold a name whose folded copy is missing or stale: the
 * code serving requests during the deploy that introduced the column wrote no
 * folded name, and migration 0005's backfill could only fold the ASCII part of
 * what it found.
 *
 * `except` is the workspace doing the asking, and it is what makes renaming
 * `Personal` to `PERSONAL` work. The only row the new name folds onto is the
 * workspace itself, and a plain "is this name taken?" finds that row and
 * refuses a rename that collides with nothing.
 */
export function workspaceNamed(
  live: readonly Workspace[],
  name: string,
  except?: string,
): Workspace | undefined {
  const folded = foldName(name);
  return live.find((w) => w.id !== except && foldName(w.name) === folded);
}

/**
 * `createdAt` is the client's own timestamp, like every other command, so the
 * order workspaces are listed in is the order they were made in even when a
 * create was queued offline.
 *
 * `slug` is written and read by nothing. It is `NOT NULL` until "Drop the
 * unused workspace slug column" (issue 78) removes it, and the id is what goes
 * in: unique by construction, so it needs no rule of its own and none of the
 * disambiguating logic a name-derived slug would need for a column no longer
 * used for anything.
 */
export function workspaceFromCommand(
  cmd: CreateWorkspaceCommand,
  tenantId: string,
  color: string,
): Workspace & {
  foldedName: string;
  slug: string;
  createdAt: string;
  deletedAt: string | null;
} {
  return {
    id: cmd.workspaceId,
    tenantId,
    name: cmd.name,
    foldedName: foldName(cmd.name),
    slug: cmd.workspaceId,
    color,
    createdAt: cmd.issuedAt,
    deletedAt: null,
  };
}
