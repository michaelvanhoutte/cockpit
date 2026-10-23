import { recurringTitle, type RecurringOrigin as Origin, type RepeatRule } from '@cockpit/shared';
import { askForRecurringItem } from '../recurringModal';

/**
 * A copy's row mark, among its title marks ("Point a copy at its master, and
 * retire the Repeats chip", issue 1450); its hover reads *Recurring weekly on
 * Monday*. Nothing for an Item that is no copy.
 */
export function RecurringMark({ rule }: { rule: RepeatRule | null | undefined }) {
  if (!rule) return null;
  const label = recurringTitle(rule);
  return (
    <span className="shrink-0 text-ink-faint" title={label} aria-label={label} role="img">
      ↻
    </span>
  );
}

/**
 * The line under a copy's title saying which recurring item it came from. The
 * name is a link that closes the form and opens the Recurring items modal on that
 * recurring item's form; once it is deleted the line reads *(since deleted)*,
 * with no link, and the copies stay. Nothing for an Item that is no copy.
 */
export function RecurringOriginLine({
  origin,
  workspaceId,
  onClose,
}: {
  origin: Origin | null;
  /** The Workspace the form is open in, which the recurring item is looked for in where it names none. */
  workspaceId: string;
  /** Closes the Item form, which the modal replaces. */
  onClose: () => void;
}) {
  if (!origin) return null;
  return (
    <p className="mt-2 shrink-0 text-xs text-ink-faint" data-recurring-origin>
      <span aria-hidden="true">↻ </span>
      From recurring item{' '}
      {origin.running ? (
        <button
          type="button"
          onClick={() => {
            onClose();
            askForRecurringItem({ workspaceId: origin.workspaceId ?? workspaceId, seriesId: origin.id });
          }}
          className="font-semibold text-accent-deep underline"
        >
          {origin.title} ›
        </button>
      ) : (
        <>
          <strong className="text-ink-soft">{origin.title}</strong> (since deleted)
        </>
      )}
    </p>
  );
}
