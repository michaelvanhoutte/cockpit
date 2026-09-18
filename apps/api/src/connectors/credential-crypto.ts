/**
 * Sealing a source account's credential, and opening it again ("Connect a
 * Microsoft Teams source account", issue 485).
 *
 * **The first thing this application encrypts at rest, and deliberately the
 * narrowest possible primitive**: AES-GCM with a 256-bit key, a fresh 96-bit
 * nonce per sealing, and nothing about where either the key or the sealed
 * bytes are kept. That is what makes every branch below provable at L1
 * (tests/unit/connectors/credential-crypto.test.ts) against real Web Crypto
 * rather than against a stand-in.
 *
 * **Web Crypto rather than `node:crypto`**, which the Workers runtime this
 * deploys to does not have. `globalThis.crypto.subtle` is the same API in
 * both, so the tests exercise what the Worker runs.
 *
 * **AES-GCM is authenticated**, which is the reason to prefer it over
 * AES-CBC here: opening bytes that were altered, or sealed under another key,
 * fails rather than answering plausible rubbish. A nonce is never reused,
 * because reusing one under the same key is what breaks GCM outright - so it
 * comes from the platform's CSPRNG on every sealing and is stored beside the
 * bytes rather than derived from anything about them.
 */

/** 96 bits, which is the nonce length AES-GCM is defined and fastest for. */
const NONCE_BYTES = 12;

/** What a sealed credential is, as a row holds it: base64, both halves. */
export interface Sealed {
  readonly sealedCredential: string;
  readonly credentialNonce: string;
}

/**
 * The key this environment seals with, from the secret it was given.
 *
 * Answers `null` rather than throwing where the secret is absent or is not
 * 32 bytes of base64: an environment nobody has put a key in must refuse to
 * connect anything and go on working otherwise, which is the same standing
 * `BACKUP_TOKEN` and `ANTHROPIC_API_KEY` have (`src/env.ts`). A key of the
 * wrong length is the same answer as none, because a short one is a weaker
 * key nobody chose rather than a key.
 */
export async function sealingKey(secret: string | undefined): Promise<CryptoKey | null> {
  const bytes = secret ? bytesOf(secret) : null;
  if (!bytes || bytes.length !== 32) return null;
  return crypto.subtle.importKey('raw', bytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/** Seals a credential under a fresh nonce. */
export async function seal(plaintext: string, key: CryptoKey): Promise<Sealed> {
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const sealed = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce },
    key,
    new TextEncoder().encode(plaintext),
  );
  return { sealedCredential: base64(new Uint8Array(sealed)), credentialNonce: base64(nonce) };
}

/**
 * Opens a sealed credential, or answers `null`.
 *
 * Null rather than an exception for every way it can fail - a wrong key,
 * altered bytes, a nonce that is not base64 - because the caller does the
 * same thing with all of them: the credential is not usable, which is a fact
 * about the row rather than a failure to report differently.
 */
export async function open(sealed: Sealed, key: CryptoKey): Promise<string | null> {
  const bytes = bytesOf(sealed.sealedCredential);
  const nonce = bytesOf(sealed.credentialNonce);
  if (!bytes || !nonce || nonce.length !== NONCE_BYTES) return null;
  try {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, bytes);
    return new TextDecoder().decode(plain);
  } catch {
    return null;
  }
}

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * Base64 back to bytes, or `null` for anything that is not base64 at all.
 *
 * `Uint8Array<ArrayBuffer>` rather than the bare alias, because apps/web
 * compiles this file too (to infer the API contract) under the DOM lib, whose
 * `BufferSource` will not take a view over a buffer that might be shared - the
 * same two-ambient-declarations problem the attachment routes record.
 */
function bytesOf(value: string): Uint8Array<ArrayBuffer> | null {
  try {
    const binary = atob(value.trim());
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}
