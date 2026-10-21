/**
 * Whether Twilio signed a request ("Text the Cockpit number and the note lands
 * in the Inbox", issue 1336): the one proof a text is genuine, since nothing a
 * request says about its sender can be believed.
 *
 * **Twilio's own scheme**: the signature is the base64 HMAC-SHA1, under the
 * account's auth token, of the full address the request was made to followed by
 * each form parameter's name and value, the parameters in name order. It is
 * pure, so every way of failing it is a case that costs nothing to run.
 *
 * The address is the one Twilio called: the retry settings after `#` on the
 * configured address are for Twilio alone and never reach a request, so they are
 * not part of what is signed here.
 */

/** The text a signature is computed over. */
export function signedText(url: string, params: URLSearchParams): string {
  // Sorted by name, then by value, so a name sent twice reads the same however it arrived.
  const sorted = [...params.entries()].sort(([a, x], [b, y]) => (a === b ? compare(x, y) : compare(a, b)));
  return url + sorted.map(([name, value]) => name + value).join('');
}

/** What Twilio signs `url` and `params` as, under `authToken`. */
export async function signatureFor(authToken: string, url: string, params: URLSearchParams): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(authToken),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  );
  const signed = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signedText(url, params)));
  return btoa(String.fromCharCode(...new Uint8Array(signed)));
}

/** True only where `signature` is what Twilio signs this request as under `authToken`. */
export async function isSignedByTwilio(
  authToken: string,
  url: string,
  params: URLSearchParams,
  signature: string | null,
): Promise<boolean> {
  if (!signature) return false;
  return sameText(await signatureFor(authToken, url, params), signature);
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Equal text, found without stopping at the first difference. */
function sameText(expected: string, given: string): boolean {
  let difference = expected.length ^ given.length;
  for (let at = 0; at < expected.length; at += 1) {
    difference |= expected.charCodeAt(at) ^ (given.charCodeAt(at) || 0);
  }
  return difference === 0;
}
