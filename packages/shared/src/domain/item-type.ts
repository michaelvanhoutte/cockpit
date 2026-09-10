import { z } from 'zod';
import { workspaceNameSchema } from './item.js';
import { hexColorSchema, WORKSPACE_THEMES } from './workspace-themes.js';

/**
 * What kind of thing an Item is ("Capture a thought or an action, and see
 * which it is", issue 155). The set is open, not a fixed enum (architecture.md
 * §4.4, "packages/shared: schema and command rationale", for why), and is a
 * separate axis from being done ("An item is either yours to deal with or
 * finished with", issue 154).
 */

/** A Type's name obeys exactly the rules a Workspace's does, by being the same schema. */
export const itemTypeNameSchema = workspaceNameSchema;

/** The colours a Type can wear — the palette's tints and nothing new (architecture.md §4.4). */
export const ITEM_TYPE_COLORS: readonly string[] = WORKSPACE_THEMES.map((theme) => theme.tint);

/** The colour a Type gets when every one in the palette is already taken (architecture.md §4.4 — repeating one is the right failure). */
export const DEFAULT_ITEM_TYPE_COLOR: string = ITEM_TYPE_COLORS[0]!;

/** What a Type change names instead of a workspace — the whole account (architecture.md §4.4). */
export const ACCOUNT_WIDE = 'account';

export const itemTypeSchema = z.object({
  /** Permissive read-back field — the seeded Types predate client-generated ids (architecture.md §4.4). */
  id: z.string(),
  tenantId: z.string(),
  /** Permissive read-back field, for the reason `id` above is (architecture.md §4.4). */
  name: z.string(),
  color: z.string(),
  /** Where this Type sits in the list you put it in ("Manage the types, and put them in the order you want", issue 156). Written by nothing yet; ties break on `createdAt`. */
  position: z.number().int(),
  createdAt: z.iso.datetime(),
});
export type ItemType = z.infer<typeof itemTypeSchema>;

/** Only the palette's colours, refused on the way in the way a theme's are. */
export const itemTypeColorSchema = hexColorSchema.refine(
  (color) => ITEM_TYPE_COLORS.includes(color),
  { message: 'a type wears one of the palette colours' },
);

/** The colour to give a new Type: the first no live Type is wearing. */
export function colorNoTypeIsUsing(taken: readonly string[]): string {
  return ITEM_TYPE_COLORS.find((color) => !taken.includes(color)) ?? DEFAULT_ITEM_TYPE_COLOR;
}
