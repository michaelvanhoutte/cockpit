import { z } from 'zod';
import { workspaceNameSchema } from './item.js';
import { hexColorSchema, WORKSPACE_THEMES } from './workspace-themes.js';

/**
 * What kind of thing an Item is ("Capture a thought or an action, and see which
 * it is", issue 155). The Glossary has said since it was written that *Action*
 * and *Thought* are types of Item rather than separate objects; this is the
 * model catching up.
 *
 * **The set is open, and that is the cheaper of the two.** A fixed enum would
 * want a CHECK on `items`, and a CHECK cannot be altered into a table that has
 * children under RESTRICT (architecture, "Schema conventions") - so a closed set
 * costs rebuilding three tables while an open one is a table of its own and a
 * nullable column pointing at it. The set is also not knowable: *question*,
 * *decision* and *reference* are all plausible next entries, and each would
 * otherwise be a migration.
 *
 * **A Type says what an Item is; being done says where it stands.** They are
 * separate axes, which is what the eight-value status could not manage - a
 * thought could not be a task, and *task* was a type wearing a status's hat
 * ("An item is either yours to deal with or finished with", issue 154).
 */

/**
 * A Type's name obeys exactly the rules a Workspace's does, by being the same
 * schema rather than a copy of it: required, trimmed, single-line, at most 60
 * characters. What differs is only the scope uniqueness is decided in - the
 * account rather than one workspace - and that is not a shape, so it is not
 * here.
 */
export const itemTypeNameSchema = workspaceNameSchema;

/**
 * The colours a Type can wear, which are the palette's tints and nothing new.
 *
 * One palette rather than two: the tints were designed together and checked for
 * legibility together (workspace-themes.ts), and a second list would be a second
 * thing to keep legible. A Type wears only the saturated one - the dot at the
 * head of a row - because a Type tints a mark, not a surface.
 */
export const ITEM_TYPE_COLORS: readonly string[] = WORKSPACE_THEMES.map((theme) => theme.tint);

/**
 * The colour a Type gets when every one in the palette is already taken.
 *
 * Repeating a colour is the right failure: two types sharing a dot is one pair
 * you have to read the word to tell apart, while refusing to create a type
 * because the palette ran out would stop you saying what a thing is over a
 * decoration. The name is what carries the meaning; the colour is what makes a
 * list scannable.
 */
export const DEFAULT_ITEM_TYPE_COLOR: string = ITEM_TYPE_COLORS[0]!;

/**
 * The two the Glossary already names, given to every account so that nothing
 * starts with an empty picker and the first capture has something to be.
 */
export const STARTING_ITEM_TYPES: readonly string[] = ['Action', 'Thought'];

export const itemTypeSchema = z.object({
  /**
   * The permissive `z.string()` rather than a uuid, for the reason a
   * Dashboard's id is permissive: the *Action* and *Thought* every account
   * starts with have ids derived from the account's own, so they are not uuids
   * and never were.
   */
  id: z.string(),
  tenantId: z.string(),
  /**
   * Deliberately the permissive `z.string()` and not `itemTypeNameSchema`, for
   * the reason a Workspace's name is permissive: this is the shape read back,
   * and a stored name that predates the rules should still render rather than
   * blanking the screen it appears on. The rules belong on the way in.
   */
  name: z.string(),
  color: z.string(),
  /**
   * Where this Type sits in the list you put it in ("Manage the types, and put
   * them in the order you want", issue 156). Written by nothing yet; every read
   * breaks a tie on `createdAt`, so the order is total whatever is in it.
   */
  position: z.number().int(),
  createdAt: z.iso.datetime(),
});
export type ItemType = z.infer<typeof itemTypeSchema>;

/** Only the palette's colours, refused on the way in the way a theme's are. */
export const itemTypeColorSchema = hexColorSchema.refine(
  (color) => ITEM_TYPE_COLORS.includes(color),
  { message: 'a type wears one of the palette colours' },
);

/**
 * The colour to give a new Type: the first no live Type is wearing, so a Type
 * never exists without one and nobody is asked for one to create it. The shape
 * open decision #13 settled for Workspace colours, applied one level down.
 */
export function colorNoTypeIsUsing(taken: readonly string[]): string {
  return ITEM_TYPE_COLORS.find((color) => !taken.includes(color)) ?? DEFAULT_ITEM_TYPE_COLOR;
}
