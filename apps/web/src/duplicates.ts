import { pairedWith, type Filing, type Item, type PossibleDuplicate } from '@cockpit/shared';
import { itemsInTheInbox } from './filing';

/**
 * Which Items an Item may be saying again ("Flag a captured note that says what
 * another one already said", issue 407).
 *
 * **A view over the snapshot, like the Inbox itself** (`itemsInTheInbox`,
 * filing.ts): the wire carries which Items were paired, and whether a pair is
 * *offered* is worked out here, where what is filed is already known.
 *
 * **Until an Item is filed, its duplicates are everything else in the
 * Workspace; a filed Item is nothing's duplicate yet.** Filing is how a person
 * answers the question a note asks, so an Item that has been filed is no longer
 * one of two notes waiting to be told apart - and the note still in the Inbox
 * has nothing left to be warned about. Both halves therefore have to be in the
 * Inbox for either to be marked, which is also what brings the mark back when
 * one is put back.
 *
 * The server has already left out everything a person could no longer act on
 * and everything belonging to another Workspace (`listDuplicatesInWorkspace`,
 * apps/api/src/accounts/repo.ts), so what is left to decide here is filing
 * alone.
 */
export function possibleDuplicatesOf(
  itemId: string,
  items: readonly Item[],
  filings: readonly Filing[],
  duplicates: readonly PossibleDuplicate[],
): Item[] {
  const inbox = new Map(itemsInTheInbox(items, filings).map((item) => [item.id, item]));
  if (!inbox.has(itemId)) return [];
  return pairedWith(itemId, duplicates)
    .map((id) => inbox.get(id))
    .filter((item): item is Item => item !== undefined);
}

/**
 * Which Items a list should mark as possibly saying what another one already
 * said - both halves of every pair the Inbox still holds.
 *
 * A set worked out once for the whole list rather than a question asked per
 * row, because the answer is the same read of the same two arrays either way
 * and a list of a hundred rows would otherwise do it a hundred times.
 */
export function itemsThatMayBeDuplicates(
  items: readonly Item[],
  filings: readonly Filing[],
  duplicates: readonly PossibleDuplicate[],
): Set<string> {
  const inbox = new Set(itemsInTheInbox(items, filings).map((item) => item.id));
  const flagged = new Set<string>();
  for (const pair of duplicates) {
    if (!inbox.has(pair.itemId) || !inbox.has(pair.otherItemId)) continue;
    flagged.add(pair.itemId);
    flagged.add(pair.otherItemId);
  }
  return flagged;
}
