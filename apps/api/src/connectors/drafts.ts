import { SourceError, type Connector, type OnDemandHost } from '@cockpit/connector-sdk';
import type { Mailbox } from '@cockpit/shared';
import type { Env } from '../env.js';
import { ConflictInAccountError, NotFoundInAccountError, type Account } from '../accounts/index.js';
import { derivedUuid } from '../domain/derived-uuid.js';
import { open, seal, sealingKey, type Sealed } from './credential-crypto.js';
import { connectors, getConnector } from './registry.js';

/**
 * *Email…* and *Reply…* in the Worker ("Email… makes a Gmail draft the Item
 * then follows", issue 1708): the one place a person's request waits on an
 * outside source. The store logs the click before the source is asked and the
 * draft after; the Worker opens the credential between them, as a check's run
 * does, and the connector makes the draft.
 *
 * **Not measured.** The spike that was to time a draft call against a test
 * mailbox (issue 1704) was skipped, so the 2 s the design budgets for the tab
 * is unproven; built to the design as it stands.
 */

/** Why a draft was not made, said to the person beside the Item put back. */
export class DraftNotMadeError extends Error {
  constructor(why: string) {
    super(`Couldn't make the draft: ${why}`);
    this.name = 'DraftNotMadeError';
  }
}

/** What a click resent after its draft failed is told. */
export const DRAFT_FAILED_BEFORE = 'This draft was not made. Try again.';

/** Whether a connection may start a conversation from an Item: its connector makes drafts, under the choice it follows. */
export function startsConversations(connector: Connector | undefined, follows: string | null): boolean {
  const under = connector?.manifest.startsConversations?.underChoices;
  return Boolean(connector?.makeDraft && under && follows !== null && under.includes(follows));
}

/** The Workspace's connections *Email…* may use, oldest first, as the Workspace read carries them. */
export function mailboxesOf(
  env: Env,
  connections: readonly { id: string; connectorId: string; displayName: string; follows: string | null }[],
): Mailbox[] {
  const registered = new Map(connectors(env).map((one) => [one.manifest.id, one]));
  return connections
    .filter((one) => startsConversations(registered.get(one.connectorId), one.follows))
    .map((one) => ({ sourceAccountId: one.id, connectorId: one.connectorId, name: one.displayName }));
}

/**
 * Makes the draft one click asked for, and answers where it opens. The click's
 * own id makes resending it safe: a draft already recorded is answered as it
 * is; one asked for and never recorded is asked for again, the worst case
 * being one draft the mailbox holds that Cockpit does not know of.
 */
export async function makeTheDraft(
  env: Env,
  account: Account,
  accountName: string,
  ask: { workspaceId: string; itemId: string; sourceAccountId: string; clickId: string },
): Promise<string> {
  const held = (await account.sourceAccounts(ask.workspaceId)).find((one) => one.id === ask.sourceAccountId);
  const connector = held ? getConnector(env, held.connectorId) : undefined;
  if (!held || !startsConversations(connector, held.follows ?? null)) {
    throw new NotFoundInAccountError(`no connection ${ask.sourceAccountId} of this workspace makes drafts`);
  }
  const named = JSON.stringify([accountName, ask.clickId]);
  const click = {
    clickId: ask.clickId,
    recordedId: await derivedUuid(`draft-recorded:${named}`),
    droppedId: await derivedUuid(`draft-dropped:${named}`),
  };
  const wanted = await account.wantDraft({ ...ask, ...click });
  if (wanted.status === 'recorded') return wanted.link;
  if (wanted.status === 'failed') throw new ConflictInAccountError(DRAFT_FAILED_BEFORE);

  const sealed: Sealed = { sealedCredential: wanted.sealedCredential, credentialNonce: wanted.credentialNonce };
  const host = onDemandHost(env, account, ask.sourceAccountId, sealed, wanted.state, wanted.connectorId);
  const where = { workspaceId: ask.workspaceId, itemId: ask.itemId, sourceAccountId: ask.sourceAccountId, ...click };
  let draft;
  try {
    draft = await connector!.makeDraft!(host, { subject: wanted.subject, replyIn: wanted.replyIn });
  } catch (error) {
    // Nothing was made: the Item has its status back, and the person is told why.
    await account.dropDraft({ ...where, replyIn: wanted.replyIn });
    if (error instanceof SourceError) throw new DraftNotMadeError(error.message);
    logged(wanted.connectorId, 'error', 'a draft could not be made', error instanceof Error ? error.message : String(error));
    throw new DraftNotMadeError('something went wrong');
  }
  // Made: what fails from here leaves a draft the mailbox holds and the Item In
  // progress with no link - the design's worst case, which a later click mends.
  await account.recordDraft({ ...where, draft });
  return draft.draftLink;
}

/** The connection's credential opened in the Worker, a rotated one sealed back only over the one opened. */
function onDemandHost(
  env: Env,
  account: Account,
  sourceAccountId: string,
  sealed: Sealed,
  state: unknown,
  connectorId: string,
): OnDemandHost {
  let opened: { sealed: Sealed; credential: string } | null = null;
  return {
    async getCredentials() {
      if (opened) return { credential: opened.credential };
      const credential = await open(sealed, await keyOf(env));
      if (credential === null) throw new Error("the stored credential could not be opened with this environment's key");
      opened = { sealed, credential };
      return { credential };
    },
    async setCredentials(credentials) {
      const credential = credentials.credential;
      if (!credential) throw new Error(`the ${connectorId} connector handed back a credential with nothing in it`);
      const was = opened?.sealed ?? sealed;
      const next = await seal(credential, await keyOf(env));
      if ((await account.resealCredential(sourceAccountId, was, next)) === 'saved') opened = { sealed: next, credential };
    },
    getState: async () => state,
    log: (level, message, data) => logged(connectorId, level, message, data),
  };
}

async function keyOf(env: Env): Promise<CryptoKey> {
  const key = await sealingKey(env.CONNECTOR_CREDENTIAL_KEY);
  if (!key) throw new Error('this environment has no key to open a stored credential with');
  return key;
}

function logged(connectorId: string, level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: unknown): void {
  const line = JSON.stringify({ level, connector: connectorId, message, data });
  if (level === 'error') console.error(line);
  else console.log(line);
}
