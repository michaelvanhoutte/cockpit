import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Item } from '@cockpit/shared';
import { rewriteHistoryForItemQuery } from './api/queries';
import { changesOn, latestTextChange, noteFor, rememberSeenChange, seenChangeIn } from './cockpitChanges';
import { browserStore } from './lastVisited';

/**
 * What Cockpit changed on one item, for its form: the times it did, the note
 * under the tabs and what has been seen ("Show what Cockpit changed on the item
 * itself, and name it for what it is", issue 690).
 *
 * **Read when the form opens, behind the paint, and again whenever the item
 * changes.** The live update refreshes the snapshot and not the history, and a
 * rewrite that lands while the form is open changes the item, so that is the
 * trigger rather than a push of its own. A failed read is the tab's to show,
 * with a retry; the note is simply absent.
 */
export function useCockpitChanges(itemId: string, item: Item | undefined) {
  const history = useQuery(rewriteHistoryForItemQuery(itemId));
  const { refetch } = history;

  const changed = item
    ? `${item.updatedAt}|${item.title}|${item.description ?? ''}|${item.proposedPanelId ?? ''}`
    : null;
  const read = useRef<string | null>(null);
  useEffect(() => {
    if (changed === null) return;
    // The first look at the item is the read that opened the form.
    if (read.current !== null && read.current !== changed) void refetch();
    read.current = changed;
  }, [changed, refetch]);

  const entries = history.data?.entries;
  const changes = useMemo(() => changesOn(entries ?? []), [entries]);

  /** Bumped when something is seen, so the form is drawn again and reads the store afresh. */
  const [, setSeenAt] = useState(0);
  // Read at each render: a short list, and the store is the one place it is true.
  const seen = seenChangeIn(browserStore(), itemId);
  const note = useMemo(() => noteFor(entries ?? [], seen), [entries, seen]);

  const latest = useMemo(() => latestTextChange(entries ?? []), [entries]);
  /** Records the newest change to a text as seen, for whatever the person did that answers it: opened the tab, or saved a text. */
  const markSeen = useCallback(() => {
    if (!latest) return;
    rememberSeenChange(browserStore(), itemId, latest.id);
    setSeenAt((was) => was + 1);
  }, [itemId, latest]);

  return {
    changes,
    note,
    markSeen,
    error: history.error,
    loading: history.data === undefined && history.error === null,
    retry: () => void refetch(),
  };
}
