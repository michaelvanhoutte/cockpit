import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import {
  MOST_DUE_AFTER_DAYS,
  dayOf,
  firstNextOn,
  panelPlace,
  readBack,
  type Priority,
  type RecurringItem,
  type RepeatFrequency,
  type WorkspaceSnapshot,
} from '@cockpit/shared';
import { useWorkspaces } from '../api/useWorkspaces';
import { weekdayDayLabel } from '../dateFormat';
import { FileOnLine } from './FileOnLine';
import { LIT_BUTTON, PriorityFlags, QUIET_BUTTON, STRIP_BUTTON } from './StripChoices';

/**
 * The form of a recurring item ("Make, change and delete recurring items from
 * the Recurring items modal", issue 1449) - shaped like the Item form (title,
 * description, priority, where it is filed) with the schedule block the Repeats
 * popover had. **It is the Recurring items modal's content, swapped in the same
 * window and never a second one**: ← Recurring items, Cancel, Save and Delete
 * all go back to the list, the modal having already sent what they asked for.
 */

const FREQUENCIES: readonly [RepeatFrequency, string][] = [
  ['daily', 'Daily'],
  ['weekly', 'Weekly'],
  ['monthly', 'Monthly'],
  ['quarterly', 'Quarterly'],
  ['yearly', 'Yearly'],
];

const LABEL = 'block text-xs font-semibold uppercase tracking-wide text-ink-faint';
const BOX =
  'w-full rounded-md border border-shade/10 bg-field px-3 py-2 text-sm font-normal normal-case tracking-normal text-ink outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft/40';

/** A day the server takes: a four-digit year, which is what a date box passes while a fifth digit is being typed. */
const DAY = /^\d{4}-\d{2}-\d{2}$/u;

/** A Panel as the page says it: Chores ▸ Panel 1. Null where the Workspace no longer has it. */
export const placeOf = (snapshot: WorkspaceSnapshot, panelId: string): string | null => {
  const panel = snapshot.panels.find((one) => one.id === panelId);
  if (!panel) return null;
  const dashboard = snapshot.dashboards.find((one) => one.id === panel.dashboardId);
  return dashboard ? panelPlace(dashboard.name, panel.name) : panel.name;
};

/** A refusal and the field it is said beside. */
export interface Refused {
  field: 'nextOn' | 'panels' | 'other';
  text: string;
}

export function RecurringFormBody({
  workspaceId,
  snapshot,
  item,
  isNew,
  refusal,
  onBack,
  onSave,
  onDelete,
}: {
  workspaceId: string;
  snapshot: WorkspaceSnapshot;
  /** The recurring item being edited - or, for a new one, the blank it starts as, or the one a refusal sent back. */
  item: RecurringItem;
  isNew: boolean;
  /** Why the last save was refused, said beside the field until the next. */
  refusal: Refused | null;
  /** Back to the list, which Cancel and ← Recurring items do and nothing else. */
  onBack: () => void;
  onSave: (item: RecurringItem) => void;
  onDelete: (item: RecurringItem) => void;
}) {
  const workspaces = useWorkspaces().data?.workspaces ?? [];
  const [draft, setDraft] = useState<RecurringItem>(item);
  const [panelNames, setPanelNames] = useState<Record<string, string>>({});
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [refused, setRefused] = useState<Refused | null>(refusal);
  const set = (patch: Partial<RecurringItem>) => {
    setDraft((was) => ({ ...was, ...patch }));
    setRefused(null);
  };

  const filed = draft.panelIds.map((panelId) => ({
    panelId,
    name: placeOf(snapshot, panelId) ?? panelNames[panelId] ?? 'Panel',
    workspaceId,
  }));
  const canSave = draft.title.trim().length > 0 && DAY.test(draft.nextOn);

  return (
    <>
      <div className="flex shrink-0 items-center gap-2">
        <button
          type="button"
          onClick={onBack}
          className="-ml-1 rounded-md px-2 py-1 text-sm text-ink-soft hover:bg-accent-tint hover:text-accent-deep"
        >
          <span aria-hidden="true">← </span>Recurring items
        </button>
        <Dialog.Title className="ml-auto text-xs font-semibold uppercase tracking-wide text-accent-deep">
          {isNew ? 'New recurring item' : 'Recurring item'}
        </Dialog.Title>
      </div>

      <div className="mt-3 flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-1 pb-1">
        <label className={LABEL}>
          Title
          <input
            autoFocus={isNew}
            value={draft.title}
            onChange={(e) => set({ title: e.target.value })}
            className={`${BOX} mt-1`}
            placeholder="Weekly review"
          />
        </label>

        <label className={LABEL}>
          Description
          <textarea
            value={draft.description}
            onChange={(e) => set({ description: e.target.value })}
            rows={3}
            className={`${BOX} mt-1 resize-y`}
          />
        </label>

        <div className="flex flex-wrap items-center gap-3">
          <span className={LABEL}>Priority</span>
          <PriorityFlags
            priority={draft.priority}
            onPriority={(priority: Priority | null) => set({ priority })}
            disabled={false}
          />
        </div>

        <div>
          <FileOnLine
            inTheItemForm
            labelled="Files on"
            where={workspaceId}
            from={workspaceId}
            workspaces={workspaces}
            filed={filed}
            disabled={false}
            onAdd={(option) => {
              setPanelNames((was) => ({ ...was, [option.panelId]: `${option.dashboardName} ▸ ${option.name}` }));
              if (!draft.panelIds.includes(option.panelId)) set({ panelIds: [...draft.panelIds, option.panelId] });
            }}
            onRemove={(panelId) => set({ panelIds: draft.panelIds.filter((one) => one !== panelId) })}
          />
          {refused?.field === 'panels' && (
            <p role="alert" className="mt-1 text-sm text-over-ink">
              {refused.text}
            </p>
          )}
        </div>

        <fieldset className="rounded-md border border-shade/10 p-3 text-sm">
          <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-ink-faint">Repeats</legend>
          <div role="group" aria-label="Repeats" className="flex flex-wrap gap-1">
            {FREQUENCIES.map(([value, name]) => (
              <button
                key={value}
                type="button"
                aria-pressed={draft.frequency === value}
                onClick={() =>
                  set({
                    frequency: value,
                    // A new frequency re-anchors only a brand-new item; an existing one keeps its day.
                    nextOn: isNew ? firstNextOn(dayOf(new Date()), value) : draft.nextOn,
                  })
                }
                className={`${STRIP_BUTTON} ${draft.frequency === value ? LIT_BUTTON : QUIET_BUTTON}`}
              >
                {name}
              </button>
            ))}
          </div>
          <label className="mt-3 flex items-center justify-between gap-2">
            <span className="text-ink-soft">Next on</span>
            <input
              type="date"
              value={draft.nextOn}
              onChange={(e) => e.target.value && set({ nextOn: e.target.value })}
              className="rounded-md border border-shade/10 bg-field px-2 py-0.5 text-sm"
            />
          </label>
          {refused?.field === 'nextOn' && (
            <p role="alert" className="mt-1 text-sm text-over-ink">
              {refused.text}
            </p>
          )}
          <label className="mt-2 flex items-center justify-between gap-2">
            <span className="text-ink-soft">Due</span>
            <span className="flex items-center gap-1.5">
              <input
                type="number"
                min={0}
                max={MOST_DUE_AFTER_DAYS}
                placeholder="—"
                aria-label="Due days after it appears"
                value={draft.dueAfterDays ?? ''}
                onChange={(e) =>
                  set({
                    dueAfterDays:
                      e.target.value === ''
                        ? null
                        : Math.min(MOST_DUE_AFTER_DAYS, Math.max(0, Math.trunc(Number(e.target.value)))),
                  })
                }
                className="w-14 rounded-md border border-shade/10 bg-field px-2 py-0.5 text-right text-sm"
              />
              <span className="text-ink-soft">days after it appears</span>
            </span>
          </label>
          <p className="mt-3 rounded-md bg-accent-tint px-2 py-1.5 text-accent-deep">
            {readBack(
              { frequency: draft.frequency, nextOn: DAY.test(draft.nextOn) ? draft.nextOn : dayOf(new Date()), dueAfterDays: draft.dueAfterDays },
              weekdayDayLabel,
            )}
          </p>
          <p className="mt-2 text-xs text-ink-faint">
            Each one is copied from this recurring item, never from the last one. None is added while the previous one is still open.
          </p>
        </fieldset>
      </div>

      {refused?.field === 'other' && (
        <p role="alert" className="mt-2 shrink-0 text-sm text-over-ink">
          {refused.text}
        </p>
      )}
      <div className="flex shrink-0 flex-wrap items-center gap-2 pt-4">
        {!isNew &&
          (confirmDelete ? (
            <span className="flex flex-wrap items-center gap-2 text-sm text-ink-soft">
              Stop it? Copies already made stay.
              <button
                type="button"
                onClick={() => onDelete(item)}
                className="rounded-md border border-over-ink px-3 py-1.5 text-sm text-over-ink hover:bg-over-ink/10"
              >
                Delete
              </button>
              <button type="button" onClick={() => setConfirmDelete(false)} className="text-sm underline">
                Keep
              </button>
            </span>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmDelete(true)}
              className="rounded-md px-1 py-1.5 text-sm text-over-ink underline-offset-2 hover:underline"
            >
              Delete recurring item
            </button>
          ))}
        <span className="ml-auto flex gap-2">
          <button
            type="button"
            onClick={onBack}
            className="shrink-0 rounded-md border border-shade/10 px-3 py-1.5 text-sm text-ink-soft hover:bg-accent-tint hover:text-accent-deep"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!canSave}
            onClick={() => onSave({ ...draft, title: draft.title.trim() })}
            className="milled shrink-0 rounded-md bg-accent px-4 py-1.5 text-sm font-medium text-on-accent hover:bg-accent-hover disabled:opacity-50"
          >
            Save
          </button>
        </span>
      </div>
    </>
  );
}
