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
  lastPosition: number | null,
): ItemType {
  return {
    id: cmd.typeId,
    tenantId,
    name: cmd.name,
    color: colorNoTypeIsUsing(taken.map((type) => type.color)),
    /**
     * After every type there has ever been, so a new one joins the end of the
     * list rather than the front.
     *
     * **The highest position, not how many types are live**, which is the same
     * distinction `lastWorkspacePosition` carries: deleting the three types at
     * positions 0, 1 and 2 leaves one survivor at 3, and counting the live ones
     * would put the next new type at 1 - in front of it, at the head of a list
     * it was meant to join the end of.
     */
    position: lastPosition === null ? 0 : lastPosition + 1,
    createdAt: cmd.issuedAt,
  };
}

/**
 * Whether this list is exactly the account's live types, in some order.
 *
 * The same check `ordersExactly` makes for workspaces, and for the same reason:
 * an order naming types the account no longer has is not a smaller change, it
 * is one made against a list somebody else has moved on from.
 */
export function ordersTypesExactly(
  live: readonly ItemType[],
  order: readonly string[],
): boolean {
  const named = new Set(order);
  if (named.size !== order.length) return false;
  if (named.size !== live.length) return false;
  return live.every((type) => named.has(type.id));
}
