import type { ToolDefinition } from './create-item.js';

/**
 * The two tools an app connected to Cockpit dismisses an Item with, and
 * brings it back with ("MCP changes and deletes: a connected app cannot remove
 * an Item: add delete_item and restore_item, dismissing as a swipe does", issue
 * 1810): what they are called, what they say they do, and how the one argument
 * is read.
 *
 * **Deleting is dismissing**, the same `set_dismissed` a swipe sends: nothing
 * in the app erases an Item, and restoring is that command with `dismissed:
 * false`, since the app has no list of dismissed Items to bring one back from.
 *
 * Pure, and proved at L1 (tests/unit/mcp/delete-item.test.ts). Whose Item it
 * touches, and what it writes, is the Worker's (`mcp/server.ts`), proved at L2.
 */

export const DELETE_ITEM = 'delete_item';
export const RESTORE_ITEM = 'restore_item';

/** The one argument of both tools, so the model reads it once. */
const ID_ARGUMENT = {
  type: 'string',
  minLength: 1,
  description: 'The id of the item, or the link that opens it, as find_items gives them.',
} as const;

export function deleteItemTool(): ToolDefinition {
  return {
    name: DELETE_ITEM,
    description: [
      "Delete an item from the user's Cockpit. It is dismissed, exactly as a swipe dismisses it: it leaves every list and dashboard, and a Gmail or Outlook conversation it mirrors loses its label or star.",
      'Nothing is erased: restore_item brings it back.',
      'Name the item by the id or the link find_items gives.',
      'Use it when the user asks to delete or remove something in Cockpit.',
    ].join(' '),
    inputSchema: { type: 'object', properties: { id: ID_ARGUMENT }, required: ['id'], additionalProperties: false },
  };
}

export function restoreItemTool(): ToolDefinition {
  return {
    name: RESTORE_ITEM,
    description: [
      'Bring back an item that delete_item dismissed, or that the user dismissed in Cockpit: it returns to where it was.',
      'Name the item by the id delete_item gave, or by a link that opens it.',
      'Use it when the user asks to undo a delete.',
    ].join(' '),
    inputSchema: { type: 'object', properties: { id: ID_ARGUMENT }, required: ['id'], additionalProperties: false },
  };
}

/** What a call's argument comes to: the Item to name, or what to tell the model. */
export type ReadItemId = { ok: true; itemId: string } | { ok: false; refusal: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Said for an id that is neither a uuid nor a link, and by no other refusal. */
const WHAT_TO_PASS = 'id must be the id of an item or the link that opens it, as find_items gives them.';

/**
 * Said for an id no Item of this account has, **the same words whether nobody
 * has it or another account does**, so a refusal cannot tell an app which ids
 * exist elsewhere. The account's own store can see no other account's Items,
 * which is what makes the two the same case (`server.ts`).
 */
export const NO_SUCH_ITEM = 'There is no item with that id. Use the id or the link find_items gives.';

/**
 * Reads the `id` argument: a bare uuid, or the address `find_items` gives in
 * "Open it" (`/w/<workspace>?item=<uuid>`), from which the Item's id is taken.
 * Anything else is refused saying what to pass, rather than guessed at.
 */
export function readItemId(args: unknown): ReadItemId {
  const given = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>;
  if (typeof given.id !== 'string') return { ok: false, refusal: WHAT_TO_PASS };
  const id = given.id.trim();
  if (UUID.test(id)) return { ok: true, itemId: id.toLowerCase() };

  let link: URL;
  try {
    link = new URL(id);
  } catch {
    return { ok: false, refusal: WHAT_TO_PASS };
  }
  const named = link.searchParams.get('item')?.trim() ?? '';
  if ((link.protocol !== 'https:' && link.protocol !== 'http:') || !link.pathname.startsWith('/w/') || !UUID.test(named)) {
    return { ok: false, refusal: WHAT_TO_PASS };
  }
  return { ok: true, itemId: named.toLowerCase() };
}
