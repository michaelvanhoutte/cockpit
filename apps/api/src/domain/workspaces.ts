import { DEFAULT_WORKSPACE_THEME, WORKSPACE_THEMES, themeOf } from '@cockpit/shared';
import type { CreateWorkspaceCommand, Workspace } from '@cockpit/shared';

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
 * The name with its case folded away, which is what the unique index holds and
 * the only thing that decides whether two workspaces share a name ("Workspace
 * names are only case-insensitive in ASCII", issue 91).
 *
 * Upper-then-lower, not `toLowerCase()` alone, because lowercasing is not case
 * folding: `STRASSE` lowercases to `strasse` while `Straße` stays `straße`, so
 * the two would remain different names. Uppercasing expands `ß` to `SS` first,
 * and the pair folds together. Measured, not assumed - the case table in
 * apps/api/tests/unit/domain/workspaces.test.ts is what pins it.
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
 * There was a `slug` here until migration 0006 dropped the column. Nothing
 * ever read it, and uniqueness moved to the name, where a person can see it.
 *
 * The whole theme goes in, not just the tint it was handed: a new workspace has
 * all three of its colors from the moment it exists, so it is never a workspace
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
    ground: theme.ground,
    header: theme.header,
    createdAt: cmd.issuedAt,
    deletedAt: null,
  };
}
