import { TITLE_LENGTH, UNTITLED, itemStatus, type Item } from '@cockpit/shared';
import { STATUS_LABELS } from './allItems';

/**
 * Splitting part of an Item's description off into an Item of its own: select
 * text in the description, right-click (a long press on Android) and *Split
 * this off*. The selection becomes a new Item, and in the original is replaced
 * by a link reading *Split off to: <new item>*. The two are linked both ways by
 * the new Item's `splitFromItemId`, and by nothing else: no hierarchy, no
 * roll-up.
 */

/** What the link left in the original's description says, before the new Item's name. */
export const SPLIT_OFF_TO = 'Split off to:';

/**
 * The new Item's title: the first line of the selection with its Markdown
 * marks taken off, cut to a title's length. The whole selection is its
 * description, so nothing cut here is lost.
 */
export function splitOffTitle(markdown: string): string {
  const firstLine =
    markdown
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? '';
  const plain = firstLine
    // A list's bullet or number, a heading's hashes, a quote's marker, a task's box.
    .replace(/^(?:[-*+](?:\s+|$)|\d+[.)](?:\s+|$)|#{1,6}(?:\s+|$)|>\s*)+/, '')
    .replace(/^\[[ xX]\]\s+/, '')
    // A link reads as its text; emphasis and code as what they wrap.
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|\*|_|~~|`)(.+?)\1/g, '$2')
    .replace(/\s+/g, ' ')
    .trim();
  const title = plain.length > TITLE_LENGTH ? `${plain.slice(0, TITLE_LENGTH - 1).trimEnd()}…` : plain;
  return title || UNTITLED;
}

/** The link's text in the original: `Split off to: <title>`. */
export function splitOffLinkText(title: string): string {
  return `${SPLIT_OFF_TO} ${title}`;
}

/**
 * The Item a description's link points at, where it is a link to an Item of
 * this Cockpit (`itemLink`, itemLink.ts), and null for any other address.
 */
export function linkedItemId(href: string, origin: string): string | null {
  let url: URL;
  try {
    url = new URL(href, origin);
  } catch {
    return null;
  }
  if (url.origin !== origin || !/^\/w\/[^/]+\/?$/.test(url.pathname)) return null;
  return url.searchParams.get('item');
}

/** What the mark beside an Item's link says: its status, or nothing for an Item this read does not hold. */
export function linkedItemStatus(items: readonly Item[], itemId: string): string | null {
  const linked = items.find((item) => item.id === itemId);
  if (!linked || linked.deletedAt) return null;
  return STATUS_LABELS[itemStatus(linked)];
}

export interface SplitRelations {
  /** The Item this one was split off from, where the read holds it. */
  from: Item | null;
  /** The Items split off this one, oldest first. */
  off: Item[];
}

/** Both directions of the split link for one Item, read off the Workspace's Items. */
export function splitRelations(item: Pick<Item, 'id' | 'splitFromItemId'>, items: readonly Item[]): SplitRelations {
  const from = item.splitFromItemId
    ? (items.find((other) => other.id === item.splitFromItemId && !other.deletedAt) ?? null)
    : null;
  const off = items
    .filter((other) => other.splitFromItemId === item.id && !other.deletedAt)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return { from, off };
}
