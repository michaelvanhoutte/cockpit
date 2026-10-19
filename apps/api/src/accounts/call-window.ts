/** The window a caller's calls are counted over: a minute. */
const WINDOW_MS = 60_000;

/**
 * How many `create_item` calls one grant is admitted for in a minute, refused ones included: well above anything a person asking Claude does, and a ceiling on
 * what a runaway loop can write before somebody notices.
 */
export const APP_CAPTURES_PER_MINUTE = 60;

/**
 * How many transcriptions one account is held to in a minute, refused ones
 * included ("Hold each account to 20 transcriptions a minute", issue 1043): far
 * above one person's dictation, and a ceiling on what the public guest account
 * on production - shared by every visitor - can draw from the shared Workers AI
 * allowance by looping requests.
 */
export const TRANSCRIPTIONS_PER_MINUTE = 20;

/**
 * How many offers to remember one account is asked for in a minute, refused
 * ones included ("Remember an edit as a sentence you confirm", issue 1163):
 * each is a call to the model, and ten is far above a person editing sends by
 * hand.
 */
export const REMEMBER_OFFERS_PER_MINUTE = 10;

/**
 * How many sentences one account may press Remember on in a minute, refused
 * ones included (issue 1163): each one queues up to twenty proposals again.
 */
export const SENTENCES_REMEMBERED_PER_MINUTE = 10;

/** The window `find_items` is also held to: a day, counted back from the call. */
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How many `find_items` calls one grant is admitted for in a minute ("Find
 * items in Cockpit from a connected app, over MCP", issue 1240): each reads
 * every open Item in scope, so the limit is far below capture's.
 */
export const APP_FINDS_PER_MINUTE = 10;

/**
 * How many `find_items` calls one grant is admitted for in a day: 500 calls
 * over 300 open Items is about 150,000 rows, 3% of the free plan's daily
 * allowance of Durable Object rows read.
 */
export const APP_FINDS_PER_DAY = 500;

/**
 * `find_items`' two windows over one grant's admitted calls (newest last,
 * the last day's alone): the count to keep with this call added, or which
 * limit refused it - **kept apart from capture's count**, so a looping agent
 * spends its own allowance and not the one capture draws on. A refused call
 * is not counted, so a caller that waits is let in again.
 */
export function admittedFinds(
  earlier: readonly number[],
  now: number,
): { admitted: true; calls: number[] } | { admitted: false; limit: 'a-minute' | 'a-day' } {
  const today = earlier.filter((at) => now - at < DAY_MS);
  if (today.length >= APP_FINDS_PER_DAY) return { admitted: false, limit: 'a-day' };
  if (admittedCalls(today, now, APP_FINDS_PER_MINUTE) === null) return { admitted: false, limit: 'a-minute' };
  return { admitted: true, calls: [...today, now] };
}

/**
 * `admittedCalls` (below), except that a call refused as one too many is counted too:
 * the window then stays full for as long as the caller keeps asking, which is
 * what holds a loop off. `calls` is the count to keep either way.
 */
export function countedCalls(
  earlier: readonly number[],
  now: number,
  limit: number,
): { admitted: boolean; calls: number[] } {
  const admitted = admittedCalls(earlier, now, limit);
  if (admitted) return { admitted: true, calls: admitted };
  // Only the newest `limit` can decide the next answer, so the rest are dropped: a flood does not grow the count.
  return { admitted: false, calls: [...earlier.filter((at) => now - at < WINDOW_MS), now].slice(-limit) };
}

/**
 * The calls a caller has been admitted for in the last minute, with this one
 * added - or null where it is one too many, leaving the count as it was.
 * Generic rate counting, kept with the store that holds the counts.
 */
export function admittedCalls(earlier: readonly number[], now: number, limit: number): number[] | null {
  const recent = earlier.filter((at) => now - at < WINDOW_MS);
  return recent.length >= limit ? null : [...recent, now];
}
