import { pairedWith, type Filing, type Item, type PossibleDuplicate } from '@cockpit/shared';
import { itemsInTheInbox, stillOpen } from './filing';

/**
 * Every open Item's id that is filed somewhere ("Flag a duplicate between two
 * cards on dashboards", issue 410) - the complement of `itemsInTheInbox`.
 */
function itemsThatAreFiled(items: readonly Item[], filings: readonly Filing[]): Set<string> {
  const inbox = new Set(itemsInTheInbox(items, filings).map((item) => item.id));
  return new Set(items.filter((item) => stillOpen(item) && !inbox.has(item.id)).map((item) => item.id));
}

/**
 * Which Items an Item may be saying again ("Flag a captured note that says what
 * another one already said", issue 407; extended in issue 410 to include filed
 * Items).
 *
 * **A view over the snapshot, like the Inbox itself** (`itemsInTheInbox`,
 * filing.ts): the wire carries which Items were paired, and whether a pair is
 * *offered* is worked out here, where what is filed is already known.
 *
 * **The rule is not symmetric, and that is the point of it.** An Inbox Item is
 * still waiting to be triaged, so every pair it is in is worth seeing whatever
 * the other half's own state is - filing the other half does not answer the
 * question this row is still asking. A filed Item is a settled one, so it is
 * only worth telling it may repeat another *settled* Item; telling it about
 * something still in the Inbox would be the noise "Flag a captured note that
 * says what another one already said" (issue 407) built this mark to avoid in
 * the first place, on a screen with no triage control to act on it from.
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
  const inbox = new Set(itemsInTheInbox(items, filings).map((item) => item.id));
  const filed = itemsThatAreFiled(items, filings);
  const askerIsInInbox = inbox.has(itemId);
  if (!askerIsInInbox && !filed.has(itemId)) return [];
  const byId = new Map(items.map((item) => [item.id, item]));
  return pairedWith(itemId, duplicates)
    // The other half has to still be open at all - finished with, dismissed,
    // or gone from this snapshot entirely is not a pair to offer, the Inbox
    // side's own "whatever its state is" no more reaches past that than the
    // filed side's "only another filed one" does.
    .filter((id) => (inbox.has(id) || filed.has(id)) && (askerIsInInbox || filed.has(id)))
    .map((id) => byId.get(id))
    .filter((item): item is Item => item !== undefined);
}

/**
 * Which Items a list should mark as possibly saying what another one already
 * said - an Inbox Item marked for any pair it is in, a filed Item marked only
 * where the other half is filed too (`possibleDuplicatesOf`'s own rule, worked
 * out once for the whole list rather than per row).
 */
export function itemsThatMayBeDuplicates(
  items: readonly Item[],
  filings: readonly Filing[],
  duplicates: readonly PossibleDuplicate[],
): Set<string> {
  const inbox = new Set(itemsInTheInbox(items, filings).map((item) => item.id));
  const filed = itemsThatAreFiled(items, filings);
  const flagged = new Set<string>();
  for (const pair of duplicates) {
    const oneOpen = inbox.has(pair.itemId) || filed.has(pair.itemId);
    const otherOpen = inbox.has(pair.otherItemId) || filed.has(pair.otherItemId);
    if (!oneOpen || !otherOpen) continue;
    if (inbox.has(pair.itemId)) flagged.add(pair.itemId);
    if (inbox.has(pair.otherItemId)) flagged.add(pair.otherItemId);
    if (filed.has(pair.itemId) && filed.has(pair.otherItemId)) {
      flagged.add(pair.itemId);
      flagged.add(pair.otherItemId);
    }
  }
  return flagged;
}
