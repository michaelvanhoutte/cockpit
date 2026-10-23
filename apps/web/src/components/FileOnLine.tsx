import { Suspense, lazy, useState } from 'react';
import type { Workspace } from '@cockpit/shared';
import type { FileOnOption } from '../fileOn';

/** The search is a separate file, fetched on first focus (issue 1101). */
const FileOnSearch = lazy(() => import('./FileOnSearch'));

/** A Panel chosen to file the capture on. */
export interface FiledOn {
  panelId: string;
  name: string;
  workspaceId: string;
}

const FIELD =
  'min-h-9 w-full rounded-md border border-shade/10 bg-field px-3 text-sm placeholder:text-ink-faint focus:border-accent focus:outline-none sm:min-h-0 sm:py-1 sm:text-[13px]';

/**
 * Capture's *File on* line: a chip for each Panel chosen, and a type-ahead to
 * add another ("File a note on Panels from Capture, skipping the Inbox", issue
 * 1101). Nothing chosen means the Inbox, which the line says.
 *
 * **Only the placeholder is drawn until it is first focused**, which is what
 * fetches the search, so Capture opens without paying for it.
 */
export function FileOnLine({
  where,
  from,
  workspaces,
  filed,
  disabled,
  onAdd,
  onRemove,
  inTheItemForm = false,
  labelled,
}: {
  /** The Workspace chosen, or null for *Any workspace*. */
  where: string | null;
  /** The Workspace Capture was opened from, for a Panel made under *Any workspace*. */
  from: string | null;
  workspaces: readonly Workspace[];
  filed: readonly FiledOn[];
  disabled: boolean;
  onAdd: (option: FileOnOption) => void;
  onRemove: (panelId: string) => void;
  /** Drawn as the Item form's *On panels* field, under its description, in place of Capture's line (issue 1106). */
  inTheItemForm?: boolean;
  /** The label to draw in place of the default: the Recurring items form's *Files on* (issue 1449). */
  labelled?: string;
}) {
  const [armed, setArmed] = useState(false);
  const label = labelled ?? (inTheItemForm ? 'On panels' : 'File on');
  return (
    <div
      className={
        inTheItemForm
          ? 'flex flex-col gap-1'
          : 'order-4 mt-3 flex flex-col gap-1.5 sm:order-none sm:flex-row sm:flex-wrap sm:items-start sm:gap-2'
      }
    >
      <span
        aria-hidden="true"
        className={
          inTheItemForm
            ? 'text-xs font-semibold uppercase tracking-wide text-ink-faint'
            : 'text-[11px] font-semibold tracking-[0.11em] text-ink-faint uppercase sm:w-[74px] sm:shrink-0 sm:pt-1 sm:text-xs'
        }
      >
        {label}
      </span>
      <div role="group" aria-label={label} className="flex min-w-0 flex-wrap items-start gap-1.5 sm:flex-1">
        {filed.map((one) => (
          <span
            key={one.panelId}
            className="inline-flex min-h-9 shrink-0 items-center gap-1 rounded-full border border-accent bg-accent-tint pl-3 pr-1 text-sm font-medium text-accent-deep sm:min-h-0 sm:py-[1px] sm:pl-2.5 sm:text-[13px]"
          >
            {one.name}
            <button
              type="button"
              disabled={disabled}
              onClick={() => onRemove(one.panelId)}
              aria-label={inTheItemForm ? `Remove from ${one.name}` : `Do not file on ${one.name}`}
              title={inTheItemForm ? 'Remove from this Panel' : 'Do not file on this Panel'}
              className="flex size-6 items-center justify-center rounded-full text-ink-soft hover:bg-accent-soft/40 disabled:opacity-50"
            >
              ✕
            </button>
          </span>
        ))}
        {armed ? (
          <Suspense fallback={<input readOnly aria-label="Find a Panel to file on" placeholder="Find a Panel…" className={FIELD} />}>
            <FileOnSearch
              where={where}
              from={from}
              workspaces={workspaces}
              chosen={filed.map((one) => one.panelId)}
              instantly={inTheItemForm}
              onPick={onAdd}
            />
          </Suspense>
        ) : (
          <input
            readOnly
            disabled={disabled}
            onFocus={() => setArmed(true)}
            onClick={() => setArmed(true)}
            aria-label="Find a Panel to file on"
            placeholder={filed.length === 0 ? 'Inbox — or find a Panel…' : 'Add another Panel…'}
            className={`${FIELD} sm:w-72`}
          />
        )}
      </div>
    </div>
  );
}
