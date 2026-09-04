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

/** What capture opens on: the type used last, or the first there is. */
export function typeToOffer(
  types: readonly ItemType[],
  items: readonly Item[],
): ItemType | undefined {
  return typesOffered(types, items)[0];
}

/** The type an item is, or undefined - which a row draws as having none. */
export function typeOf(types: readonly ItemType[], item: Item): ItemType | undefined {
  return item.typeId ? types.find((type) => type.id === item.typeId) : undefined;
}

/**
 * The type going by this name, ignoring case and surrounding blanks - the same
 * question the server answers before making one, asked here so that naming a
 * type you already have reuses it without a round trip inventing a second id.
 *
 * `toUpperCase().toLowerCase()` rather than lowercasing alone, matching
 * `foldName` on the server: lowercasing is not case folding, and `Straße` and
 * `STRASSE` have to be one name in both places or the two disagree about what
 * "already there" means.
 */
export function typeNamed(types: readonly ItemType[], name: string): ItemType | undefined {
  const wanted = name.trim().toUpperCase().toLowerCase();
  return types.find((type) => type.name.trim().toUpperCase().toLowerCase() === wanted);
}
