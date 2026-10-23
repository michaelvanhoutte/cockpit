/**
 * Where an MCP client reaches Cockpit ("Connect Claude to Cockpit, and capture
 * an item from it", issue 599), as plain strings and nothing else.
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
 * Where an app allowed only to read your Panels reads them (issue 1445): the
 * list of Panels at this address, and one Panel at this address and its id.
 *
 * **Under `/mcp` because the library binds every token to one resource and
 * answers only that resource's addresses**: a token is made for `/mcp` and
 * everything beneath it, so a read at any other address would need a second
 * resource and every grant made before it asked for again. The prefix is where
 * the token is good, not what is read: `mcp/api.ts` sends an address here to
 * the reads, and refuses it to a grant that may not read.
 *
 * `v1` is the address an installed app holds. A change an app cannot ignore
 * gets `v2` and this one answers that the app needs a newer version.
 */
export const PANEL_READS_PATH = '/mcp/reads/v1/panels';

/** Whether a path is one of the two reads of Panels (`PANEL_READS_PATH`) and not MCP's own. */
export function isAnAddressOfTheReadsOfPanels(path: string): boolean {
  return path === PANEL_READS_PATH || path.startsWith(`${PANEL_READS_PATH}/`);
}

/** The consent page, which is Cockpit's own and the one page here a person sees. */
export const AUTHORIZE_PATH = '/oauth/authorize';

/** Where a client trades a code or a refresh token for an access token - the library's. */
export const TOKEN_PATH = '/oauth/token';

/** Where a client registers itself and its redirect addresses (RFC 7591) - the library's. */
export const REGISTER_PATH = '/oauth/register';

/** The prefix both discovery documents sit under (RFC 8414 and RFC 9728) - the library's. */
const DISCOVERY_PREFIX = '/.well-known/oauth-';

/**
 * Whether a path is answered by the OAuth library rather than by the
 * application: the MCP endpoint and anything under it, the token and
 * registration endpoints, and the two discovery documents.
 *
 * **Exact matches and one boundary-checked prefix**, so `/mcp-other` or
 * `/oauth/tokens` is the application's to refuse rather than a hole nobody
 * chose. The consent page is deliberately not here: it is Cockpit's own page,
 * routed beside the library rather than through it (`worker.ts`).
 */
export function isAnsweredByTheAuthorizationServer(path: string): boolean {
  return (
    path === MCP_PATH ||
    path.startsWith(`${MCP_PATH}/`) ||
    path === TOKEN_PATH ||
    path === REGISTER_PATH ||
    path.startsWith(DISCOVERY_PREFIX)
  );
}
