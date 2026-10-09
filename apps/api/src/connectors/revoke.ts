import type { Connector } from '@cockpit/connector-sdk';
import type { Env } from '../env.js';
import { openAccount, type Account } from '../accounts/index.js';
import { open, sealingKey, type Sealed } from './credential-crypto.js';
import { connectionsFor } from './directory.js';

/**
 * Ending a source's sign-in once the connection that held it is gone, for a
 * connector that supplies a `revoke` ("Carry a connector's extra sign-in
 * parameters, refusals and revoke through the generic sign-in", issue 941) -
 * because a grant that can still read a source should not outlive the
 * connection that was its reason.
 *
 * **Never throws and never retries.** The connection is gone in Cockpit
 * whatever the source answers, so anything that goes wrong is logged and
 * nothing else happens; revoking first would instead leave a connection
 * Cockpit holds that the source refuses.
 *
 * **Not while another Workspace holds the same account at the source**: a
 * source revokes the whole grant rather than one token, so revoking here would
 * cut that connection off too. The account's own Workspaces are asked of its
 * own store; those of other Cockpit accounts are found through the register of
 * connections, by connector and account key, and each is confirmed against its
 * own store, since the register is a hint and a disconnected row can linger in
 * it. A holder that cannot be asked is taken to hold it: leaving a grant is
 * the recoverable side of being wrong.
 */
export async function revokeAfterDisconnect(
  env: Env,
  connector: Connector,
  account: Account,
  where: { accountName: string; workspaceId: string },
  sealed: Sealed & { externalAccountKey: string | null },
): Promise<void> {
  const say = (level: 'info' | 'error', message: string, cause?: unknown) =>
    console[level](
      JSON.stringify({
        level,
        message: `a ${connector.manifest.id} connection was disconnected, ${message}`,
        ...(cause === undefined ? {} : { cause: cause instanceof Error ? cause.message : String(cause) }),
      }),
    );
  try {
    if (!connector.revoke) return;
    const key = await sealingKey(env.CONNECTOR_CREDENTIAL_KEY);
    const credential = key ? await open(sealed, key) : null;
    if (credential === null) {
      say('error', 'but its sign-in could not be opened to revoke');
      return;
    }
    const connectorId = connector.manifest.id;
    const accountKey = sealed.externalAccountKey;
    if (accountKey && (await anotherWorkspaceHolds(env, account, where, connectorId, accountKey))) {
      say('info', 'and not revoked: another workspace still holds the account');
      return;
    }
    await connector.revoke({ credential });
  } catch (error) {
    say('error', 'but revoking its sign-in failed', error);
  }
}

async function anotherWorkspaceHolds(
  env: Env,
  account: Account,
  where: { accountName: string; workspaceId: string },
  connectorId: string,
  accountKey: string,
): Promise<boolean> {
  const own = await account.workspaces();
  const ownHolds = await Promise.all(
    own
      .filter((workspace) => workspace.id !== where.workspaceId)
      .map((workspace) => account.connectionUnder(workspace.id, connectorId, accountKey)),
  );
  if (ownHolds.some(Boolean)) return true;

  for (const pointer of await connectionsFor(env, connectorId, accountKey)) {
    // The accounts' own Workspaces were asked above, and this one's row is the
    // one just deleted.
    if (pointer.accountName === where.accountName) continue;
    const holder = await openAccount(env, pointer.accountName);
    if (await holder.connectionUnder(pointer.workspaceId, connectorId, accountKey)) return true;
  }
  return false;
}
