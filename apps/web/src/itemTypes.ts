import type { Item, ItemType } from '@cockpit/shared';

/**
 * Which types capture offers, and in what order ("Capture a thought or an
 * action, and see which it is", issue 155).
 *
 * **Derived from the snapshot rather than remembered in the browser**, which is
 * the opposite of what `recentPanels.ts` does and for a stated reason: which
 * panel you last filed into on a phone is genuinely not the one you were filing
 * into at a desk, while *what kind of thing you have been writing down* is the
 * same wherever you write it. It is also already in the data - every item
 * carries its type and when it was made - so remembering it separately would be
 * a second copy that can disagree with the first.
 */

/**
 * Three, the same number the Move to… picker puts above the tree, and for the
 * same reason: the type you want is one of the two or three you have been
 * using, and a longer list is a second thing to read rather than a shortcut
 * past reading.
 */
export const RECENT_TYPES_KEPT = 3;

/**
 * The types you used last, most recent first, at most `RECENT_TYPES_KEPT`.
 *
 * Items arrive oldest first, so this walks them backwards. A type an item names
 * that no longer exists is skipped rather than left as a hole - a deleted type
 * is not a recent one.
 */
export function recentlyUsedTypes(
  types: readonly ItemType[],
  items: readonly Item[],
): ItemType[] {
  const recent: ItemType[] = [];
  for (let i = items.length - 1; i >= 0 && recent.length < RECENT_TYPES_KEPT; i -= 1) {
    const id = items[i]!.typeId;
    if (!id || recent.some((type) => type.id === id)) continue;
    const type = types.find((candidate) => candidate.id === id);
    if (type) recent.push(type);
  }
  return recent;
}

/**
 * Every type, the ones used last at the head and the rest in the order they
 * were put in. No duplicates: a recent type is not offered twice.
 */
export function typesOffered(types: readonly ItemType[], items: readonly Item[]): ItemType[] {
  const recent = recentlyUsedTypes(types, items);
  return [...recent, ...types.filter((type) => !recent.some((used) => used.id === type.id))];
}

/**
 * What a capture surface says where the account has no types at all, which is
 * reachable by deleting every one of them. Said the same way by both front
 * doors - the Capture page's chip row and the Inbox's own row - because they
 * refuse the same capture for the same reason, and it names the one window that
 * gets you out of it.
 */
export const NO_TYPES = 'No types yet — make one in Settings → Manage types.';

/** The type an item is, or undefined - which a row draws as having none. */
export function typeOf(types: readonly ItemType[], item: Item): ItemType | undefined {
  return item.typeId ? types.find((type) => type.id === item.typeId) : undefined;
}
