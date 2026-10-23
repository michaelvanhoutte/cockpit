import type { ConnectedAppKind } from '@cockpit/shared';

/**
 * What an app may do with the access it was given ("Read a Panel from an app
 * allowed only to read, and open Capture from its address", issue 1445).
 *
 * **Two kinds of app, told apart by the one scope a grant can hold.**
 *
 * | Grant holds | May | May not |
 * |---|---|---|
 * | nothing - every grant made before this existed, and Claude's | capture through MCP | read a Panel |
 * | `panels:read` | list Panels and read one | anything through MCP |
 *
 * **Never both**, which is what `scopeToGrant` guarantees where a grant is made:
 * a request naming the scope is granted it alone, so an app that could read
 * Panels cannot also create Items. Nothing stored is rewritten: a grant from
 * before holds no scope and stays an app that captures.
 */

/** The one scope: to read the Panels there are and the Items on one, and nothing else. */
export const READ_PANELS_SCOPE = 'panels:read';

/** What an app asking for these scopes is asking to be, as the consent page names it and the grant holds it. */
export function kindOfScope(scope: readonly string[]): ConnectedAppKind {
  return scope.includes(READ_PANELS_SCOPE) ? 'reads-panels' : 'captures';
}

/**
 * The scopes a grant is made with, given what the app asked for: the read scope
 * alone where it asked for it, whatever else it named; otherwise what it asked
 * for, as it always was.
 */
export function scopeToGrant(requested: readonly string[]): string[] {
  return kindOfScope(requested) === 'reads-panels' ? [READ_PANELS_SCOPE] : [...requested];
}
