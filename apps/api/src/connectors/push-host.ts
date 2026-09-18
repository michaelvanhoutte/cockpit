import type { ConnectedAccountHost, PushHost, SourceItem } from '@cockpit/connector-sdk';
import type { Env } from '../env.js';
import { AccountNotInRegisterError, openAccount, type Account } from '../accounts/index.js';
import { noteTypeId } from '../accounts/changes.js';
import { enqueueCleanUp, enqueueReadingItsMeaning } from '../jobs/enrichment.js';
import { open, sealingKey } from './credential-crypto.js';
import { connectionsFor, forgetConnection, type ConnectionPointer } from './directory.js';

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

/** What the ingress route hands in: the environment, and how to outlive the response. */
export interface PushSurroundings {
  readonly env: Env;
  /** Work that outlives the response - the enrichment a capture fires, as capture's own route fires it. */
  readonly waitUntil: (work: Promise<unknown>) => void;
}

export function pushHostFor(connectorId: string, around: PushSurroundings): PushHost {
  return {
    log: (level, message, data) => logged(connectorId, level, message, data),

    async forAccount(externalAccountKey: string): Promise<ConnectedAccountHost | null> {
      // The register's index first, which holds plain identifiers and nothing
      // else, and then the account's own store - the authority on whether that
      // connection is still there (`directory.ts`).
      for (const pointer of await connectionsFor(around.env, connectorId, externalAccountKey)) {
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
        return connectedHost(connectorId, around, pointer, account!, connection.id);
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
): ConnectedAccountHost {
  return {
    log: (level, message, data) => logged(connectorId, level, message, data),

    /**
     * The credential of this one connection, opened here rather than in the
     * store: the key belongs to the Worker (`CONNECTOR_CREDENTIAL_KEY`), and a
     * store able to open what it holds would make its rows worth as much as
     * the secrets in them.
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
     * **Named at what the source calls the thing that was saved**, so the same
     * save arriving twice is one Item: both ids are derived from the source and
     * its own id for it, so a redelivery is a replay the store already knows to
     * ignore (`commandAlreadyApplied`, accounts/command-service.ts) rather than
     * a second capture.
     *
     * The Item's texts are seeded from the captured message the way every other
     * front door seeds them (`textsFromCapture`) and cleaned up by the same job
     * afterwards - so a connector's `title` is what it made of the message
     * rather than a write of its own.
     */
    async emitItem(item: SourceItem): Promise<void> {
      const sourceId = item.sourceId ?? '';
      const itemId = await derivedUuid(`item:${connectorId}:${sourceId}`);
      const result = await account.applyChange('capture_item', {
        commandId: await derivedUuid(`capture:${connectorId}:${sourceId}`),
        issuedAt: new Date().toISOString(),
        workspaceId: pointer.workspaceId,
        itemId,
        message: item.capturedMessage ?? item.title,
        typeId: await typeToCaptureAs(pointer.accountName, account),
        capturedFrom: {
          source: item.source,
          sourceId,
          ...(item.sourceLink ? { sourceLink: item.sourceLink } : {}),
          ...(item.sender ? { sender: item.sender } : {}),
          ...(item.sourceTimestamp ? { sourceTimestamp: item.sourceTimestamp } : {}),
        },
      });
      // The two jobs capture's own route fires, and for the reasons it fires
      // them: only where the Item was actually written, so a redelivered save
      // buys no second model call.
      if (result.applied) {
        around.waitUntil(enqueueCleanUp(around.env, pointer.accountName, itemId));
        around.waitUntil(enqueueReadingItsMeaning(around.env, pointer.accountName, itemId));
      }
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

/**
 * Which Type a saved message is captured as: the account's own Note type where
 * it still has one, and its first Type otherwise.
 *
 * Every capture names a Type and nobody is at a keyboard to pick one, so this
 * is the one decision the host makes on a connector's behalf. Note rather than
 * Task, because what somebody saved is something they read rather than
 * something they have said they will do - and the Inbox is where they decide
 * which it is.
 */
async function typeToCaptureAs(accountName: string, account: Account): Promise<string> {
  const types = await account.itemTypes();
  const note = types.find((type) => type.id === noteTypeId(accountName)) ?? types[0];
  if (!note) throw new Error(`account ${accountName} has no type to capture a saved message as`);
  return note.id;
}

/**
 * A uuid that is the same every time for the same name - what makes a
 * redelivered push a replay rather than a second Item.
 *
 * Version 5's own construction (a digest with the version and variant bits set)
 * over SHA-256 rather than SHA-1: what `z.uuid()` and the store want is the
 * shape, and nothing here depends on which digest produced it.
 */
export async function derivedUuid(name: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(name)),
  );
  digest[6] = (digest[6]! & 0x0f) | 0x50;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  const hex = [...digest.slice(0, 16)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
