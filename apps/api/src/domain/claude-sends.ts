import { runBlocksAStart } from '@cockpit/shared';
import type { AgentRun, Item } from '@cockpit/shared';
import { couldStillBeActedOn } from './duplicates.js';

/**
 * Whether an Item may be sent to Cowork or Claude Code ("Send an item to
 * Cowork or Claude Code with its prompt reviewed first", issue 1159). Pure,
 * like the rest here: the Item and its open Run are handed in.
 *
 * Nothing needs a connection, a Dashboard or a filing - the Inbox's Items are
 * sent like any other, and the window warns about a missing MCP connection
 * rather than the command refusing it.
 */
export type ClaudeSendRefusal =
  | { refusal: 'item-not-to-be-done' }
  | { refusal: 'claude-already-on-item' };

export function decideClaudeSend(facts: {
  item: Pick<Item, 'completedAt' | 'deletedAt'>;
  openRun: Pick<AgentRun, 'status'> | undefined;
}): ClaudeSendRefusal | { refusal: null } {
  if (!couldStillBeActedOn(facts.item) || facts.item.completedAt !== null) {
    return { refusal: 'item-not-to-be-done' };
  }
  if (runBlocksAStart(facts.openRun)) return { refusal: 'claude-already-on-item' };
  return { refusal: null };
}
