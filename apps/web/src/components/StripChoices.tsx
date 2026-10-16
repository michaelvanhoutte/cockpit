import { useRef } from 'react';
import { prioritySchema, type Priority } from '@cockpit/shared';
import { dueDateLabel, shortDueDateLabel } from '../dueDate';
import { DUE_DATE_SHORTCUTS } from '../dueDateShortcuts';
import { PRIORITY_LABELS } from '../priority';

/**
 * The priority flags and Due chips as Capture's strip draws them, shared with
 * the Item form's one line at a desk ("Set status, priority and due date on one
 * line in the Item form at a desk", issue 1102). What a choice does - held, or
 * written - is the caller's; every choice is one click and pressing the lit one
 * again clears it, so there is no *None* to offer.
 */

/** The flag's colour at each level, the same as an Inbox row's flag (`ItemRow.tsx`). */
const FLAG_COLOURS: Record<Priority, { lit: string; unlit: string }> = {
  low: { lit: 'border-priority-low bg-priority-low text-white', unlit: 'text-priority-low' },
  normal: { lit: 'border-priority-normal bg-priority-normal text-white', unlit: 'text-priority-normal' },
  high: { lit: 'border-priority-high bg-priority-high text-white', unlit: 'text-priority-high' },
};

export const STRIP_BUTTON =
  'inline-flex min-h-9 shrink-0 items-center justify-center rounded-md border px-2 text-sm disabled:opacity-50 sm:min-h-0 sm:py-0.5 sm:text-xs';
export const QUIET_BUTTON =
  'border-shade/10 bg-field text-ink-faint hover:border-accent hover:bg-accent-tint hover:text-ink';
export const LIT_BUTTON = 'border-accent bg-accent-tint font-medium text-accent-deep';

/** Three flags; the level's name is each one's hover title rather than a word beside it. */
export function PriorityFlags({
  priority,
  onPriority,
  disabled,
}: {
  priority: Priority | null;
  onPriority: (priority: Priority | null) => void;
  disabled: boolean;
}) {
  return (
    <div role="group" aria-label="Priority" className="flex items-center gap-1.5">
      {prioritySchema.options.map((level) => {
        const lit = priority === level;
        return (
          <button
            key={level}
            type="button"
            disabled={disabled}
            aria-pressed={lit}
            aria-label={`${PRIORITY_LABELS[level]} priority`}
            title={`${PRIORITY_LABELS[level]} priority`}
            onClick={() => onPriority(lit ? null : level)}
            className={`${STRIP_BUTTON} w-9 sm:w-7 ${
              lit ? FLAG_COLOURS[level].lit : `border-shade/10 bg-field ${FLAG_COLOURS[level].unlit}`
            }`}
          >
            <span aria-hidden="true">⚑</span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * **Due** with its shortcuts and a date picker. A day that is none of the
 * shortcuts shows on the picker's own button, with a ✕ beside it.
 */
export function DueChips({
  due,
  onDue,
  disabled,
  className = '',
}: {
  due: string | null;
  onDue: (due: string | null) => void;
  disabled: boolean;
  className?: string;
}) {
  const picker = useRef<HTMLInputElement>(null);
  const today = new Date();
  const custom =
    due !== null && !DUE_DATE_SHORTCUTS.some((s) => s.dueDate(today) === due) ? due : null;

  const openPicker = () => {
    const input = picker.current;
    if (!input) return;
    try {
      input.showPicker();
    } catch {
      // No picker to show: the input itself is the way in.
      input.focus();
      input.click();
    }
  };

  return (
    <div role="group" aria-label="Due" className={`flex flex-wrap items-center gap-1 ${className}`}>
      <span
        aria-hidden="true"
        className="hidden text-xs font-semibold tracking-[0.11em] text-ink-faint uppercase sm:inline"
      >
        Due
      </span>
      {DUE_DATE_SHORTCUTS.map(({ label, dueDate }) => {
        const lit = due === dueDate(today);
        return (
          <button
            key={label}
            type="button"
            disabled={disabled}
            aria-pressed={lit}
            onClick={() => onDue(lit ? null : dueDate(new Date()))}
            className={`${STRIP_BUTTON} ${lit ? LIT_BUTTON : QUIET_BUTTON}`}
          >
            {label}
          </button>
        );
      })}
      <span className="relative inline-flex items-center gap-1">
        <button
          type="button"
          disabled={disabled}
          title="Pick a date"
          aria-label={custom ? `Due ${dueDateLabel(custom)}` : 'Pick a due date'}
          onClick={openPicker}
          className={`${STRIP_BUTTON} gap-1 ${custom ? LIT_BUTTON : QUIET_BUTTON}`}
        >
          <span aria-hidden="true" className={custom ? 'hidden sm:inline' : undefined}>
            📅
          </span>
          {custom && <span className="hidden sm:inline">{dueDateLabel(custom)}</span>}
          {custom && <span className="sm:hidden">{shortDueDateLabel(custom, today)}</span>}
        </button>
        {custom && (
          <button
            type="button"
            disabled={disabled}
            title="Clear the due date"
            aria-label="Clear the due date"
            onClick={() => onDue(null)}
            className={`${STRIP_BUTTON} ${QUIET_BUTTON}`}
          >
            ✕
          </button>
        )}
        {/* Where the native picker is drawn from, which is why it sits over
            the button rather than nowhere: the popup opens beside the input
            it belongs to. Out of the tab order and the accessibility tree -
            the button is how it is reached. */}
        <input
          ref={picker}
          type="date"
          tabIndex={-1}
          aria-hidden="true"
          aria-label="Due date"
          value={due ?? ''}
          onChange={(e) => {
            const picked = e.target.value;
            onDue(picked || null);
          }}
          className="pointer-events-none absolute inset-0 w-full opacity-0"
        />
      </span>
    </div>
  );
}
