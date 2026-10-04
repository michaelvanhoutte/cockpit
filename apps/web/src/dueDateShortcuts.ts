import { dayOf, daysAfter, type Day } from './filters';

/**
 * The three one-click ways to set a due date, beside typing one directly
 * ("Give the item's form more room, and put clutter out of the way", issue
 * 480) - each measured from the moment the button is pressed, the same "now"
 * `dayOf` reads off the clock everywhere else, never from whatever the field
 * already holds.
 */

export function dueToday(now: Date): Day {
  return dayOf(now);
}

/** The day after today on the viewer's own calendar, crossing into the next month or year as the calendar does. */
export function dueTomorrow(now: Date): Day {
  return daysAfter(dayOf(now), 1);
}

export function dueSevenDaysOut(now: Date): Day {
  return daysAfter(dayOf(now), 7);
}

/** The shortcuts in the order they are offered, by the label on the button - one list for the item form and the Capture form's strip. */
export const DUE_DATE_SHORTCUTS: { label: string; dueDate: (now: Date) => Day }[] = [
  { label: 'Today', dueDate: dueToday },
  { label: 'Tmrw', dueDate: dueTomorrow },
  { label: '+7d', dueDate: dueSevenDaysOut },
];
