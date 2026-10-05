import { Fragment, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useQuery } from '@tanstack/react-query';
import { rewriteHistoryForWorkspaceQuery } from '../api/queries';
import { changedFields } from '../cockpitChanges';
import { LoadFailure } from './LoadFailure';
import { FieldLines, WHY, whatHappened } from './WhatCockpitChangedList';

/**
 * What Cockpit changed across an Inbox's items, and when ("See the history of
 * what Cockpit proposed for the Inbox's items", issue 444; "Show what Cockpit
 * changed on the item itself, and name it for what it is", issue 690). Rows are
 * identified by an item's id rather than its title, since the title is the very
 * thing a change alters. One item's own are a tab on its form, not here.
 *
 * **A row says when, why and what happened; only one that changed something
 * opens**, to a line per field it looked at.
 */
export function SmartRefinementsWindow({
  open,
  onClose,
  returnFocusTo,
  workspaceId,
}: {
  open: boolean;
  onClose: () => void;
  /** The control it was opened from, which gets the focus back. */
  returnFocusTo?: HTMLElement | null | undefined;
  workspaceId: string;
}) {
  const { data, error, refetch } = useQuery({
    ...rewriteHistoryForWorkspaceQuery(workspaceId),
    // Read on open, never ambient: this is a history table nobody watches
    // while it is closed.
    enabled: open,
  });
  const entries = data?.entries ?? [];

  /** Which rows are open to show a line per field. */
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
        <Dialog.Overlay className="fixed inset-0 z-floating bg-shade/30" />
        <Dialog.Content
          onCloseAutoFocus={(event) => {
            if (!returnFocusTo) return;
            event.preventDefault();
            returnFocusTo.focus();
          }}
          // **A fixed height, so opening a row scrolls the table rather than
          // growing the window.** Resizable by its corner at a desk and not on
          // a phone - the item form's own `sm:resize` (ItemForm.tsx), centred
          // the same way, so it grows towards the corner dragged the way that
          // one does. `overflow` other than `visible` is what makes the handle
          // appear at all; the table scrolls inside its own box below.
          className="fixed z-floating left-1/2 top-1/2 flex h-[min(36rem,calc(100dvh-4rem))] max-h-[calc(100dvh-2rem)] min-h-[min(16rem,calc(100dvh-2rem))] w-[min(64rem,calc(100vw-2rem))] min-w-[min(20rem,calc(100vw-2rem))] max-w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 resize-none flex-col overflow-hidden rounded-lg border border-shade/10 bg-surface p-5 shadow-lg sm:resize"
        >
          <Dialog.Title className="text-base font-semibold">What Cockpit changed</Dialog.Title>
          <Dialog.Description className="mt-0.5 text-xs text-ink-faint">
            How Cockpit refined the items in this Inbox, and when.
          </Dialog.Description>

          <div className="mt-3 min-h-0 flex-1 overflow-auto text-sm">
            {error ? (
              <LoadFailure error={error} onRetry={() => refetch()} />
            ) : entries.length === 0 ? (
              <p className="text-ink-faint">Nothing refined in this Inbox yet.</p>
            ) : (
              <table className="w-full border-collapse">
                <thead>
                  <tr className="border-b border-shade/10 text-left text-xs uppercase tracking-wide text-ink-faint">
                    <th className="w-6 py-1.5" />
                    <th className="py-1.5 pr-3 font-semibold">When</th>
                    <th className="py-1.5 pr-3 font-semibold">Item</th>
                    <th className="py-1.5 pr-3 font-semibold">Why</th>
                    <th className="py-1.5 font-semibold">What happened</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((entry) => {
                    const changed = changedFields(entry);
                    const canOpen = changed.length > 0;
                    const isOpen = canOpen && expanded.has(entry.id);
                    return (
                      <Fragment key={entry.id}>
                        <tr
                          className={`border-b border-shade/5 align-top ${canOpen ? 'cursor-pointer hover:bg-accent-tint/30' : ''}`}
                          onClick={() => canOpen && toggle(entry.id)}
                        >
                          <td className="py-2 text-ink-faint">
                            {canOpen && (
                              <button
                                type="button"
                                aria-expanded={isOpen}
                                aria-label={isOpen ? 'Hide what changed' : 'Show what changed'}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  toggle(entry.id);
                                }}
                                className="inline-block w-4 text-center"
                              >
                                {isOpen ? '▾' : '▸'}
                              </button>
                            )}
                          </td>
                          <td className="whitespace-nowrap py-2 pr-3 tabular-nums text-ink-faint">
                            {new Date(entry.attemptedAt).toLocaleString()}
                          </td>
                          <td className="py-2 pr-3">
                            <span className="whitespace-nowrap font-mono text-xs text-ink-soft">{entry.itemId}</span>
                          </td>
                          <td className="whitespace-nowrap py-2 pr-3 text-ink-soft">
                            {entry.looksAt ? WHY[entry.looksAt] : ''}
                          </td>
                          <td
                            className={`py-2 ${entry.status === 'failed' ? 'text-over' : canOpen ? 'text-ink' : 'text-ink-faint'}`}
                          >
                            {whatHappened(entry, changed)}
                          </td>
                        </tr>
                        {isOpen && (
                          <tr className="border-b border-shade/5 bg-shade/[0.02]">
                            <td />
                            <td colSpan={4} className="py-2 pr-3">
                              <FieldLines entry={entry} />
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
            <Dialog.Close className="shrink-0 rounded-md border border-shade/10 px-3 py-1.5 text-sm text-ink-soft hover:bg-accent-tint hover:text-accent-deep">
              Done
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// Also the default export, for the lazy `import()` InboxPanel.tsx loads this behind.
export default SmartRefinementsWindow;
