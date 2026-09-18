import { dayOf, daysAfter, weekdayOf, type Day } from './filters';

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

/**
 * The coming Friday, never a past one: a weekday before Friday lands on this
 * week's, and Friday itself lands on today - both already in the future or
 * the present. Saturday or Sunday jumps to next week's Friday instead of one
 * already gone. `(5 - dow + 7) % 7` is the distance forward to Friday
 * (`5`) from today's weekday (`dow`) on the same Monday-to-Sunday week
 * `spanOf` (`filters.ts`) reads the calendar by, wrapped forward rather than
 * left to go negative.
 */
export function dueComingFriday(now: Date): Day {
  const today = dayOf(now);
  return daysAfter(today, (5 - weekdayOf(today) + 7) % 7);
}

export function dueSevenDaysOut(now: Date): Day {
  return daysAfter(dayOf(now), 7);
}
