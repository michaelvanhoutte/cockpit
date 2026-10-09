/**
 * When a pulled connection is checked, and whether a delivered check runs
 * ("Check a pulled connector on its cadence through the generic host", issue
 * 891) - the arithmetic the account's store decides by, kept here so it is
 * proven without one.
 */

/** How often each pulled connection is checked. */
export const PULLED_CHECK_EVERY_MS = 5 * 60_000;

/**
 * How soon a connection is checked again after a run that said there is more
 * to do - the same for every connector, which cannot ask for another time.
 */
export const PULLED_CHECK_SOON_MS = 10_000;

/**
 * How long a queued or running check holds its connection. Longer than a run
 * takes, so a live run is never joined by a second; and the most a check that
 * was lost - a dropped message, a run whose Worker went away - delays the next.
 */
export const PULLED_CHECK_LEASE_MS = 10 * 60_000;

/** A pulled connection's check, as the store holds it. */
export interface CheckAsHeld {
  /** When a check was queued and not yet taken by a run; null otherwise. */
  queuedAt: string | null;
  /** When the lease of the run under way runs out; null where none holds it. */
  leaseUntil: string | null;
}

/**
 * What a delivered check does: run, or nothing - because a run holds an
 * unexpired lease, or because no check is waiting, the one queued having been
 * run already by an earlier delivery of the same message.
 */
export function whatADeliveryDoes(
  held: CheckAsHeld,
  now: Date,
): 'run' | 'already running' | 'not queued' {
  if (leaseIsLive(held.leaseUntil, now)) return 'already running';
  if (held.queuedAt === null) return 'not queued';
  return 'run';
}

/** Whether a lease running out at `leaseUntil` still holds at `now`. */
export function leaseIsLive(leaseUntil: string | null, now: Date): boolean {
  return leaseUntil !== null && Date.parse(leaseUntil) > now.getTime();
}

/** When a lease taken at `now` runs out. */
export function leaseFrom(now: Date): string {
  return new Date(now.getTime() + PULLED_CHECK_LEASE_MS).toISOString();
}

/**
 * When the next check is due, after one that ended at `now`: soon where the
 * run said there is more to do, the usual cadence otherwise.
 */
export function nextCheckAfter(now: Date, moreToDo = false): string {
  return new Date(now.getTime() + (moreToDo ? PULLED_CHECK_SOON_MS : PULLED_CHECK_EVERY_MS)).toISOString();
}
