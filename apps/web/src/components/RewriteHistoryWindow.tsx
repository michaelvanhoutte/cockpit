import { Fragment, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useQuery } from '@tanstack/react-query';
import type { RewriteAttemptStatus, RewriteHistoryEntry } from '@cockpit/shared';
import { rewriteHistoryForItemQuery, rewriteHistoryForWorkspaceQuery } from '../api/queries';
import { LoadFailure } from './LoadFailure';

/**
 * What Cockpit proposed for an Inbox's items, and what became of each attempt
 * ("See the history of what Cockpit proposed for the Inbox's items", issue
 * 444) - the interaction settled through a working POC in the real app,
 * iterated three rounds against direct feedback (issue 444's own comment
 * thread): a right-click-only entry point was tried and dropped, and rows
 * are identified by an item's id rather than its title, since the title is
 * the very thing a rewrite changes.
 *
 * **One table, filtered two ways.** `itemId` scopes it to one item's own
 * attempts, opened from that item's own menu; omitted, every attempt in
 * `workspaceId`, opened from the Inbox's own menu - the query differs, the
 * table drawn from it does not.
 */

const STATUS_LABEL: Record<RewriteAttemptStatus, string> = {
  pending: 'Pending',
  rewritten: 'Rewritten',
  'left-as-is': 'Left as-is',
  failed: 'Failed',
};

const STATUS_CLASS: Record<RewriteAttemptStatus, string> = {
  pending: 'bg-accent-tint text-accent-deep',
  rewritten: 'bg-accent text-white',
  'left-as-is': 'bg-black/5 text-ink-faint',
  failed: 'bg-over/10 text-over',
};

/** Whether a row proposed anything beyond the title worth expanding for. */
function hasDetail(entry: RewriteHistoryEntry): boolean {
  return Boolean(entry.descriptionAfter || entry.proposedPanelName);
}

export function RewriteHistoryWindow({
  open,
  onClose,
  returnFocusTo,
  workspaceId,
  itemId,
}: {
  open: boolean;
  onClose: () => void;
  /** The control it was opened from, which gets the focus back. */
  returnFocusTo?: HTMLElement | null | undefined;
  workspaceId: string;
  /** Scopes the table to one item's own attempts; omitted, every item of `workspaceId`. */
  itemId?: string | undefined;
}) {
  const scoped = itemId !== undefined;
  const { data, error, refetch } = useQuery({
    ...(itemId ? rewriteHistoryForItemQuery(itemId) : rewriteHistoryForWorkspaceQuery(workspaceId)),
    // Read on open, never ambient: this is a history table nobody watches
    // while it is closed.
    enabled: open,
  });
  const entries = data?.entries ?? [];

  /** Which rows are expanded to show the description and Panel a same attempt also proposed. */
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggle = (id: string) =>
    setExpanded((was) => {
      const next = new Set(was);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <Dialog.Root open={open} onOpenChange={(nowOpen) => !nowOpen && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/30" />
        <Dialog.Content
          aria-describedby={undefined}
          onCloseAutoFocus={(event) => {
            if (!returnFocusTo) return;
            event.preventDefault();
            returnFocusTo.focus();
          }}
          className="fixed left-1/2 top-1/2 flex max-h-[calc(100dvh-4rem)] w-[min(64rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col rounded-lg border border-black/10 bg-surface p-5 shadow-lg"
        >
          <Dialog.Title className="text-base font-semibold">Rewrite history</Dialog.Title>

          <div className="mt-3 min-h-0 flex-1 overflow-auto text-sm">
            {error ? (
              <LoadFailure error={error} onRetry={() => refetch()} />
            ) : entries.length === 0 ? (
              <p className="text-ink-faint">
                {scoped ? 'Nothing attempted for this item yet.' : 'Nothing attempted yet.'}
              </p>
            ) : (
              <table className="w-full border-collapse">
                <thead>
                  <tr className="border-b border-black/10 text-left text-xs uppercase tracking-wide text-ink-faint">
                    <th className="w-6 py-1.5" />
                    <th className="py-1.5 pr-3 font-semibold">When</th>
                    {!scoped && <th className="py-1.5 pr-3 font-semibold">Item</th>}
                    <th className="py-1.5 pr-3 font-semibold">Title before → after</th>
                    <th className="py-1.5 pr-3 font-semibold">Status</th>
                    <th className="py-1.5 font-semibold">Message</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((entry) => {
                    const canExpand = hasDetail(entry);
                    const isOpen = canExpand && expanded.has(entry.id);
                    return (
                      <Fragment key={entry.id}>
                        <tr
                          className={`border-b border-black/5 align-top ${canExpand ? 'cursor-pointer hover:bg-accent-tint/30' : ''}`}
                          onClick={() => canExpand && toggle(entry.id)}
                        >
                          <td className="py-2 text-ink-faint">
                            {canExpand && (
                              <span className="inline-block w-4 text-center">{isOpen ? '▾' : '▸'}</span>
                            )}
                          </td>
                          <td className="whitespace-nowrap py-2 pr-3 tabular-nums text-ink-faint">
                            {new Date(entry.attemptedAt).toLocaleString()}
                          </td>
                          {!scoped && (
                            <td className="py-2 pr-3">
                              <span className="whitespace-nowrap font-mono text-xs text-ink-soft">
                                {entry.itemId}
                              </span>
                            </td>
                          )}
                          <td className="py-2 pr-3">
                            <p className={entry.titleAfter ? 'text-ink-faint line-through' : 'text-ink'}>
                              {entry.titleBefore}
                            </p>
                            {entry.titleAfter && <p className="text-ink">{entry.titleAfter}</p>}
                          </td>
                          <td className="py-2 pr-3">
                            <span
                              className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_CLASS[entry.status]}`}
                            >
                              {STATUS_LABEL[entry.status]}
                            </span>
                          </td>
                          <td className="py-2 text-ink-faint">{entry.message ?? '—'}</td>
                        </tr>
                        {isOpen && (
                          <tr className="border-b border-black/5 bg-black/[0.02]">
                            <td />
                            <td colSpan={scoped ? 4 : 5} className="py-2 pr-3">
                              <div className="flex flex-col gap-2 py-1 text-sm">
                                {entry.descriptionAfter && (
                                  <div>
                                    <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">
                                      Description
                                    </p>
                                    <p className="text-ink">{entry.descriptionAfter}</p>
                                  </div>
                                )}
                                {entry.proposedPanelName && (
                                  <div>
                                    <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">
                                      Panel proposed
                                    </p>
                                    <p className="text-ink">{entry.proposedPanelName}</p>
                                  </div>
                                )}
                              </div>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>

          <div className="flex justify-end pt-4">
            <Dialog.Close className="shrink-0 rounded-md border border-black/10 px-3 py-1.5 text-sm text-ink-soft hover:bg-accent-tint hover:text-accent-deep">
              Done
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
