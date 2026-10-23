import type { ConnectedAppKind } from '@cockpit/shared';
import type { Env } from '../env.js';
import { APPS_PATH, MCP_PATH } from '../auth/mcp-paths.js';

/**
 * The two protected resources an app can be signed in for ("Read a Panel from
 * an app allowed only to read, and open Capture from its address", issue 1445),
 * as the absolute addresses the OAuth library binds a token to.
 *
 * | Resource | What a token for it reaches | Who holds one |
 * |---|---|---|
 * | `{origin}/mcp` | MCP, to capture an Item | Claude, and every grant made before `/apps` existed |
 * | `{origin}/apps` | the two reads of Panels (`panel-reads.ts`) | the widget app |
 *
 * **Nothing here is a scope.** The resource is what a grant may do, so the
 * consent page, Settings' row and the library's own check on every request all
 * read the same one fact.
 */
export function resourcesOf(env: Pick<Env, 'APP_ORIGIN'>): { readonly mcp: string; readonly apps: string } {
  const origin = new URL(env.APP_ORIGIN).origin;
  return { mcp: `${origin}${MCP_PATH}`, apps: `${origin}${APPS_PATH}` };
}

/**
 * What an app signed in for `resource` is: one that reads your Panels for
 * `/apps`, and one that captures for anything else - `/mcp`, and a grant made
 * before resources existed, which the library holds no resource for at all.
 */
export function kindOfResource(env: Pick<Env, 'APP_ORIGIN'>, resource: string | readonly string[] | undefined): ConnectedAppKind {
  return [resource ?? []].flat().includes(resourcesOf(env).apps) ? 'reads-panels' : 'captures';
}
