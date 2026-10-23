/**
 * Where an MCP client or a connected app reaches Cockpit ("Connect Claude to
 * Cockpit, and capture an item from it", issue 599), as plain strings and
 * nothing else.
 *
 * **A module of its own, free of the OAuth library**, because the sign-in's
 * return path (`auth/return-path.ts`) is reached from `http/app.ts`, which the
 * web app's typecheck compiles - and that typecheck cannot resolve the
 * `cloudflare:workers` module the library's types name (the same trap
 * `worker.ts` records for the store's class).
 */

/** The MCP endpoint itself: its tools, behind an access token. */
export const MCP_PATH = '/mcp';

/**
 * Where a connected app reads your Panels ("Read a Panel from an app allowed
 * only to read, and open Capture from its address", issue 1445): a protected
 * resource of its own, `{origin}/apps`, beside `/mcp`.
 *
 * **The resource a token is bound to is what it reaches**, and the OAuth
 * library checks that on every request: an app signed in for `/apps` is let in
 * to the two reads below and nothing else, and Claude's token, made for `/mcp`,
 * is turned away from them.
 */
export const APPS_PATH = '/apps';

/**
 * The list of Panels at this address, and beneath it one Panel
 * (`/apps/v1/panels/<id>?date=<day>`).
 *
 * `v1` is the address an installed app holds. A change an app cannot ignore
 * gets `v2` and this one answers that the app needs a newer version.
 */
export const PANEL_READS_PATH = `${APPS_PATH}/v1/panels`;

/** Whether `path` is `root` or an address beneath it, on a boundary: `/apps-other` is not under `/apps`. */
function isUnder(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

/** Whether a path is one of the two reads of Panels (`PANEL_READS_PATH`) and not another address under `/apps`. */
export function isAnAddressOfTheReadsOfPanels(path: string): boolean {
  return isUnder(path, PANEL_READS_PATH);
}

/** The consent page, which is Cockpit's own and the one page here a person sees. */
export const AUTHORIZE_PATH = '/oauth/authorize';

/** Where a client trades a code or a refresh token for an access token - the library's. */
export const TOKEN_PATH = '/oauth/token';

/** Where a client registers itself and its redirect addresses (RFC 7591) - the library's. */
export const REGISTER_PATH = '/oauth/register';

/** The prefix both kinds of discovery document sit under (RFC 8414 and RFC 9728) - the library's. */
const DISCOVERY_PREFIX = '/.well-known/oauth-';

/** Where each protected resource's discovery document sits (RFC 9728): this, then the resource's own path. */
const RESOURCE_METADATA_PREFIX = `${DISCOVERY_PREFIX}protected-resource`;

/**
 * Which part of the OAuth library answers a path: one of its two protected
 * resources, or the authorization server (token, registration, discovery).
 */
export type OAuthDoor = 'mcp' | 'apps' | 'authorization-server';

/**
 * Which door of the OAuth library a path is, or `null` where it is the
 * application's own: each resource's endpoint and anything beneath it, each
 * resource's discovery document, the token and registration endpoints, and the
 * authorization server's discovery document.
 *
 * **Exact matches and boundary-checked prefixes**, so `/mcp-other` or
 * `/oauth/tokens` is the application's to refuse rather than a hole nobody
 * chose. The consent page is deliberately not here: it is Cockpit's own page,
 * routed beside the library rather than through it (`worker.ts`).
 */
export function oauthDoorOf(path: string): OAuthDoor | null {
  if (isUnder(path, MCP_PATH) || isUnder(path, `${RESOURCE_METADATA_PREFIX}${MCP_PATH}`)) return 'mcp';
  if (isUnder(path, APPS_PATH) || isUnder(path, `${RESOURCE_METADATA_PREFIX}${APPS_PATH}`)) return 'apps';
  if (path === TOKEN_PATH || path === REGISTER_PATH || path.startsWith(DISCOVERY_PREFIX)) {
    return 'authorization-server';
  }
  return null;
}
