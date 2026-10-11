/** The window a caller's calls are counted over: a minute. */
const WINDOW_MS = 60_000;

/** How many calls one Claude Code connection is heard in a minute - a session sends two a turn. */
export const HOOK_CALLS_PER_MINUTE = 60;

/**
 * How many `create_item` calls one grant is admitted for in a minute, refused ones included - the same number
 * the Claude Code hooks are held to (`HOOK_CALLS_PER_MINUTE`), for the same
 * reason: well above anything a person asking Claude does, and a ceiling on
 * what a runaway loop can write before somebody notices.
 */
export const APP_CAPTURES_PER_MINUTE = 60;

/**
 * The calls a caller has been admitted for in the last minute, with this one
 * added - or null where it is one too many, leaving the count as it was.
 * Generic rate counting, kept with the store that holds the counts.
 */
export function admittedCalls(earlier: readonly number[], now: number, limit: number): number[] | null {
  const recent = earlier.filter((at) => now - at < WINDOW_MS);
  return recent.length >= limit ? null : [...recent, now];
}
