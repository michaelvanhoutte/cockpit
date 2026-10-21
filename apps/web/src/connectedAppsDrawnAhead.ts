import type { ConnectedAppList } from '@cockpit/shared';
import type { Drawn } from './drawnAhead';

/**
 * What the MCP connections window shows of a change the server has not answered
 * yet, or has answered and no read of the list has landed since ("Show a
 * connected app or user change the moment you make it", issue 1371).
 *
 * **The list as the server sent it, with the change applied to a copy**, as
 * `connectionsDrawnAhead.ts` does for connections: the held list is never written
 * to, so a read in flight cannot flip the screen back. It lives in the window's
 * own chunk, since nothing else draws a connected app.
 *
 * - **Disconnect:** the row is gone. A disconnect the server will refuse is drawn
 *   all the same until the refusal puts the row back.
 */
export function connectedAppsDrawnOver(list: ConnectedAppList, changes: readonly Drawn[]): ConnectedAppList {
  return changes.reduce(
    (held, change) => (change.name === 'disconnect_app' ? { apps: held.apps.filter((app) => app.id !== change.payload.appId) } : held),
    list,
  );
}
