import type { MiddlewareHandler } from 'hono';
import { GUEST_ACCOUNT_NAME, GUEST_USER_ID } from '../accounts/new-user.js';
import type { GatedEnv } from './gate.js';

/**
 * The guest connects nothing real ("Refuse every connection change from the
 * guest account", issue 772).
 *
 * **The guest account is shared by every stranger who presses "Continue as
 * guest"**, so a mailbox or routine connected from it would be sitting in
 * front of all of them - the reason MCP consent refuses the guest too
 * (`mcp/grant.ts`). The sentence the page shows is a courtesy; this is the
 * guarantee, a refusal at the route before anything is read or stored.
 *
 * **Behind the sign-in gate**, reading the visitor it left, like the admin
 * gate. `c.req.path` rather than the raw URL, for the reason `auth/admin.ts`
 * gives.
 */

/** The addresses that connect, test or disconnect a source account. */
export function isConnectionChange(path: string): boolean {
  return (
    /^\/v1\/workspaces\/[^/]+\/connections\//.test(path) ||
    /^\/v1\/connections\//.test(path) ||
    /^\/v1\/commands\/(connect_source_account|disconnect_source_account|mark_source_account_tested)$/.test(path)
  );
}

/** Whether this is the shared guest, by the user or by the account, so a row edited by hand still counts. */
export function isTheGuest(visitor: { userId: string; accountName: string } | undefined): boolean {
  return visitor?.userId === GUEST_USER_ID || visitor?.accountName === GUEST_ACCOUNT_NAME;
}

export function guestConnectionGate(): MiddlewareHandler<GatedEnv> {
  return async (c, next) => {
    if (isConnectionChange(c.req.path) && isTheGuest(c.get('visitor'))) {
      return c.json({ error: 'Sign in with Google to connect your own' }, 403);
    }
    return next();
  };
}
