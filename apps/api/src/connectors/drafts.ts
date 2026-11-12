import { SourceError, type Connector, type DraftWaiting, type OnDemandHost } from '@cockpit/connector-sdk';
import type { Mailbox } from '@cockpit/shared';
import type { Env } from '../env.js';
import { ConflictInAccountError, NotFoundInAccountError, RefusedByAccountError, type Account } from '../accounts/index.js';
import type { DraftClick } from '../accounts/drafts.js';
import { GUEST_ACCOUNT_NAME } from '../accounts/new-user.js';
import { aiFor, type ReplyBrief } from '../ai/index.js';
import { standInReply } from '../ai/reply-stand-in.js';
import { REPLY_READ } from '../ai/prompts/draft-a-reply.v1.js';
import { hasClaudeKey } from '../gateway/environment.js';
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

/** What a click is told where Claude cannot draft here: no key it may spend, or the shared guest account. */
export const CLAUDE_CANNOT_DRAFT = 'Claude cannot draft here.';

/** Why a draft was not made where Claude failed or passed its cut-off. */
export const CLAUDE_DID_NOT_DRAFT = 'Claude could not draft it.';

/**
 * Whether Claude may write a draft for this account: the environment has a key
 * it may spend, and the account is not the guest's, which everybody shares and
 * which never calls the model (issue 1730).
 */
export function claudeMayDraft(env: Env, accountName: string): boolean {
  return (env.DRAFT_STAND_IN === 'true' || hasClaudeKey(env)) && accountName !== GUEST_ACCOUNT_NAME;
}

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
  claudeMay = false,
): Mailbox[] {
  const registered = new Map(connectors(env).map((one) => [one.manifest.id, one]));
  return connections
    .filter((one) => startsConversations(registered.get(one.connectorId), one.follows))
    .map((one) => ({
      sourceAccountId: one.id,
      connectorId: one.connectorId,
      name: one.displayName,
      // Offered only where the connector can read a conversation for Claude (Gmail and Outlook).
      ...(claudeMay && registered.get(one.connectorId)?.readConversationForReply ? { claudeDrafts: true as const } : {}),
    }));
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
  claude?: { points: string },
): Promise<string> {
  // Refused before anything is logged, asked or paid for.
  if (claude && !claudeMayDraft(env, accountName)) throw new RefusedByAccountError(CLAUDE_CANNOT_DRAFT);
  const held = (await account.sourceAccounts(ask.workspaceId)).find((one) => one.id === ask.sourceAccountId);
  const connector = held ? getConnector(env, held.connectorId) : undefined;
  if (!held || !startsConversations(connector, held.follows ?? null)) {
    throw new NotFoundInAccountError(`no connection ${ask.sourceAccountId} of this workspace makes drafts`);
  }
  // Refused with the rest, before the Item is marked as starting.
  if (claude && !connector!.readConversationForReply) throw new RefusedByAccountError(CLAUDE_CANNOT_DRAFT);
  const named = JSON.stringify([accountName, ask.clickId]);
  const click = {
    clickId: ask.clickId,
    recordedId: await derivedUuid(`draft-recorded:${named}`),
    droppedId: await derivedUuid(`draft-dropped:${named}`),
    replacedId: await derivedUuid(`draft-replaced:${named}`),
  };
  const where = { workspaceId: ask.workspaceId, itemId: ask.itemId, sourceAccountId: ask.sourceAccountId, ...click };
  let wanted = await account.wantDraft({ ...ask, ...click });
  if (wanted.status === 'look') {
    const look = wanted;
    const lookHost = onDemandHost(env, account, ask.sourceAccountId, sealedIn(look), look.state, look.connectorId);
    // Draft with Claude on Claude's own draft: its words are read back with the look, to rewrite it if unchanged (issue 1732).
    const redrafting = claude && look.claude && connector!.rewriteDraft ? { ...look.claude, points: claude.points } : null;
    let found;
    try {
      if (!connector!.findDraft) throw new SourceError('this mailbox cannot be asked for the draft started before');
      found = redrafting ? await connector!.findDraft(lookHost, look.draft, { text: true }) : await connector!.findDraft(lookHost, look.draft);
    } catch (error) {
      // Nothing was changed, so nothing is put back.
      if (error instanceof SourceError) throw new DraftNotMadeError(error.message, false);
      logged(look.connectorId, 'error', 'a draft could not be looked for', error instanceof Error ? error.message : String(error));
      throw new DraftNotMadeError('something went wrong', false);
    }
    if (found && 'draftLink' in found) {
      if (!redrafting) return found.draftLink;
      return claudeRedrafts(env, account, connector!, lookHost, { ...where, accountName }, look.draft, { ...found, ...redrafting });
    }
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
  let draft;
  let body: string | undefined;
  try {
    body = claude
      ? await claudeWritesTheBody(env, connector!, host, accountName, ask.itemId, { title: wanted.subject, description: wanted.description, points: claude.points }, wanted.replyIn)
      : undefined;
    draft = await connector!.makeDraft!(host, { subject: wanted.subject, replyIn: wanted.replyIn, ...(body === undefined ? {} : { body }) });
  } catch (error) {
    // Nothing was made: the Item has its status back, and the person is told why.
    await account.dropDraft({ ...where, replyIn: wanted.replyIn });
    if (error instanceof SourceError) throw new DraftNotMadeError(error.message);
    logged(wanted.connectorId, 'error', 'a draft could not be made', error instanceof Error ? error.message : String(error));
    throw new DraftNotMadeError('something went wrong');
  }
  // Made: what fails from here leaves a draft the mailbox holds and the Item In
  // progress with no link - the design's worst case, which a later click mends.
  // Claude's draft is recorded with the fingerprint of what Claude wrote (issue 1732).
  await account.recordDraft({ ...where, draft, claudeDigest: body === undefined ? null : await fingerprintOf(body) });
  return draft.draftLink;
}

/**
 * Draft with Claude asked again on Claude's own unsent draft ("Mail follow-up:
 * a Claude draft looks like any other and cannot be redone…", issue 1732),
 * once the look has found it still there and read its words back:
 *
 * - **Unchanged** (its words match the fingerprint, spacing aside): Claude
 *   writes it again and the connector rewrites the same draft in place, then
 *   the new fingerprint is recorded. The answer is the same draft's link.
 * - **Edited in the mailbox, or unreadable**: no Claude call, nothing written
 *   to the mailbox; the fingerprint is cleared, so the draft is yours from
 *   now on, and the answer opens it.
 *
 * A Claude call or a rewrite that fails changes nothing: Claude's draft and its
 * fingerprint stay, nothing was put back, and the person is told why. A
 * rewrite whose fingerprint is not then recorded leaves a draft whose words no
 * longer match, which the next ask keeps as yours. Recorded under the click's
 * derived id, so the click resent opens the draft without a second rewrite.
 */
async function claudeRedrafts(
  env: Env,
  account: Account,
  connector: Connector,
  host: OnDemandHost,
  where: { accountName: string; workspaceId: string; itemId: string; sourceAccountId: string } & DraftClick,
  waiting: DraftWaiting,
  found: { draftLink: string; text?: string | null | undefined; digest: string; subject: string; description: string | null; points: string },
): Promise<string> {
  const { accountName, ...record } = where;
  const draft = { draftId: waiting.draftId, conversationId: waiting.conversationId, draftLink: found.draftLink, conversationLink: found.draftLink };
  const was = found.text ?? null;
  if (was === null || (await fingerprintOf(was)) !== found.digest) {
    await account.recordDraft({ ...record, draft, claudeDigest: null });
    return found.draftLink;
  }
  let rewritten: { outcome: 'rewritten' | 'changed'; body: string };
  try {
    // A conversation the draft started holds nothing but the draft: none to read.
    const body = await claudeWritesTheBody(
      env,
      connector,
      host,
      accountName,
      where.itemId,
      { title: found.subject, description: found.description, points: found.points },
      waiting.after === null ? null : waiting.conversationId,
    );
    rewritten = { outcome: await connector.rewriteDraft!(host, waiting, { was, body }), body };
  } catch (error) {
    // Nothing was changed: Claude's draft and its fingerprint stay, and nothing is put back.
    if (error instanceof SourceError) throw new DraftNotMadeError(error.message, false);
    logged(connector.manifest.id, 'error', 'a draft could not be written again', error instanceof Error ? error.message : String(error));
    throw new DraftNotMadeError('something went wrong', false);
  }
  const claudeDigest = rewritten.outcome === 'rewritten' ? await fingerprintOf(rewritten.body) : null;
  await account.recordDraft({ ...record, draft, claudeDigest });
  return found.draftLink;
}

/**
 * The fingerprint of a draft's text (issue 1732): SHA-256, in hex, of the text
 * with every run of spacing made one space and the ends trimmed, so a mailbox
 * that changes its line breaks, or keeps it as HTML read back as text, still
 * matches the words Claude wrote.
 */
export async function fingerprintOf(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text.replace(/\s+/g, ' ').trim()));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * The body of a reply, written while the person waits (issue 1730): the
 * conversation's latest messages read from the source (none for an email that
 * starts one), then one Claude call through the gateway. **Claude gets only
 * words** - the recipient, subject and thread are the mailbox's, made by the
 * connector, never by Claude. A failed or late call, or an answer that is no
 * body, makes no draft.
 */
async function claudeWritesTheBody(
  env: Env,
  connector: Connector,
  host: OnDemandHost,
  accountName: string,
  itemId: string,
  brief: { title: string; description: string | null; points: string },
  replyIn: string | null,
): Promise<string> {
  // The local stacks' stand-in is checked first, so a stack deliberately given one never spends a key.
  const ai = env.DRAFT_STAND_IN === 'true' ? { writeAReply: async (asked: ReplyBrief) => standInReply(asked) } : aiFor(env);
  if (!ai || !connector.readConversationForReply) throw new SourceError(CLAUDE_DID_NOT_DRAFT);
  const messages = replyIn === null ? [] : await connector.readConversationForReply(host, replyIn, REPLY_READ);
  let written;
  try {
    written = await ai.writeAReply({ ...brief, messages }, { accountName, itemId, triggeredBy: 'draft-asked-in-app' });
  } catch (error) {
    logged(connector.manifest.id, 'warn', 'Claude could not write a draft', error instanceof Error ? error.message : String(error));
    throw new SourceError(CLAUDE_DID_NOT_DRAFT);
  }
  if ('discarded' in written) {
    logged(connector.manifest.id, 'warn', 'Claude wrote no usable draft', written.discarded);
    throw new SourceError(CLAUDE_DID_NOT_DRAFT);
  }
  return written.body;
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
