import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { RewriteHistoryEntry } from '@cockpit/shared';
import { rewriteHistoryForItemQuery } from '../api/queries';
import { LoadFailure } from './LoadFailure';
import { FieldLines, WHY, changedFields, whatHappened } from './SmartRefinementsWindow';

/**
 * POC: a rewrite for the walk, which a local environment cannot produce (no
 * Anthropic key). On by default; off with `localStorage['poc.fakeRewrite'] = '0'`.
 */
function fakeEntry(itemId: string): RewriteHistoryEntry {
  return {
    id: `fake-${itemId}`,
    itemId,
    titleBefore: 'q4 plan thing',
    titleAfter: 'Draft the Q4 plan',
    descriptionBefore: null,
    descriptionAfter: 'Outline the Q4 priorities and send them to the team.',
    proposedPanelName: null,
    status: 'rewritten',
    message: null,
    attemptedAt: new Date(Date.now() - 3 * 3_600_000).toISOString(),
    looksAt: 'texts-and-panel',
    suggestedPanelBefore: null,
    suggestedPanelAfter: { id: 'fake-panel', name: 'Panel 1', dashboardName: 'Dashboard 1' } as never,
  };
}

/** POC: only the times Cockpit actually changed something - a row saying it did nothing is noise on a form. */
export function useCockpitChanges(itemId: string) {
  const { data, error, refetch } = useQuery(rewriteHistoryForItemQuery(itemId));
  // On for about half the items (by the first character of the id), so the walk also has
  // items Cockpit left alone; all off with localStorage['poc.fakeRewrite'] = '0'.
  const shouldFake = itemId.charCodeAt(0) % 2 === 0;
  let fake = shouldFake;
  try {
    fake = localStorage.getItem('poc.fakeRewrite') !== '0' && shouldFake;
  } catch {
    /* no storage: keep the fake, so the walk still has something to show */
  }
  const all = [...(fake ? [fakeEntry(itemId)] : []), ...(data?.entries ?? [])];
  return { entries: all.filter((entry) => changedFields(entry).length > 0), error, refetch };
}

/** POC: the one-line note at the top of the Item tab, drawn only where Cockpit changed something. */
export function CockpitChangedNote({ itemId, onSee }: { itemId: string; onSee: () => void }) {
  const { entries } = useCockpitChanges(itemId);
  const latest = entries[0];
  if (!latest) return null;
  const fields = changedFields(latest).map((field) =>
    field === 'suggestedPanel' ? 'suggested panel' : field,
  );
  const said =
    fields.length === 1 ? fields[0] : `${fields.slice(0, -1).join(', ')} and ${fields.at(-1)}`;
  return (
    <p className="mt-2 shrink-0 text-xs text-ink-faint">
      Cockpit changed the {said} ·{' '}
      <button type="button" onClick={onSee} className="text-accent-deep underline">
        See what changed
      </button>
    </p>
  );
}

/** POC: what Cockpit changed on one item, as a section of the item's own form rather than a window over it. */
export function WhatCockpitChanged({ itemId }: { itemId: string }) {
  const { entries, error, refetch } = useCockpitChanges(itemId);
  const [open, setOpen] = useState<Set<string>>(new Set());
  if (error) return <LoadFailure error={error} onRetry={() => refetch()} />;
  if (entries.length === 0) {
    return <span className="text-ink-faint">Cockpit has not changed anything on this item.</span>;
  }
  return (
    <ul className="flex flex-col">
      {entries.map((entry) => {
        const changed = changedFields(entry);
        const isOpen = open.has(entry.id);
        return (
          <li key={entry.id} className="border-b border-black/5 py-1.5 last:border-b-0">
            <button
              type="button"
              aria-expanded={isOpen}
              onClick={() =>
                setOpen((was) => {
                  const next = new Set(was);
                  if (next.has(entry.id)) next.delete(entry.id);
                  else next.add(entry.id);
                  return next;
                })
              }
              className="flex w-full items-baseline gap-2 text-left"
            >
              <span className="w-3 shrink-0 text-ink-faint">{isOpen ? '▾' : '▸'}</span>
              <span className="min-w-0 flex-1 text-ink">
                {whatHappened(entry, changed)}
                <span className="block text-xs text-ink-faint">
                  {entry.looksAt ? `${WHY[entry.looksAt]} · ` : ''}
                  {new Date(entry.attemptedAt).toLocaleString()}
                </span>
              </span>
            </button>
            {isOpen && <FieldLines entry={entry} />}
          </li>
        );
      })}
    </ul>
  );
}
