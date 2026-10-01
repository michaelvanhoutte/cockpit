/**
 * Where an MCP client reaches Cockpit ("Connect Claude to Cockpit, and capture
 * an item from it", issue 599), as plain strings and nothing else.
 *
 * **A module of its own, free of the OAuth library**, because two readers that
 * must not load that library need these: the sign-in gate, whose argument for
 * every address it does not stand in front of is made in `auth/gate.ts`, and
 * the web app's typecheck, which compiles everything `http/app.ts` imports and
 * cannot resolve the `cloudflare:workers` module the library's types name
 * (the same trap `worker.ts` records for the store's class).
 */

/** The MCP endpoint itself: one tool, behind an access token. */
export const MCP_PATH = '/mcp';

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
