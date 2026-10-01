import type { Priority } from '@cockpit/shared';

/**
 * Priority's option text, everywhere a level is offered or read back
 * (`ItemForm`'s own control, a Filter's Priority row and its sentence,
 * "Filter a Filter panel by priority and type", issue 464) — one copy so a
 * level added to the schema fails to compile everywhere it is missed, rather
 * than drifting silently out of step with it in one of several places that
 * used to hold their own.
 */
export const PRIORITY_LABELS: Record<Priority, string> = {
  low: 'Low',
  normal: 'Normal',
  high: 'High',
};

/** A level's flag fill (`--color-priority-*`, styles.css), as the Inbox row and the form's flags draw it. */
export const PRIORITY_FLAG_COLOURS: Record<Priority, string> = {
  low: 'bg-priority-low',
  normal: 'bg-priority-normal',
  high: 'bg-priority-high',
};
