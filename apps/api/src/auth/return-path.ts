import { AUTHORIZE_PATH } from '../mcp/paths.js';

/**
 * Where a finished sign-in goes back to, when something sent the browser to
 * sign in on its way somewhere else ("Connect Claude to Cockpit, and capture an
 * item from it", issue 599): the consent page an app opened, which a person
 * who was not signed in has to come back to rather than land on `/`.
 *
 * **The consent page and nothing else**, and that is the whole safety of it.
 * The value arrives on a plain `GET` any page on the internet can send
 * somebody to, so anything that could name another origin would turn signing
 * in into a redirect to wherever an attacker chose - with the person freshly
 * signed in and trusting the page they land on. Narrower than "a path here"
 * because the consent page is its only use, and a wider door is one more
 * thing to get wrong. `null` sends the sign-in home as before.
 *
 * Pure, and proved at L1 (tests/unit/auth/return-path.test.ts).
 */

/**
 * The most the path may come to **as the sign-in cookie holds it**, which is
 * JSON, percent-encoded by Hono (`setCookie`): a consent page's address is
 * itself percent-encoded, so its `%` is written again as `%25`. The three
 * secrets beside it come to 234 characters the same way, and the cookie's name
 * to about 25, so 3,500 keeps the whole cookie inside the 4,096 a browser
 * keeps - room for a consent page with a 1,500-character `state` and the rest
 * of an app's address besides. One that does not fit is told so on the
 * consent page (`mcp/consent.ts`) rather than sent home.
 */
export const RETURN_PATH_COOKIE_LIMIT = 3_500;

/** Any origin will do: the question is only whether the path stays on it. */
const PROBE = 'https://cockpit.invalid';

/**
 * The path to come back to, or `null` where `asked` is not one.
 *
 * Refused, rather than repaired: a value that is not already the consent
 * page's address is not something this application ever wrote, so there is
 * nothing to recover.
 *
 * - It must start with exactly one `/`: `//host` is an address on another
 *   origin, and so is `/\host`, which a browser reads the same way.
 * - No control characters, which a browser strips before resolving - turning
 *   `/\t/host` into `//host` after this has looked at it - and no backslash.
 * - It must resolve back onto the origin it was resolved against.
 * - **And the settled path is held to the same rules again, and must be the
 *   consent page**, because settling is what can make one: `/.//host` and
 *   `/..//host` are plain paths on the way in and `//host` on the way out,
 *   which a browser then follows off this origin.
 * - It must fit in the cookie it rides in, measured as the cookie writes it.
 */
export function returnPathFrom(asked: string | undefined | null): string | null {
  if (!asked || asked.length > RETURN_PATH_COOKIE_LIMIT) return null;
  if (!isOneSlashPath(asked)) return null;
  if (/[\u0000-\u001f\u007f\\]/.test(asked)) return null;
  let resolved: URL;
  try {
    resolved = new URL(asked, PROBE);
  } catch {
    return null;
  }
  if (resolved.origin !== PROBE || resolved.pathname !== AUTHORIZE_PATH) return null;
  const settled = `${resolved.pathname}${resolved.search}`;
  if (!isOneSlashPath(settled) || !fitsTheCookie(settled)) return null;
  return settled;
}

/** Whether a path, written into the sign-in cookie the way Hono writes it, stays inside the limit. */
export function fitsTheCookie(path: string): boolean {
  return encodeURIComponent(JSON.stringify(path)).length <= RETURN_PATH_COOKIE_LIMIT;
}

/** A path starting with exactly one slash, which is the only kind that stays on this origin. */
function isOneSlashPath(path: string): boolean {
  return path.startsWith('/') && !path.startsWith('//') && !path.startsWith('/\\');
}
