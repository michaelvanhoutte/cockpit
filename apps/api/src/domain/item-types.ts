import { colorNoTypeIsUsing, type CreateItemTypeCommand, type ItemType } from '@cockpit/shared';
import { foldName } from './names.js';

/**
 * Making a Type ("Capture a thought or an action, and see which it is", issue
 * 155). Pure, like every other handler here: what colour is free and whether
 * the name is taken are both decided from the types handed in.
 */

/**
 * The one of `taken` already going by this name, or undefined.
 *
 * Folded through `foldName` like every other name in the app, which is what
 * makes `Thought` and `thought` the same name - and what makes naming a type
 * you already have reuse it rather than making a second one.
 */
export function itemTypeNamed(
  taken: readonly ItemType[],
  name: string,
): ItemType | undefined {
  const wanted = foldName(name);
  return taken.find((type) => foldName(type.name) === wanted);
}

/**
 * A new Type, given the first colour no live Type is wearing, so it never
 * exists without one and nobody is asked for one to create it.
 */
export function itemTypeFromCommand(
  cmd: CreateItemTypeCommand,
  tenantId: string,
  taken: readonly ItemType[],
): ItemType {
  return {
    id: cmd.typeId,
    tenantId,
    name: cmd.name,
    color: colorNoTypeIsUsing(taken.map((type) => type.color)),
    // After every type there is, so a new one joins the end of the list rather
    // than the front. Deleted types count, for the reason a workspace's
    // position counts them: a number that comes back is one more thing to
    // reason about.
    position: taken.length,
    createdAt: cmd.issuedAt,
  };
}
