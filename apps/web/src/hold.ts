import { SWIPE_THRESHOLD_PX } from './swipe';

/**
 * What holding a row still meant ("Start a selection with a long press, so a
 * phone can do it too", issue 170).
 *
 * **The deciding is here, and pure**, for the reason `swipe.ts` gives beside
 * it: jsdom produces no gesture at all, so a test driving synthetic pointer
 * events proves a handler is wired and nothing else - it cannot fail for any
 * reason a thumb would. Keeping the thresholds out of the handler is what makes
 * them provable at the lowest level, and leaves the browser walk to prove only
 * that a finger can reach them.
 *
 * **A hold is a touch gesture, like the swipe it shares the row with.** A held
 * mouse button is the beginning of a drag onto a panel ("Drag an item into a
 * panel, and drop it where you want it", issue 141), and a desktop row shows
 * its tick on hover, so there is nothing for a hold to do there.
 */

/**
 * How long a finger stays put before the row is picked out, in milliseconds.
 *
 * Long enough not to fire under a thumb on its way to scrolling, short enough
 * that it does not read as the app having missed the touch. It is the cost of
 * starting a selection and it is paid once - every row after the first is a
 * tap - which is what lets it be this side of half a second rather than the
 * other.
 */
export const HOLD_MS = 450;

/**
 * How far a finger may drift and still be holding still, in CSS pixels.
 *
 * Far enough to allow the wobble every resting thumb has, and well short of
 * `SWIPE_THRESHOLD_PX`, which is what stops the two gestures ever both being
 * true: anything that travels far enough to mean a swipe stopped being a hold
 * long before it got there.
 */
export const HOLD_DRIFT_PX = 12;

/**
 * Whether a finger that has moved this far is still holding rather than going
 * somewhere.
 *
 * **Distance, not a direction.** A swipe asks which way it went because left
 * and right mean different things; a hold only asks whether it went anywhere,
 * so a thumb sliding up the list disqualifies it exactly as one sliding across
 * does - the list is scrolling, and a row picked out by a scroll is worse than
 * a hold that has to be made again.
 */
export function stillHolding(dx: number, dy: number): boolean {
  return Math.hypot(dx, dy) <= HOLD_DRIFT_PX;
}
