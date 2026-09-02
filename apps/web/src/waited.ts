/**
 * How long an Item has been sitting, for the right-hand end of its row
 * ("Modernise the app shell", issue 125).
 *
 * This is the one thing an Inbox row can tell you that its title cannot: not
 * what the thing is, but that it has been there a fortnight. Everything else on
 * the row answers "what is this"; this answers "how long have I been ignoring
 * it", which is the question a list you scan is actually being asked.
 *
 * **Nothing under a day.** A zero is worse than a blank: it takes a column of
 * space to say that nothing has happened yet, and it puts a number beside every
 * item you captured this morning - which is most of them, on the day you use
 * the app most. So the column is empty on a fresh Inbox and fills as things
 * rot, which is when it means something.
 *
 * Days rather than weeks or months the whole way up. Sixty days reads as `60d`,
 * which is blunt and correct; rounding it to `2mo` would be softer about a
 * thing that deserves no softening.
 *
 * Pure, and given `now` rather than reading a clock, so the rule is provable
 * without one (the testing skill's L1/F1 restriction on the clock).
 */
export function waitedSince(createdAt: string, now: number): string | null {
  const days = Math.floor((now - Date.parse(createdAt)) / 86_400_000);
  // A clock that disagrees with the server, or an item stamped a moment in the
  // future, is not a negative age - it is an item that has waited no time.
  if (!Number.isFinite(days) || days < 1) return null;
  return `${days}d`;
}
