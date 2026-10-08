/** The window a caller's calls are counted over: a minute. */
const WINDOW_MS = 60_000;

/** How many calls one Claude Code connection is heard in a minute - a session sends two a turn. */
export const HOOK_CALLS_PER_MINUTE = 60;

/**
 * The calls a caller has been admitted for in the last minute, with this one
 * added - or null where it is one too many, leaving the count as it was.
 * Generic rate counting, kept with the store that holds the counts.
 */
export function admittedCalls(earlier: readonly number[], now: number, limit: number): number[] | null {
  const recent = earlier.filter((at) => now - at < WINDOW_MS);
  return recent.length >= limit ? null : [...recent, now];
}
