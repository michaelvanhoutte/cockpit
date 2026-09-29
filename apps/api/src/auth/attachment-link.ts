import { derivedKey } from '../connectors/credential-crypto.js';

/**
 * A link that opens one attachment without a sign-in, for an agent's session
 * to download ("Send an item's attachments along when an agent starts",
 * issue 573) - the session is not signed in and cannot be.
 *
 * **The token is the account, the attachment and the expiry, sealed** with
 * AES-GCM under a key derived from `CONNECTOR_CREDENTIAL_KEY`: unguessable,
 * refused if one character changes, and not readable, so the account's name
 * never travels in a link sent to Anthropic. Nothing is stored, so there is
 * nothing to clean up; a file removed from its Item since is refused by the
 * route finding no attachment, not by the token.
 */

/** How long a link opens its file for. */
export const ATTACHMENT_LINK_LIFETIME_MS = 60 * 60 * 1000;

/** Where a link is served; outside the sign-in gate (`auth/gate.ts`). */
export const ATTACHMENT_LINK_PREFIX = '/v1/attachment-links/';

const PURPOSE = 'cockpit attachment link v1';
const NONCE_BYTES = 12;

/** The key links are sealed with, or `null` where the environment has no `CONNECTOR_CREDENTIAL_KEY`. */
export function attachmentLinkKey(secret: string | undefined): Promise<CryptoKey | null> {
  return derivedKey(secret, PURPOSE);
}

interface Named {
  accountName: string;
  attachmentId: string;
}

/** A token naming one attachment of one account, good for `ATTACHMENT_LINK_LIFETIME_MS` from `now`. */
export async function sealAttachmentLink(key: CryptoKey, named: Named, now: Date): Promise<string> {
  const payload = JSON.stringify({
    a: named.accountName,
    i: named.attachmentId,
    e: now.getTime() + ATTACHMENT_LINK_LIFETIME_MS,
  });
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, new TextEncoder().encode(payload)),
  );
  const token = new Uint8Array(NONCE_BYTES + sealed.length);
  token.set(nonce);
  token.set(sealed, NONCE_BYTES);
  return base64url(token);
}

/** What a token names, or `null` for one that is altered, sealed under another key, or expired at `now`. */
export async function openAttachmentLink(key: CryptoKey, token: string, now: Date): Promise<Named | null> {
  const bytes = bytesOfBase64url(token);
  if (!bytes || bytes.length <= NONCE_BYTES) return null;
  let payload: unknown;
  try {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bytes.slice(0, NONCE_BYTES) },
      key,
      bytes.slice(NONCE_BYTES),
    );
    payload = JSON.parse(new TextDecoder().decode(plain));
  } catch {
    return null;
  }
  const { a, i, e } = (payload ?? {}) as { a?: unknown; i?: unknown; e?: unknown };
  if (typeof a !== 'string' || typeof i !== 'string' || typeof e !== 'number') return null;
  if (now.getTime() >= e) return null;
  return { accountName: a, attachmentId: i };
}

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** `Uint8Array<ArrayBuffer>` for the reason `credential-crypto.ts`'s `bytesOf` gives. */
function bytesOfBase64url(value: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}
