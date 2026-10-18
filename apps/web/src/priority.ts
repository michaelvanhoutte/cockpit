import type { Priority } from '@cockpit/shared';

/** A level's flag fill (`--color-priority-*`, styles.css), as the Inbox row and the form's flags draw it. */
export const PRIORITY_FLAG_COLOURS: Record<Priority, string> = {
  low: 'bg-priority-low',
  normal: 'bg-priority-normal',
  high: 'bg-priority-high',
};
