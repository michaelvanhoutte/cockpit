import { Fragment, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useQuery } from '@tanstack/react-query';
import { panelPlace, type RefinementScope, type RewriteHistoryEntry, type SuggestedPanel } from '@cockpit/shared';
import { rewriteHistoryForItemQuery, rewriteHistoryForWorkspaceQuery } from '../api/queries';
import { LoadFailure } from './LoadFailure';

/**
 * How Cockpit refined an Inbox's items, and when ("See the history of what
 * Cockpit proposed for the Inbox's items", issue 444; "Rename Rewrite history
 * to Smart refinements, and show each field's change", issue 614). Rows are
 * identified by an item's id rather than its title, since the title is the
 * very thing a refinement changes.
 *
 * **One table, filtered two ways.** `itemId` scopes it to one item's own
 * refinements, opened from that item's own menu; omitted, every refinement in
 * `workspaceId`, opened from the Inbox's own menu - the query differs, the
 * table drawn from it does not.
 *
 * **A row says when, why and what happened; only one that changed something
 * opens**, to a line per field it looked at.
 */

type Field = 'title' | 'description' | 'suggestedPanel';

const FIELD_LABEL: Record<Field, string> = {
  title: 'Title',
  description: 'Description',
  suggestedPanel: 'Suggested panel',
};

/** Which fields a refinement looks at; a row from before that was recorded is read as having looked at all three. */
const LOOKS_AT: Record<RefinementScope, Field[]> = {
  'texts-and-panel': ['title', 'description', 'suggestedPanel'],
  texts: ['title', 'description'],
  panel: ['suggestedPanel'],
};

export const WHY: Record<RefinementScope, string> = {
  'texts-and-panel': 'When you captured it',
  texts: 'After you edited another item',
  panel: 'After you filed another item',
};

type FieldLine =
  | { field: Field; kind: 'changed'; before: string; after: string }
  | { field: Field; kind: 'unchanged'; value: string }
  | { field: Field; kind: 'not-recorded' };

function textValue(text: string | null): string {
  return text ? text : 'None';
}

function panelValue(panel: SuggestedPanel | null): string {
  if (!panel) return 'None';
  return panel.name !== null && panel.dashboardName !== null
    ? panelPlace(panel.dashboardName, panel.name)
    : 'a deleted panel';
}

/** One field's line: a text changed only where the new text differs from the old. */
function lineFor(entry: RewriteHistoryEntry, field: Field): FieldLine {
  if (field === 'suggestedPanel') {
    if (entry.looksAt === null) return { field, kind: 'not-recorded' };
    const before = entry.suggestedPanelBefore;
    const after = entry.suggestedPanelAfter;
    return (before?.id ?? null) === (after?.id ?? null)
      ? { field, kind: 'unchanged', value: panelValue(before) }
      : { field, kind: 'changed', before: panelValue(before), after: panelValue(after) };
  }
  const before = field === 'title' ? entry.titleBefore : entry.descriptionBefore;
  const after = field === 'title' ? entry.titleAfter : entry.descriptionAfter;
  return after === null || after === (before ?? '')
    ? { field, kind: 'unchanged', value: textValue(before) }
    : { field, kind: 'changed', before: textValue(before), after: textValue(after) };
}

function linesFor(entry: RewriteHistoryEntry): FieldLine[] {
  const fields = entry.looksAt ? LOOKS_AT[entry.looksAt] : LOOKS_AT['texts-and-panel'];
  return fields.map((field) => lineFor(entry, field));
}

/** The fields a settled refinement changed, in the order the window lists them. */
export function changedFields(entry: RewriteHistoryEntry): Field[] {
  if (entry.status !== 'rewritten') return [];
  return linesFor(entry)
    .filter((line) => line.kind === 'changed')
    .map((line) => line.field);
}

function sentenceCase(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function listed(words: string[]): string {
  return words.length === 1 ? words[0]! : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;
}

/** What happened, in one sentence. */
export function whatHappened(entry: RewriteHistoryEntry, changed: Field[]): string {
  if (entry.status === 'pending') return 'Working on it…';
  if (entry.status === 'failed') return `Failed: ${entry.message ?? 'no reason was given'}`;
  if (changed.length > 0) return `Changed the ${listed(changed.map((field) => FIELD_LABEL[field].toLowerCase()))}`;
  // A row from before what it looked at was recorded can have changed only
  // the Panel it never recorded - its own words say what it did.
  if (entry.status === 'left-as-is' || entry.looksAt === null) {
    return entry.message ? sentenceCase(entry.message) : 'Nothing changed';
  }
  return 'Nothing changed';
}

export function FieldLines({ entry }: { entry: RewriteHistoryEntry }) {
  return (
    <dl aria-label="What changed" className="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-2 py-1">
      {linesFor(entry).map((line) => (
        <div key={line.field} className="contents">
          <dt className="text-xs font-semibold uppercase tracking-wide text-ink-faint">{FIELD_LABEL[line.field]}</dt>
          <dd className="min-w-0 break-words">
            {line.kind === 'changed' ? (
              <>
                <p>
                  <del className="text-ink-faint">{line.before}</del>
                </p>
                <p className="text-ink">
                  <span className="text-ink-faint">→ </span>
                  <ins className="no-underline">{line.after}</ins>
                </p>
              </>
            ) : line.kind === 'unchanged' ? (
              <p className="text-ink-soft">
                {line.value} <span className="text-xs text-ink-faint">· unchanged</span>
              </p>
            ) : (
              <p className="text-ink-faint">not recorded</p>
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function SmartRefinementsWindow({
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
  /** Scopes the table to one item's own refinements; omitted, every item of `workspaceId`. */
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
        <Dialog.Overlay className="fixed inset-0 bg-black/30" />
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
          className="fixed left-1/2 top-1/2 flex h-[min(36rem,calc(100dvh-4rem))] max-h-[calc(100dvh-2rem)] min-h-[min(16rem,calc(100dvh-2rem))] w-[min(64rem,calc(100vw-2rem))] min-w-[min(20rem,calc(100vw-2rem))] max-w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 resize-none flex-col overflow-hidden rounded-lg border border-black/10 bg-surface p-5 shadow-lg sm:resize"
        >
          <Dialog.Title className="text-base font-semibold">What Cockpit changed</Dialog.Title>
          <Dialog.Description className="mt-0.5 text-xs text-ink-faint">
            {scoped
              ? 'How Cockpit refined this item, and when.'
              : 'How Cockpit refined the items in this Inbox, and when.'}
          </Dialog.Description>

          <div className="mt-3 min-h-0 flex-1 overflow-auto text-sm">
            {error ? (
              <LoadFailure error={error} onRetry={() => refetch()} />
            ) : entries.length === 0 ? (
              <p className="text-ink-faint">
                {scoped ? 'Nothing refined for this item yet.' : 'Nothing refined in this Inbox yet.'}
              </p>
            ) : (
              <table className="w-full border-collapse">
                <thead>
                  <tr className="border-b border-black/10 text-left text-xs uppercase tracking-wide text-ink-faint">
                    <th className="w-6 py-1.5" />
                    <th className="py-1.5 pr-3 font-semibold">When</th>
                    {!scoped && <th className="py-1.5 pr-3 font-semibold">Item</th>}
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
                          className={`border-b border-black/5 align-top ${canOpen ? 'cursor-pointer hover:bg-accent-tint/30' : ''}`}
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
                          {!scoped && (
                            <td className="py-2 pr-3">
                              <span className="whitespace-nowrap font-mono text-xs text-ink-soft">
                                {entry.itemId}
                              </span>
                            </td>
                          )}
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
                          <tr className="border-b border-black/5 bg-black/[0.02]">
                            <td />
                            <td colSpan={scoped ? 3 : 4} className="py-2 pr-3">
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
            <Dialog.Close className="shrink-0 rounded-md border border-black/10 px-3 py-1.5 text-sm text-ink-soft hover:bg-accent-tint hover:text-accent-deep">
              Done
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// Also the default export, for the lazy `import()` ItemRow.tsx and InboxPanel.tsx load this behind.
export default SmartRefinementsWindow;
