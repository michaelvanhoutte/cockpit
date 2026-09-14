import { pairedWith, type Filing, type Item, type PossibleDuplicate } from '@cockpit/shared';
import { itemsInTheInbox, stillOpen } from './filing';

/**
 * Every open Item's id, split into the two groups a pair can be drawn within
 * ("Flag a duplicate between two cards on dashboards", issue 410): still in
 * the Inbox, or filed somewhere. A pair is only ever drawn between two ids in
 * the *same* group - the Inbox group is unchanged from issue 407, and the
 * filed group is what this issue adds.
 */
function eligibilityGroups(
  items: readonly Item[],
  filings: readonly Filing[],
): { inbox: Set<string>; filed: Set<string> } {
  const inbox = new Set(itemsInTheInbox(items, filings).map((item) => item.id));
  const filed = new Set(
    items.filter((item) => stillOpen(item) && !inbox.has(item.id)).map((item) => item.id),
  );
  return { inbox, filed };
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
 * **A pair is only drawn between Items in the same group** - Inbox-to-Inbox or
 * filed-to-filed, never Inbox-to-filed. This prevents a Dashboard from filling
 * with marks about notes nobody has triaged yet.
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
  const { inbox, filed } = eligibilityGroups(items, filings);
  const group = inbox.has(itemId) ? inbox : filed.has(itemId) ? filed : null;
  if (!group) return [];
  const byId = new Map(items.map((item) => [item.id, item]));
  return pairedWith(itemId, duplicates)
    .filter((id) => group.has(id))
    .map((id) => byId.get(id))
    .filter((item): item is Item => item !== undefined);
}

/**
 * Which Items a list should mark as possibly saying what another one already
 * said - pairs where both Items are in the same group (both Inbox or both
 * filed).
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
  const { inbox, filed } = eligibilityGroups(items, filings);
  const flagged = new Set<string>();
  for (const pair of duplicates) {
    const bothInbox = inbox.has(pair.itemId) && inbox.has(pair.otherItemId);
    const bothFiled = filed.has(pair.itemId) && filed.has(pair.otherItemId);
    if (!bothInbox && !bothFiled) continue;
    flagged.add(pair.itemId);
    flagged.add(pair.otherItemId);
  }
  return flagged;
}
