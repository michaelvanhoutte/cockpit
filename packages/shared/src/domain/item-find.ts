import type { Item } from './item.js';

/**
 * How *Find item* matches what is typed ("Find an open Item with F and Shift+F,
 * and land on its row", issue 828) - shared so a connected app's `find_items`
 * ("Find items in Cockpit from a connected app, over MCP", issue 1240) matches
 * text exactly as the screen does. Nothing is matched by meaning.
 */

/** The text a search runs over: what a person would type to find the Item. */
export function searchTextOf(item: Pick<Item, 'title' | 'description' | 'nextAction' | 'sender'>): string {
  return [item.title, item.description ?? '', item.nextAction ?? '', item.sender ?? ''].join('\n').toLowerCase();
}

/** What a typed query is searched for as: trimmed and lowercased, or `''` where nothing is typed. */
export function needleOf(query: string): string {
  return query.trim().toLowerCase();
}

/** Whether an Item's search text holds what was typed. Nothing typed matches nothing, as *Find item* shows no rows. */
export function textMatches(item: Pick<Item, 'title' | 'description' | 'nextAction' | 'sender'>, query: string): boolean {
  const needle = needleOf(query);
  return needle !== '' && searchTextOf(item).includes(needle);
}
