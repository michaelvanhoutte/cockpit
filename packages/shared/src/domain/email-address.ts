import { z } from 'zod';

// This package compiles against pure ES libs (no DOM, no workers-types), so the
// one WebCrypto global every target runtime shares is declared here, as `ids.ts` does.
declare const crypto: { getRandomValues<T extends ArrayBufferView>(array: T): T };

/**
 * The part of an Email to Cockpit address before the `@` ("Get an Email to
 * Cockpit address, and receive mail at it", issue 1466): made by the browser,
 * never chosen, since its being unguessable is what keeps strangers out. At
 * least 16 lower-case letters and digits, and at most the 64 a mailbox name
 * may hold; anything else is refused.
 */
export const emailLocalPartSchema = z.string().regex(/^[a-z0-9]{16,64}$/);

/** How long a made one is: 20 characters of 32, so 100 bits nobody can guess. */
export const EMAIL_LOCAL_PART_LENGTH = 20;

/**
 * Lower-case letters but `l` and `o`, and the digits 2 to 9: 32 characters, so
 * each random byte maps to one with no character likelier than another, and
 * none of 0, 1, o or l, which read alike when somebody types the address from
 * a screen.
 */
const ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';

/** A new random part, in the browser, for *Get an address* and *Make a new address…*. */
export function newEmailLocalPart(fill: (bytes: Uint8Array) => Uint8Array = (bytes) => crypto.getRandomValues(bytes)): string {
  const bytes = fill(new Uint8Array(EMAIL_LOCAL_PART_LENGTH));
  return Array.from(bytes, (byte) => ALPHABET[byte % ALPHABET.length]).join('');
}

/**
 * What every Workspace's snapshot says of the account's Email to Cockpit
 * address: where this environment receives mail, and the random part the
 * account holds there, or null where it holds none. The whole is null where
 * the environment receives no mail, which draws no *Your account* panel.
 *
 * Read back permissively, as every read-back shape is (architecture,
 * "`packages/shared`: schema and command rationale"): a random part stored
 * under an older rule still draws.
 */
export const emailToCockpitSchema = z.object({
  domain: z.string().min(1),
  localPart: z.string().min(1).nullable(),
});
export type EmailToCockpit = z.infer<typeof emailToCockpitSchema>;

/** The address as it is written: `localPart@domain`. */
export function emailAddressOf(localPart: string, domain: string): string {
  return `${localPart}@${domain}`;
}
