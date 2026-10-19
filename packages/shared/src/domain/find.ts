import type { Item } from './item.js';

/**
 * How a typed search finds an Item ("Find an open Item with F and Shift+F, and
 * land on its row", issue 828): in its title, description, next action or
 * sender, ignoring case. Nothing is matched by meaning.
 *
 * **Shared by Find item and by the MCP `find_items` tool**, so an app asking
 * "is this captured already?" finds what the person would find by typing it.
 */

/** The text a search runs over: what a person would type to find the Item. */
export function searchTextOf(item: Pick<Item, 'title' | 'description' | 'nextAction' | 'sender'>): string {
  return [item.title, item.description ?? '', item.nextAction ?? '', item.sender ?? ''].join('\n').toLowerCase();
}

/** What a typed search looks for: trimmed and lowercased, and empty where nothing was typed. */
export function findNeedle(query: string): string {
  return query.trim().toLowerCase();
}

/** Whether a search text (`searchTextOf`) holds what was typed (`findNeedle`). Nothing typed matches nothing. */
export function textMatches(searchText: string, needle: string): boolean {
  return needle !== '' && searchText.includes(needle);
}
