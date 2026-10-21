import type { SourceAccount, SourceAccountList } from '@cockpit/shared';
import type { Drawn } from './drawnAhead';

/**
 * What the Connections window shows of a change the server has not answered
 * yet, or has answered and no read of the list has landed since ("Show a
 * connection change the moment you make it", issue 1369).
 *
 * **The list as the server sent it, with the change applied to a copy**, as
 * `drawnAhead.ts` does for a Workspace: the held list is never written to, so a
 * read in flight cannot flip the screen back. `changeQueue.ts` decides which
 * changes are still drawn; this decides what each one draws. It lives in the
 * window's own chunk, since nothing else draws a connection.
 *
 * - **Disconnect:** the row is gone.
 * - **Change the choice:** the row names the new one in the connector's own
 *   words (`labelOf`). What a listing under the new choice counts is the
 *   connector's to say, so it is left out until the next read.
 * - **Files by name:** the row says so, or stops saying so.
 *
 * Only the connections of the Workspace the change names are touched, and a
 * change the server will refuse is drawn all the same until the refusal puts the
 * row back.
 */
export function connectionsDrawnOver(
  workspaceId: string,
  labelOf: (connectorId: string, choice: string) => string | undefined,
): (list: SourceAccountList, changes: readonly Drawn[]) => SourceAccountList {
  const rewrite = (list: SourceAccountList, id: string, change: (account: SourceAccount) => SourceAccount) => ({
    sourceAccounts: list.sourceAccounts.map((account) => (account.id === id ? change(account) : account)),
  });
  return (list, changes) =>
    changes.reduce((held, change) => {
      switch (change.name) {
        case 'disconnect_source_account': {
          const { sourceAccountId: id, workspaceId: named } = change.payload;
          return named !== workspaceId ? held : { sourceAccounts: held.sourceAccounts.filter((account) => account.id !== id) };
        }
        case 'set_connection_choice': {
          const { sourceAccountId: id, workspaceId: named, choice } = change.payload;
          if (named !== workspaceId) return held;
          return rewrite(held, id, ({ followsLabel: _was, followsListed: _counts, ...account }) => {
            const label = labelOf(account.connectorId, choice);
            return { ...account, follows: choice, ...(label === undefined ? {} : { followsLabel: label }) };
          });
        }
        case 'set_connection_files_by_name': {
          const { sourceAccountId: id, workspaceId: named, filesByName } = change.payload;
          return named !== workspaceId ? held : rewrite(held, id, (account) => ({ ...account, filesByName }));
        }
        default:
          return held;
      }
    }, list);
}
