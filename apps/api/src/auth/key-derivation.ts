/**
 * Keys derived from the one secret an environment holds
 * (`CONNECTOR_CREDENTIAL_KEY`), each for a purpose of its own - what seals an
 * attachment link (`auth/attachment-link.ts`) - and the decoding of that
 * secret. Sealing a stored credential with it is
 * `connectors/credential-crypto.ts`, which reads the secret the same way.
 *
 * **Derived rather than the secret itself**, so nothing made with one of these
 * can be mistaken for, or help open, a sealed credential.
 */

/**
 * An AES-GCM key for one purpose, derived from the secret ("Send an item's
 * attachments along when an agent starts", issue 573), so a new use needs no
 * secret of its own and never shares a key with a stored credential. `null`
 * where the secret is absent or is not 32 bytes of base64 (`sealingKey`'s
 * standing).
 */
export function derivedKey(secret: string | undefined, purpose: string): Promise<CryptoKey | null> {
  return derived(secret, purpose, { name: 'AES-GCM', length: 256 }, ['encrypt', 'decrypt']);
}

/** HKDF over the secret, with `purpose` as its info, to a key of the kind asked for. */
async function derived(
  secret: string | undefined,
  purpose: string,
  algorithm: Parameters<typeof crypto.subtle.deriveKey>[2],
  usages: Parameters<typeof crypto.subtle.deriveKey>[4],
): Promise<CryptoKey | null> {
  const bytes = secret ? bytesOf(secret) : null;
  if (!bytes || bytes.length !== 32) return null;
  const root = await crypto.subtle.importKey('raw', bytes, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: new TextEncoder().encode(purpose) },
    root,
    algorithm,
    false,
    usages,
  );
}

/**
 * Base64 back to bytes, or `null` for anything that is not base64 at all.
 *
 * `Uint8Array<ArrayBuffer>` rather than the bare alias, because apps/web
 * compiles this file too (to infer the API contract) under the DOM lib, whose
 * `BufferSource` will not take a view over a buffer that might be shared - the
 * same two-ambient-declarations problem the attachment routes record.
 */
export function bytesOf(value: string): Uint8Array<ArrayBuffer> | null {
  try {
    const binary = atob(value.trim());
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}
