import {
  RefusedDelivery,
  SourceError,
  type Connector,
  type ConnectedAccountHost,
  type EmittedItem,
  type PushHost,
  type SourceItem,
} from '@cockpit/connector-sdk';
import type { Env } from '../env.js';
import { AccountNotInRegisterError, openAccount, type Account } from '../accounts/index.js';
import { GUEST_ACCOUNT_NAME } from '../accounts/new-user.js';
import { open, sealingKey } from './credential-crypto.js';
import { connectionsFor, forgetConnection, type ConnectionPointer } from './directory.js';
import { derivedUuid } from '../domain/derived-uuid.js';

/**
 * The host a connector is handed for a pushed request, and the step between
 * "this call is genuine" and "this is whose it is" ("Save a Teams message to
 * Cockpit", issue 486).
 *
 * **The ordering is the point, and it is what this file exists to make true.**
 * A push arrives at an address every connected account of a source shares, so
 * nothing account-scoped may be reachable until the identity it names has been
 * matched to a stored connection: `forAccount` is the only way through, and
 * what it hands back is scoped to that one connection - so a stored credential
 * is opened for that connection or for none at all.
 */

/**
 * What the ingress route hands in: the environment, and what an Item newly
 * filed asks for.
 *
 * `filed` queues the same jobs capture's own route queues. The ingress route
 * hands it in, as the queue consumer hands the pulled host its own, because
 * `connectors` may not import `jobs`. It queues behind the response, so it
 * returns at once; it is told which connector filed the Item, for the record
 * of the call its clean-up makes.
 */
export interface PushSurroundings {
  readonly env: Env;
  readonly filed: (accountName: string, itemId: string, connectorId: string) => void;
}

/** What a failed delivery's line says where the error was not one a connector worded for the person. */
export const DELIVERY_FAILED = 'Cockpit could not file this delivery.';

/**
 * Hands a connector the push (`handleWebhook`) and writes the *Failed* line of
 * one that throws once it has been attributed to a connection ("See what each
 * Teams save became, in its connection's history", issue 1144), then lets the
 * error go on - Teams redelivers an action it got no 200 for. **Before
 * attribution there is no connection to write to**: a call refused, or naming
 * an account nothing has connected, stays in the Worker's logs only.
 *
 * The message is the connector's own where it threw the SDK's `SourceError`,
 * whose contract keeps credentials and URLs out of it, with its status; any
 * other error says only that the delivery could not be filed, since its text is
 * the platform's and may carry what was delivered.
 */
export async function handlePush(
  connector: Connector,
  request: Request,
  around: PushSurroundings,
): Promise<Response> {
  const attributed: { to: { account: Account; sourceAccountId: string } | null } = { to: null };
  const host = pushHostFor(
    connector.manifest.id,
    around,
    (account, sourceAccountId) => {
      attributed.to = { account, sourceAccountId };
    },
    connector.manifest.pushDecidesWorkspace !== false,
  );
  try {
    return await connector.handleWebhook!(request, host);
  } catch (error) {
    if (attributed.to) {
      const failure =
        error instanceof SourceError
          ? { message: error.message, status: error.status ?? null }
          : { message: DELIVERY_FAILED, status: null };
      // A line that cannot be written must not hide the error that caused it.
      await attributed.to.account.pushFailed(attributed.to.sourceAccountId, failure).catch(() => {});
    }
    // A delivery that can never be filed is answered rather than failed, so the source does not retry it.
    if (error instanceof RefusedDelivery) return error.response;
    throw error;
  }
}

export function pushHostFor(
  connectorId: string,
  around: PushSurroundings,
  attributedTo: (account: Account, sourceAccountId: string) => void = () => {},
  decidesWorkspace = true,
): PushHost {
  return {
    log: (level, message, data) => logged(connectorId, level, message, data),

    async forAccount(externalAccountKey: string): Promise<ConnectedAccountHost | null> {
      // The register's index first, which holds plain identifiers and nothing
      // else, and then the account's own store - the authority on whether that
      // connection is still there (`directory.ts`).
      for (const pointer of await connectionsFor(around.env, connectorId, externalAccountKey)) {
        // The shared guest connects nothing real, so nothing pushed is its own (issue 772).
        if (pointer.accountName === GUEST_ACCOUNT_NAME) continue;
        const account = await accountAt(around.env, pointer);
        const connection = account
          ? await account.connectionUnder(pointer.workspaceId, connectorId, externalAccountKey)
          : null;
        if (!connection) {
          // The row and the store disagree: the connection was disconnected,
          // or the account has gone. Swept here rather than left to
          // accumulate, and the next Workspace in the list is still tried.
          await forgetConnection(around.env, pointer, connectorId, externalAccountKey);
          continue;
        }
        attributedTo(account!, connection.id);
        return connectedHost(connectorId, around, pointer, account!, connection.id, decidesWorkspace);
      }
      return null;
    },
  };
}

/** The account a row points at, or null where the register no longer holds it. */
async function accountAt(env: Env, pointer: ConnectionPointer): Promise<Account | null> {
  try {
    return await openAccount(env, pointer.accountName);
  } catch (error) {
    if (error instanceof AccountNotInRegisterError) return null;
    throw error;
  }
}

/** What a connector may do once its push has been matched to one connection. */
function connectedHost(
  connectorId: string,
  around: PushSurroundings,
  pointer: ConnectionPointer,
  account: Account,
  sourceAccountId: string,
  decidesWorkspace: boolean,
): ConnectedAccountHost {
  return {
    log: (level, message, data) => logged(connectorId, level, message, data),

    /**
     * The credential of this one connection, opened here rather than in the
     * store: the key belongs to the Worker (`CONNECTOR_CREDENTIAL_KEY`), and a
     * store able to open what it holds would make its rows worth as much as
     * the secrets in them (docs/architecture.md, "Connectors: plugin-shaped,
     * host-blind").
     */
    async getCredentials(): Promise<Record<string, string>> {
      const key = await sealingKey(around.env.CONNECTOR_CREDENTIAL_KEY);
      if (!key) throw new Error('this environment has no key to open a stored credential with');
      const sealed = await account.sealedCredential(sourceAccountId);
      if (!sealed) throw new Error('the connection this push belongs to has no credential');
      const credential = await open(sealed, key);
      if (credential === null) {
        throw new Error("the stored credential could not be opened with this environment's key");
      }
      return { credential };
    },

    /**
     * Files what the connector read as an Item of the Workspace that connected
     * the account - through `capture_item`, the one command every front door
     * captures through (architecture, "Multi-channel capture and the
     * task-creator merge").
     *
     * **Named by what the connector says the thing is**, so the same save
     * arriving twice is one Item: both ids are derived from the source and the
     * connector's own id for it, so a redelivery is a replay the store already
     * knows to ignore (`commandAlreadyApplied`, accounts/command-service.ts) rather than
     * a second capture.
     *
     * The Item's texts are seeded from the captured message the way every other
     * front door seeds them (`textsFromCapture`) and cleaned up by the same job
     * afterwards - so a connector's `title` is what it made of the message
     * rather than a write of its own.
     *
     * **An item the source cannot name is refused here**, rather than derived
     * from the empty string: `sourceId` is what both ids are made of, so
     * without one every such item would be the same item, and the second would
     * be dropped as a replay of the first.
     */
    async emitItem(item: SourceItem): Promise<EmittedItem> {
      const sourceId = item.sourceId ?? '';
      if (!sourceId) {
        throw new Error(`the ${connectorId} connector emitted an item its source does not name`);
      }
      const itemId = await derivedUuid(`item:${connectorId}:${sourceId}`);
      // With the line naming the Item it became, in the same transaction.
      const result = await account.capturePushed(sourceAccountId, {
        commandId: await derivedUuid(`capture:${connectorId}:${sourceId}`),
        issuedAt: new Date().toISOString(),
        workspaceId: pointer.workspaceId,
        // Where a connector says its pushes decide nothing, the connecting
        // Workspace is only where this was captured from, and the Item is in
        // every Workspace's Inbox until it is filed, as a Car view capture is.
        ...(decidesWorkspace ? {} : { workspaceDecided: false }),
        itemId,
        message: item.capturedMessage ?? item.title ?? '',
        capturedFrom: {
          // The connector's own id, whatever it said: a connector never
          // chooses where its Items say they came from.
          source: connectorId,
          sourceId,
          ...(item.sourceLink ? { sourceLink: item.sourceLink } : {}),
          ...(item.sender ? { sender: item.sender } : {}),
          ...(item.sourceTimestamp ? { sourceTimestamp: item.sourceTimestamp } : {}),
        },
      });
      // The two jobs capture's own route fires, and for the reasons it fires
      // them: only where the Item was actually written, so a redelivered save
      // buys no second model call.
      if (!result.applied) return 'already-known';
      around.filed(pointer.accountName, itemId, connectorId);
      return 'filed';
    },
  };
}

function logged(
  connectorId: string,
  level: 'debug' | 'info' | 'warn' | 'error',
  message: string,
  data?: unknown,
): void {
  const line = JSON.stringify({ level, connector: connectorId, message, data });
  if (level === 'error') console.error(line);
  else console.log(line);
}
