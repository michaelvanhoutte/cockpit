import { connectorNamed, type Item } from '@cockpit/shared';

/**
 * Where an Item can be opened at its source ("Open an Item at its source",
 * issue 487): the source's own name and the link back to the original.
 *
 * Null for an Item with no way back - an internal one, or one whose source
 * never gave a link - so every surface asks this one place rather than each
 * deciding for itself what "has a source link" means.
 *
 * **Only a web address is ever a link.** The stored field is any URL the schema
 * parses, `javascript:` and `data:` included, and this is the first place it is
 * put in an `href`; a connector that let one through would otherwise run script
 * in this page from a click on a row.
 */
export function openableAtSource(item: Item): { name: string; link: string } | null {
  if (item.source === 'internal' || !item.sourceLink) return null;
  if (!/^https?:\/\//i.test(item.sourceLink)) return null;
  return { name: connectorNamed(item.source), link: item.sourceLink };
}
