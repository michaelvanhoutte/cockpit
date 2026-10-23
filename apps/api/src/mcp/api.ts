import type { Env } from '../env.js';
import { isAnAddressOfTheReadsOfPanels } from '../auth/mcp-paths.js';
import { answerPanelRead } from './panel-reads.js';
import { kindOfScope } from './scope.js';
import { answerMcp, type ProtectedContext } from './server.js';

/**
 * Where a request goes once the OAuth library has accepted its access token,
 * which is the one place what a grant may reach is decided ("Read a Panel from
 * an app allowed only to read, and open Capture from its address", issue 1445):
 *
 * | The grant | `/mcp` | The two reads of Panels |
 * |---|---|---|
 * | holds nothing: Claude, and every grant made before the read scope | MCP, as it was | refused |
 * | holds the read scope (`scope.ts`) | refused | the reads |
 *
 * **Decided here, before either handler runs, from the scope the library read
 * off the token** - so neither handler has to remember to ask, and a new
 * address under `/mcp` is refused to an app that may only read until somebody
 * says otherwise, rather than reachable until somebody notices.
 */
export function answerApi(request: Request, env: Env, ctx: ProtectedContext): Promise<Response> | Response {
  const mayRead = kindOfScope(ctx.auth?.scope ?? []) === 'reads-panels';
  const reading = isAnAddressOfTheReadsOfPanels(new URL(request.url).pathname);
  if (mayRead !== reading) return refusedForWhatItMayDo(mayRead);
  return reading ? answerPanelRead(request, env, ctx) : answerMcp(request, env, ctx);
}

/**
 * The answer to an app asking for what its grant does not cover: `403`, which
 * is the protocol's answer to a token that is good for something else
 * (RFC 6750), and says in plain words which kind of app this is.
 */
function refusedForWhatItMayDo(mayOnlyRead: boolean): Response {
  const description = mayOnlyRead
    ? 'This app may only read your Panels'
    : 'This app was not allowed to read your Panels';
  return new Response(JSON.stringify({ error: 'insufficient_scope', error_description: description }), {
    status: 403,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'www-authenticate': `Bearer realm="OAuth", error="insufficient_scope", error_description="${description}"`,
    },
  });
}
