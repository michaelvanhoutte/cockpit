import { REWRITE_HISTORY_LIMIT, type RefinementScope, type RewriteHistoryEntry } from '@cockpit/shared';

/**
 * What Cockpit changed on an item, and which of it the person has already seen
 * ("Show what Cockpit changed on the item itself, and name it for what it is",
 * issue 690).
 *
 * **Everything the item's form decides before its history's code has loaded**,
 * so this is in the initial bundle and the list and the before-and-after it
 * opens to are not (`components/WhatCockpitChangedList.tsx`). Pure, and handed
 * storage rather than reaching for it, so the deciding is provable without a
 * browser and a private window is a form with no note rather than one that
 * throws.
 */

export type ChangedField = 'title' | 'description' | 'suggestedPanel';

/** Which fields a refinement looks at; a row from before that was recorded is read as having looked at all three. */
export const LOOKS_AT: Record<RefinementScope, ChangedField[]> = {
  'texts-and-panel': ['title', 'description', 'suggestedPanel'],
  texts: ['title', 'description'],
  panel: ['suggestedPanel'],
};

export function fieldsLookedAt(entry: RewriteHistoryEntry): ChangedField[] {
  return LOOKS_AT[entry.looksAt ?? 'texts-and-panel'];
}

/** Whether one field of an attempt differs from what it started as. */
export function fieldChanged(entry: RewriteHistoryEntry, field: ChangedField): boolean {
  if (field === 'suggestedPanel') {
    // A row from before this was recorded never recorded the panel.
    if (entry.looksAt === null) return false;
    return (entry.suggestedPanelBefore?.id ?? null) !== (entry.suggestedPanelAfter?.id ?? null);
  }
  const before = field === 'title' ? entry.titleBefore : entry.descriptionBefore;
  const after = field === 'title' ? entry.titleAfter : entry.descriptionAfter;
  return after !== null && after !== (before ?? '');
}

/** The fields a settled attempt changed, in the order the list shows them. */
export function changedFields(entry: RewriteHistoryEntry): ChangedField[] {
  if (entry.status !== 'rewritten') return [];
  return fieldsLookedAt(entry).filter((field) => fieldChanged(entry, field));
}

/**
 * The times Cockpit changed something, newest first: a time it looked and left
 * things as they were, one still working and one that failed are noise on a form.
 */
export function changesOn(entries: readonly RewriteHistoryEntry[]): RewriteHistoryEntry[] {
  return entries
    .filter((entry) => changedFields(entry).length > 0)
    .sort((a, b) => b.attemptedAt.localeCompare(a.attemptedAt));
}

export type TextField = 'title' | 'description';

/** The newest change that touched a text, which is what the note is about and what seeing it is recorded against. */
export function latestTextChange(entries: readonly RewriteHistoryEntry[]): {
  id: string;
  fields: TextField[];
} | null {
  for (const entry of changesOn(entries)) {
    const fields = changedFields(entry).filter((field): field is TextField => field !== 'suggestedPanel');
    if (fields.length > 0) return { id: entry.id, fields };
  }
  return null;
}

/**
 * The note under the tabs: that Cockpit changed the title or description, until
 * the person has seen or edited it. Naming only what it changed; a change to the
 * suggested panel alone gives none, and a later change brings it back because it
 * is a different change.
 */
export function noteFor(
  entries: readonly RewriteHistoryEntry[],
  seenChangeId: string | null,
): { changeId: string; words: string } | null {
  const latest = latestTextChange(entries);
  if (!latest || latest.id === seenChangeId) return null;
  return { changeId: latest.id, words: `Cockpit changed the ${latest.fields.join(' and ')}` };
}

/** One item and the change of it that was seen, oldest item first. */
type Seen = [itemId: string, changeId: string][];

/** As many items as the account's own history reads back, so what is remembered is never more than there is to show. */
export const SEEN_CHANGES_KEPT = REWRITE_HISTORY_LIMIT;

const KEY = 'cockpit.seen-changes';

/** The list with this item at its end, once, capped by dropping the oldest. */
export function withSeen(seen: Seen, itemId: string, changeId: string): Seen {
  return [...seen.filter(([id]) => id !== itemId), [itemId, changeId] as [string, string]].slice(-SEEN_CHANGES_KEPT);
}

function readSeen(store: Storage | undefined): Seen {
  try {
    const held: unknown = JSON.parse(store?.getItem(KEY) ?? '[]');
    if (!Array.isArray(held)) return [];
    return held.filter(
      (pair): pair is [string, string] =>
        Array.isArray(pair) && pair.length === 2 && typeof pair[0] === 'string' && typeof pair[1] === 'string',
    );
  } catch {
    return [];
  }
}

/** The change of this item that was last seen here, if any. Anything unreadable answers "none". */
export function seenChangeIn(store: Storage | undefined, itemId: string): string | null {
  return readSeen(store).find(([id]) => id === itemId)?.[1] ?? null;
}

export function rememberSeenChange(store: Storage | undefined, itemId: string, changeId: string): void {
  try {
    store?.setItem(KEY, JSON.stringify(withSeen(readSeen(store), itemId, changeId)));
  } catch {
    // Seeing it again is a smaller thing than failing to open a form.
  }
}

/** Called from `session/forget.ts`: what someone has seen is theirs, and the next person to sign in here has seen none of it. */
export function forgetEverySeenChange(store: Storage | undefined): void {
  try {
    store?.removeItem(KEY);
  } catch {
    // A browser that refuses storage remembered nothing to forget.
  }
}
