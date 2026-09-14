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

/** Whether a row should say this Item may be saying what another one already said. */
export function mayBeADuplicate(
  itemId: string,
  items: readonly Item[],
  filings: readonly Filing[],
  duplicates: readonly PossibleDuplicate[],
): boolean {
  return possibleDuplicatesOf(itemId, items, filings, duplicates).length > 0;
}
