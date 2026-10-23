import {
  pairedWith,
  plainWords,
  type Filing,
  type Item,
  type PossibleDuplicate,
  itemsInTheInbox,
  itemsThatAreFiled,
} from '@cockpit/shared';

/**
 * Whether an id is still open at all - in the Inbox or filed - which is the
 * one thing every eligible partner has to be, whichever side is asking.
 */
function isOpen(id: string, inbox: ReadonlySet<string>, filed: ReadonlySet<string>): boolean {
  return inbox.has(id) || filed.has(id);
}

/**
 * Whether `partnerId` is a duplicate worth telling `subjectId` about - the one
 * asymmetric rule both functions below draw from, so the mark a row shows and
 * what "Not a duplicate" actually settles can never disagree ("Flag a
 * duplicate between two cards on dashboards", issue 410).
 *
 * An Inbox subject is still waiting to be triaged, so any open partner is
 * worth it, whatever the partner's own state is. A filed subject has
 * settled onto a Panel, so it is only worth telling it about another
 * *filed* partner - telling it about something still in the Inbox would be
 * the noise this mark was built to avoid, on a screen with no triage control
 * to act on it from.
 */
function eligiblePartner(
  subjectId: string,
  partnerId: string,
  inbox: ReadonlySet<string>,
  filed: ReadonlySet<string>,
): boolean {
  if (!isOpen(subjectId, inbox, filed)) return false;
  return inbox.has(subjectId) ? isOpen(partnerId, inbox, filed) : filed.has(partnerId);
}

/**
 * Which Items an Item may be saying again ("Flag a captured note that says
 * another one already said", issue 407; extended in issue 410 to include
 * filed Items).
 *
 * **A view over the snapshot, like the Inbox itself** (`itemsInTheInbox`,
 * `packages/shared/src/domain/filing.ts`): the wire carries which Items were paired, and whether a pair is
 * *offered* is worked out here, where what is filed is already known.
 *
 * The server has already left out everything a person could no longer act on
 * and everything belonging to another Workspace (`listDuplicatesInWorkspace`,
 * apps/api/src/accounts/repo.ts), so what is left to decide here is filing
 * alone - `eligiblePartner` above draws the rule, once.
 */
export function possibleDuplicatesOf(
  itemId: string,
  items: readonly Item[],
  filings: readonly Filing[],
  duplicates: readonly PossibleDuplicate[],
): Item[] {
  const inbox = new Set(itemsInTheInbox(items, filings).map((item) => item.id));
  const filed = new Set(itemsThatAreFiled(items, filings).map((item) => item.id));
  if (!isOpen(itemId, inbox, filed)) return [];
  const byId = new Map(items.map((item) => [item.id, item]));
  return pairedWith(itemId, duplicates)
    .filter((id) => eligiblePartner(itemId, id, inbox, filed))
    .map((id) => byId.get(id))
    .filter((item): item is Item => item !== undefined);
}

/**
 * Which Items a list should mark as possibly saying what another one already
 * said - each side of a pair judged by `eligiblePartner`, the same rule
 * `possibleDuplicatesOf` draws from, worked out once for the whole list
 * rather than per row.
 */
export function itemsThatMayBeDuplicates(
  items: readonly Item[],
  filings: readonly Filing[],
  duplicates: readonly PossibleDuplicate[],
): Set<string> {
  const inbox = new Set(itemsInTheInbox(items, filings).map((item) => item.id));
  const filed = new Set(itemsThatAreFiled(items, filings).map((item) => item.id));
  const flagged = new Set<string>();
  for (const pair of duplicates) {
    if (eligiblePartner(pair.itemId, pair.otherItemId, inbox, filed)) flagged.add(pair.itemId);
    if (eligiblePartner(pair.otherItemId, pair.itemId, inbox, filed)) flagged.add(pair.otherItemId);
  }
  return flagged;
}

/**
 * The first line of a description that has any words, without the Markdown
 * around them, or null where there are none: what tells two notes with one
 * title apart on a duplicate warning's cards ("Choose which of two possible
 * duplicates to keep, from the warning", issue 1451). A line of nothing but an
 * image or a rule is passed over for the next.
 */
export function firstLineOf(description: string | null | undefined): string | null {
  for (const line of (description ?? '').split(/\r\n|[\n\r]/u)) {
    const words = plainWords(line);
    if (words !== '') return words;
  }
  return null;
}

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['day', 86_400_000],
  ['hour', 3_600_000],
  ['minute', 60_000],
];

/** When a note was captured, in the words a warning has room for: *3 days ago*, *2 hours ago*, *just now*. */
export function whenCaptured(createdAt: string, now: number): string {
  const elapsed = now - Date.parse(createdAt);
  const format = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  for (const [unit, length] of UNITS) {
    if (elapsed >= length) return format.format(-Math.floor(elapsed / length), unit);
  }
  return 'just now';
}
