/**
 * The debounce on the two settle-triggered refreshes ("Debounce the
 * settle-triggered repropose fan-out across a real time window", issue 582):
 * every settle or correction still queues its own refresh, delayed by
 * `debounceSecondsFor`, and records itself as the latest ask; a refresh that
 * finds a later ask recorded when it runs does nothing, because that later
 * ask's own refresh is still to come and will read everything this one would
 * have.
 *
 * **A burst is delayed, never dropped.** The ask recorded last always runs,
 * and it runs a full window after the last settle of the burst - so it reads
 * the backlog and the decision history as they stand once the burst is over.
 */

/**
 * One ask for a refresh: when it was made, and an id that tells two asks
 * made in the same millisecond apart.
 */
export interface RefreshAsk {
  at: number;
  id: string;
}

/** How long a refresh waits for a later ask to take its place, where the environment names nothing. */
export const DEFAULT_DEBOUNCE_SECONDS = 30;

/** The longest delay a queue will take on a message; a send asking for more is refused outright. */
const LONGEST_QUEUE_DELAY_SECONDS = 43_200;

/**
 * The window, from `REPROPOSE_DEBOUNCE_SECONDS` where it holds a whole number
 * of seconds a queue will accept, and `DEFAULT_DEBOUNCE_SECONDS` otherwise -
 * a window the queue refuses would lose every refresh rather than delay it.
 * Set by the backend suite alone, to `0`, so the cases that go through the
 * real queue do not each wait out a window nobody is asserting on.
 */
export function debounceSecondsFor(configured: string | undefined): number {
  if (configured === undefined || !/^\d+$/.test(configured)) return DEFAULT_DEBOUNCE_SECONDS;
  const seconds = Number(configured);
  return seconds <= LONGEST_QUEUE_DELAY_SECONDS ? seconds : DEFAULT_DEBOUNCE_SECONDS;
}

/**
 * Whether the ask now recorded replaces `mine`, as the record decides it:
 * only an ask at least as late as the one already there is ever written over
 * it (`laterOf`).
 *
 * **Recorded after the message is sent, never before**, which is what makes
 * a missing record harmless: a queue that would not take a message leaves
 * the earlier ask standing and its refresh still running, and a record that
 * could not be written leaves this ask's own refresh to run beside the
 * earlier one - twice, never zero times. A message from before this existed
 * carries no ask at all and always runs.
 */
export function isSuperseded(recorded: RefreshAsk | null, mine: RefreshAsk | undefined): boolean {
  if (mine === undefined || recorded === null) return false;
  return recorded.id !== mine.id && recorded.at >= mine.at;
}

/**
 * What the record holds once `incoming` has been offered to it: the later of
 * the two, and `incoming` on a tie, so that of two asks made in the same
 * millisecond exactly one is left standing to run.
 */
export function laterOf(recorded: RefreshAsk | null, incoming: RefreshAsk): RefreshAsk {
  return recorded !== null && recorded.at > incoming.at ? recorded : incoming;
}
