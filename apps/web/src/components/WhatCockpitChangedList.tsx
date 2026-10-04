import { useState } from 'react';
import { panelPlace, type RefinementScope, type RewriteHistoryEntry, type SuggestedPanel } from '@cockpit/shared';
import { changedFields, fieldChanged, fieldsLookedAt, type ChangedField } from '../cockpitChanges';
import { LoadFailure } from './LoadFailure';

/**
 * What Cockpit changed, drawn: a time's words, and the before-and-after it
 * opens to ("Show what Cockpit changed on the item itself, and name it for what
 * it is", issue 690). Shared by the Inbox's window and by an item's own tab, and
 * loaded behind both - the form's initial code holds only what decides whether
 * there is a note (`cockpitChanges.ts`).
 */

const FIELD_LABEL: Record<ChangedField, string> = {
  title: 'Title',
  description: 'Description',
  suggestedPanel: 'Suggested panel',
};

export const WHY: Record<RefinementScope, string> = {
  'texts-and-panel': 'When you captured it',
  texts: 'After you edited another item',
  panel: 'After you filed another item',
};

type FieldLine =
  | { field: ChangedField; kind: 'changed'; before: string; after: string }
  | { field: ChangedField; kind: 'unchanged'; value: string }
  | { field: ChangedField; kind: 'not-recorded' };

function textValue(text: string | null): string {
  return text ? text : 'None';
}

function panelValue(panel: SuggestedPanel | null): string {
  if (!panel) return 'None';
  return panel.name !== null && panel.dashboardName !== null
    ? panelPlace(panel.dashboardName, panel.name)
    : 'a deleted panel';
}

/** One field's line. */
function lineFor(entry: RewriteHistoryEntry, field: ChangedField): FieldLine {
  if (field === 'suggestedPanel') {
    if (entry.looksAt === null) return { field, kind: 'not-recorded' };
    return fieldChanged(entry, field)
      ? {
          field,
          kind: 'changed',
          before: panelValue(entry.suggestedPanelBefore),
          after: panelValue(entry.suggestedPanelAfter),
        }
      : { field, kind: 'unchanged', value: panelValue(entry.suggestedPanelBefore) };
  }
  const before = field === 'title' ? entry.titleBefore : entry.descriptionBefore;
  const after = field === 'title' ? entry.titleAfter : entry.descriptionAfter;
  return fieldChanged(entry, field)
    ? { field, kind: 'changed', before: textValue(before), after: textValue(after) }
    : { field, kind: 'unchanged', value: textValue(before) };
}

function linesFor(entry: RewriteHistoryEntry): FieldLine[] {
  return fieldsLookedAt(entry).map((field) => lineFor(entry, field));
}

function sentenceCase(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function listed(words: string[]): string {
  return words.length === 1 ? words[0]! : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;
}

/** What happened, in one sentence. */
export function whatHappened(entry: RewriteHistoryEntry, changed: ChangedField[]): string {
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

/** A line per field the attempt looked at: what it was and what it became, or that it is unchanged. */
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

/**
 * The item form's tab: each time Cockpit changed something on this item, newest
 * first, each opening to its before-and-after. `changes` is already only the
 * times it did (`changesOn`); what has not arrived, or cannot be read, is said
 * here rather than leaving the tab blank.
 */
export function WhatCockpitChangedOnAnItem({
  changes,
  error,
  loading,
  onRetry,
}: {
  changes: RewriteHistoryEntry[];
  error: unknown;
  loading: boolean;
  onRetry: () => void;
}) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  if (error) return <LoadFailure error={error} onRetry={onRetry} />;
  if (loading) return <p className="text-ink-faint">Looking for what Cockpit changed…</p>;
  if (changes.length === 0) {
    return <p className="text-ink-faint">Cockpit has not changed anything on this item.</p>;
  }
  return (
    <ul className="flex flex-col">
      {changes.map((entry) => {
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
              <span aria-hidden="true" className="w-3 shrink-0 text-ink-faint">
                {isOpen ? '▾' : '▸'}
              </span>
              <span className="min-w-0 flex-1 text-ink">
                {whatHappened(entry, changedFields(entry))}
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

// The default export is what the form's lazy `import()` loads.
export default WhatCockpitChangedOnAnItem;
