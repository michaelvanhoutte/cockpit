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

/**
 * Why a draft was not made, said to the person: beside the Item put back where
 * `putBack`, and alone where nothing had changed - the source not answering
 * whether the draft recorded before is still there (issue 1720).
 */
export class DraftNotMadeError extends Error {
  constructor(
    why: string,
    readonly putBack = true,
  ) {
    super(`Couldn't make the draft: ${why}`);
    this.name = 'DraftNotMadeError';
  }
}

/** What a click resent after its draft failed is told. */
export const DRAFT_FAILED_BEFORE = 'This draft was not made. Try again.';

/**
 * What a click is told where the draft an earlier click made was sent since the
 * last check: the check is asked for, and once it has read the sent message the
 * Item follows the conversation again and Reply… makes a new draft (issue 1720).
 */
export const DRAFT_SENT = 'That draft was sent. Cockpit shows it in a moment; press Reply… again after that.';

/** What a click is told where another click recorded a draft while this one looked for the one before. */
export const DRAFT_RECORDED_MEANWHILE = 'Another draft was started meanwhile. Try again to open it.';

/** The sealed credential a store's answer carries. */
function sealedIn(answer: Sealed): Sealed {
  return { sealedCredential: answer.sealedCredential, credentialNonce: answer.credentialNonce };
}

/** Whether a connection may take an on-demand mail action (`method`: making a draft, or listing sent mail): its connector has it, under the choice it follows. */
export function startsConversations(
  connector: Connector | undefined,
  follows: string | null,
  method: 'makeDraft' | 'listRecentSent' = 'makeDraft',
): boolean {
  const under = connector?.manifest.startsConversations?.underChoices;
  return Boolean(connector?.[method] && under && follows !== null && under.includes(follows));
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
 *
 * **A draft an earlier click recorded, still waited on, is looked for first**
 * ("Conversation follow-up: Open, previews, drafts and Check now misbehave on
 * real Gmail and Outlook mailboxes", issue 1720): still there unsent, its link
 * is the answer and nothing changes; sent, nothing changes either, the click is
 * refused and the connection's check asked for, so the sent message is read
 * within seconds - dropped as deleted, the Item would forget a reply it is about
 * to read; gone or in the bin, the store drops it as deleted unsent and a new
 * one is made.
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
    replacedId: await derivedUuid(`draft-replaced:${named}`),
  };
  let wanted = await account.wantDraft({ ...ask, ...click });
  if (wanted.status === 'look') {
    const look = wanted;
    const lookHost = onDemandHost(env, account, ask.sourceAccountId, sealedIn(look), look.state, look.connectorId);
    let found;
    try {
      if (!connector!.findDraft) throw new SourceError('this mailbox cannot be asked for the draft started before');
      found = await connector!.findDraft(lookHost, look.draft);
    } catch (error) {
      // Nothing was changed, so nothing is put back.
      if (error instanceof SourceError) throw new DraftNotMadeError(error.message, false);
      logged(look.connectorId, 'error', 'a draft could not be looked for', error instanceof Error ? error.message : String(error));
      throw new DraftNotMadeError('something went wrong', false);
    }
    if (found && 'draftLink' in found) return found.draftLink;
    if (found) {
      // Changes nothing: the check records the sent message, as it would have at its next turn.
      await account.checkNow(ask.workspaceId, ask.sourceAccountId).catch(() => undefined);
      throw new ConflictInAccountError(DRAFT_SENT);
    }
    wanted = await account.wantDraft({ ...ask, ...click, replacing: look.draft.draftId });
    // Only a draft recorded meanwhile by another click could be looked for again: that one is not this click's to replace.
    if (wanted.status === 'look') throw new ConflictInAccountError(DRAFT_RECORDED_MEANWHILE);
  }
  if (wanted.status === 'recorded') return wanted.link;
  if (wanted.status === 'failed') throw new ConflictInAccountError(DRAFT_FAILED_BEFORE);

  const host = onDemandHost(env, account, ask.sourceAccountId, sealedIn(wanted), wanted.state, wanted.connectorId);
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
export function onDemandHost(
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

export function logged(connectorId: string, level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: unknown): void {
  const line = JSON.stringify({ level, connector: connectorId, message, data });
  if (level === 'error') console.error(line);
  else console.log(line);
}
