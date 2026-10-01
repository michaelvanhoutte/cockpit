/**
 * Where a finished sign-in goes back to, when something sent the browser to
 * sign in on its way somewhere else ("Connect Claude to Cockpit, and capture an
 * item from it", issue 599): the consent page an app opened, which a person
 * who was not signed in has to come back to rather than land on `/`.
 *
 * **A path on this application and nothing else**, and that is the whole
 * safety of it. The value arrives on a plain `GET` any page on the internet can
 * send somebody to, so anything that could name another origin would turn
 * signing in into a redirect to wherever an attacker chose - with the person
 * freshly signed in and trusting the page they land on. So it is answered as a
 * path or not at all, and `null` sends the sign-in home as before.
 *
 * Pure, and proved at L1 (tests/unit/auth/return-path.test.ts).
 */

/** Longer than any consent page's address, and short enough to sit in a cookie. */
const RETURN_PATH_LIMIT = 2_000;

/** Any origin will do: the question is only whether the path stays on it. */
const PROBE = 'https://cockpit.invalid';

/**
 * The path to come back to, or `null` where `asked` is not one.
 *
 * Refused, rather than repaired: a value that is not already a plain path is
 * not something this application ever wrote, so there is nothing to recover.
 *
 * - It must start with exactly one `/`: `//host` is an address on another
 *   origin, and so is `/\host`, which a browser reads the same way.
 * - No control characters, which a browser strips before resolving - turning
 *   `/\t/host` into `//host` after this has looked at it.
 * - And it must resolve back onto the origin it was resolved against, which is
 *   the rule the two above are the known spellings of.
 */
export function returnPathFrom(asked: string | undefined | null): string | null {
  if (!asked || asked.length > RETURN_PATH_LIMIT) return null;
  if (!asked.startsWith('/') || asked.startsWith('//') || asked.startsWith('/\\')) return null;
  if (/[\u0000-\u001f\u007f\\]/.test(asked)) return null;
  let resolved: URL;
  try {
    resolved = new URL(asked, PROBE);
  } catch {
    return null;
  }
  if (resolved.origin !== PROBE) return null;
  return `${resolved.pathname}${resolved.search}`;
}
