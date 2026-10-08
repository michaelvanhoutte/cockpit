import { base64url } from '../auth/oidc.js';
import { signingKey } from '../connectors/credential-crypto.js';

/**
 * Claude Code hooks reporting a session's state back to Cockpit ("See on the
 * item when Claude is waiting on you", issue 572): `Stop` says the session is
 * waiting on you, `UserPromptSubmit` that it is working again.
 *
 * **The route is outside the sign-in gate**, so what is here is its whole
 * door: a secret per connection, a cap on the body, and (in the account's store, `accounts/call-window.ts`)
 * a cap on how often one connection is heard from. Pure apart from Web Crypto, and provable at
 * L1 (tests/unit/engines/claude-code-hooks.test.ts).
 */

/** The path a connection's hooks post to, under the ingress prefix the sign-in gate waves through. */
export const HOOK_PATH_PREFIX = '/ingress/claude-code/hooks/';

/**
 * The most a hook's body may be. A `UserPromptSubmit` carries the prompt, up
 * to the 65,536 characters Claude takes, and a `Stop` Claude's last message,
 * so this is generous rather than tight: a real call refused here is a chip
 * that never moves.
 */
export const HOOK_BODY_LIMIT_BYTES = 1024 * 1024;

const PURPOSE = 'cockpit claude-code hooks v1';

/** The connection's secret, the same every time it is asked for - or null where the environment holds no key. */
export async function hookSecretFor(keySecret: string | undefined, sourceAccountId: string): Promise<string | null> {
  const key = await signingKey(keySecret, PURPOSE);
  if (!key) return null;
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(sourceAccountId));
  return base64url(new Uint8Array(mac));
}

/**
 * Whether a presented secret is this connection's. Checked by `verify`, which
 * compares in constant time, rather than by recomputing and comparing strings.
 */
export async function isHookSecret(
  keySecret: string | undefined,
  sourceAccountId: string,
  presented: string,
): Promise<boolean> {
  const key = await signingKey(keySecret, PURPOSE);
  const mac = bytesOfBase64url(presented);
  if (!key || !mac || mac.length !== 32) return false;
  return crypto.subtle.verify('HMAC', key, mac, new TextEncoder().encode(sourceAccountId));
}

/** Whether a hook's event says the session is waiting on you, working again, or neither. */
export function waitingFrom(event: unknown): boolean | null {
  if (event === 'Stop') return true;
  if (event === 'UserPromptSubmit') return false;
  return null;
}

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
