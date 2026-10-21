import { SourceError } from '@cockpit/connector-sdk';
import { uuidv7 } from '@cockpit/shared';
import { openAccount } from '../accounts/index.js';
import type { Env } from '../env.js';
import { seal, sealingKey } from './credential-crypto.js';
import { rememberConnectionAfterStoring } from './directory.js';
import { textedCodeOf } from './sign-in.js';

/**
 * Connecting a phone by confirming a code texted to it ("Connect a phone in
 * Settings by confirming a code texted to it", issue 1335), run for any
 * registered connector whose manifest says it connects that way.
 *
 * **Two requests inside the signed-in Settings window, and no state between
 * them**: sending asks the source to text a code, and confirming asks it
 * whether the code typed is that one. The source holds the code, its expiry
 * and its limit on wrong attempts, so nothing pending is kept here. **A number
 * is connected only by an approved code**, in the same request that checks it:
 * the store's row and the register's index are written together or not at all.
 */

/** What the person is told, by the connector's own words where it has them. */
export type Refusal = { readonly done: false; readonly status: 400 | 404 | 429 | 502; readonly error: string };

const UNKNOWN = { done: false, status: 404, error: 'unknown connector' } as const;
const NO_SUCH_WORKSPACE = { done: false, status: 404, error: 'no such workspace' } as const;
const TOO_MANY_CODES = {
  done: false,
  status: 429,
  error: 'Too many codes were asked for in the last hour. Try again later.',
} as const;
const WRONG_CODE = { done: false, status: 400, error: 'That is not the code. Check it and try again.' } as const;
const CODE_GONE = {
  done: false,
  status: 400,
  error: 'That code is no longer valid. Send a new one.',
} as const;
const COULD_NOT_ASK = 'That could not be checked just now. Nothing was connected. Try again shortly.';

/**
 * The texting source this connector is, with the key its connection is sealed
 * under, where it is offered here: registered, texted-code, and able to store
 * what it connects. Offered nowhere else, for the reason the listing leaves
 * such a card out.
 */
async function offered(env: Env, connectorId: string) {
  const texted = textedCodeOf(env, connectorId);
  const key = texted ? await sealingKey(env.CONNECTOR_CREDENTIAL_KEY) : null;
  return texted && key ? { texted, key } : null;
}

/** What a connector's own failure says to the person, and what an unexpected one does not. */
function couldNotAsk(connectorId: string, error: unknown): Refusal {
  if (error instanceof SourceError) return { done: false, status: 502, error: error.message };
  console.error(
    JSON.stringify({
      level: 'error',
      connector: connectorId,
      message: 'asking the source about a texted code failed',
      cause: error instanceof Error ? error.message : String(error),
    }),
  );
  return { done: false, status: 502, error: COULD_NOT_ASK };
}

/**
 * Asks the source to text a code to the number, after the connector has read
 * the number as one it accepts and the account's hour has room for it. A
 * refused number or a full hour never reaches the source, which is what keeps
 * the form from being a way to send texts at the operator's cost.
 */
export async function sendTextedCode(
  env: Env,
  accountName: string,
  workspaceId: string,
  connectorId: string,
  typed: string,
  now: Date,
): Promise<{ done: true; number: string } | Refusal> {
  const found = await offered(env, connectorId);
  if (!found) return UNKNOWN;
  const { texted } = found;
  const account = await openAccount(env, accountName);
  if (!(await account.workspaces()).some((workspace) => workspace.id === workspaceId)) return NO_SUCH_WORKSPACE;

  const read = texted.connector.numberFrom(typed);
  if ('refused' in read) return { done: false, status: 400, error: read.refused };
  if ((await account.textedCodeAsked(connectorId, texted.auth.codesPerHour, now.toISOString())) === 'too-many') {
    return TOO_MANY_CODES;
  }
  try {
    await texted.connector.sendCode(read.number);
  } catch (error) {
    return couldNotAsk(connectorId, error);
  }
  return { done: true, number: read.number };
}

/**
 * Connects the number to the Workspace if, and only if, the source approves
 * the code. **The credential sealed is empty**: nothing about a phone is
 * secret, and the connection table has no null credential to hold instead.
 * Confirming the same number again refreshes the row rather than adding one,
 * as connecting the same account again does.
 */
export async function confirmTextedCode(
  env: Env,
  accountName: string,
  workspaceId: string,
  connectorId: string,
  typed: string,
  code: string,
  now: Date,
): Promise<{ done: true; number: string } | Refusal> {
  const found = await offered(env, connectorId);
  if (!found) return UNKNOWN;
  const { texted, key } = found;
  const account = await openAccount(env, accountName);
  if (!(await account.workspaces()).some((workspace) => workspace.id === workspaceId)) return NO_SUCH_WORKSPACE;

  // The same reading as sending: a number that could not have been sent a code is refused without asking.
  const read = texted.connector.numberFrom(typed);
  if ('refused' in read) return { done: false, status: 400, error: read.refused };
  const number = read.number;

  let checked;
  try {
    checked = await texted.connector.checkCode(number, code.trim());
  } catch (error) {
    return couldNotAsk(connectorId, error);
  }
  if (checked === 'wrong') return WRONG_CODE;
  if (checked === 'gone') return CODE_GONE;

  const connectedAt = now.toISOString();
  await account.applyChange('connect_source_account', {
    commandId: uuidv7(),
    issuedAt: connectedAt,
    workspaceId,
    sourceAccountId: uuidv7(),
    connectorId,
    externalAccountKey: number,
    displayName: number,
    ...(await seal('', key)),
  });
  await rememberConnectionAfterStoring(env, { accountName, workspaceId }, connectorId, number, connectedAt);
  return { done: true, number };
}
