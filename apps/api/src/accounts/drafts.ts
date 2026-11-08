import { and, desc, eq } from 'drizzle-orm';
import { DRAFT_STARTING_PREFIX, isDraftStarting, isLinkedInConversation, workspaceIsDecided } from '@cockpit/shared';
import type { DraftMade } from '@cockpit/connector-sdk';
import type { AccountDb } from './client.js';
import { DraftRefusedError, ItemNotFoundError, SourceAccountNotFoundError, runCommand } from './command-service.js';
import { getItem, getSourceAccount } from './repo.js';
import { commands, connectorAccounts, itemConversations, pulledConnections } from './schema.js';
import { couldStillBeActedOn } from '../domain/duplicates.js';

/**
 * The store's half of *Email…* and *Reply…* ("Email… makes a Gmail draft the
 * Item then follows", issue 1708), the one path a person waits on an outside
 * source for. The Worker asks for the draft between `wantDraft` and
 * `recordDraft` (or `dropDraft`), and opens the credential, which the store
 * never does.
 *
 * **One click is one draft at most, plus one orphan.** `wantDraft` logs
 * `start_draft` under the click's own id before the source is asked; the click
 * resent answers the link `recordDraft` logged under an id derived from it,
 * makes one more draft where none was recorded, and makes nothing where the
 * first attempt failed. The derived ids are the Worker's to compute, a digest
 * being asynchronous and every call here synchronous.
 */

/** The ids one click's changes are logged under: its own, and the three derived from it. */
export interface DraftClick {
  clickId: string;
  recordedId: string;
  droppedId: string;
  /** What a draft recorded before, found gone at the click, is dropped under (issue 1720). */
  replacedId: string;
}

/** What the Worker needs to ask the connection's source anything: its credential, sealed, and the connector's own state. */
interface AskingTheSource {
  connectorId: string;
  externalAccountKey: string;
  choice: string | null;
  sealedCredential: string;
  credentialNonce: string;
  /** The connector's private state as its last check saved it, for it to read. */
  state: unknown;
}

/**
 * What `wantDraft` answers: the draft already made, a click that already
 * failed, a draft recorded before for the Worker to look for at the source
 * first (issue 1720), or what the Worker needs to make one.
 */
export type DraftWantedAnswer =
  | { status: 'recorded'; link: string }
  | { status: 'failed' }
  | ({ status: 'look'; draftId: string } & AskingTheSource)
  | ({ status: 'make'; subject: string; replyIn: string | null } & AskingTheSource);

/** Refused: a LinkedIn conversation is answered in LinkedIn, which no mailbox reaches. */
export const LINKEDIN_HAS_NO_DRAFT = 'A LinkedIn conversation is answered in LinkedIn.';
/** Refused: one conversation per Item, and this one follows a conversation another connection reads. */
export const FOLLOWS_ELSEWHERE = 'This item already follows a conversation in another mailbox.';
/** Refused: a draft made for this conversation is still unsent. */
export const DRAFT_ALREADY_STARTED = 'A draft is already started in this conversation. Send or delete it first.';

/**
 * *Email…* or *Reply…* pressed: the draft this click made already, or what the
 * Worker does next.
 *
 * **A draft recorded before and still waited on is looked for first** ("Conversation
 * follow-up: Open, previews, drafts and Check now misbehave on real Gmail and
 * Outlook mailboxes", issue 1720): answered `look`, changing nothing, for the
 * Worker to ask the source whether it is still there. Still there, the Worker
 * opens it and nothing changes. Gone or in the bin, the Worker asks again with
 * `replacing` naming it: that draft is dropped as deleted unsent, under the
 * click's derived id, and a new one made as any click makes one - a second
 * draft beside one still there would leave the first untracked.
 */
export function wantDraft(
  db: AccountDb,
  accountName: string,
  ask: { workspaceId: string; itemId: string; sourceAccountId: string; replacing?: string } & DraftClick,
  at: string,
): DraftWantedAnswer {
  const connection = getSourceAccount(db, accountName, ask.sourceAccountId);
  if (!connection || connection.workspaceId !== ask.workspaceId || connection.externalAccountKey === null) {
    throw new SourceAccountNotFoundError(ask.sourceAccountId);
  }
  const item = getItem(db, accountName, ask.itemId);
  if (!item || !couldStillBeActedOn(item) || (workspaceIsDecided(item) && item.workspaceId !== ask.workspaceId)) {
    throw new ItemNotFoundError(ask.itemId);
  }
  const recorded = loggedPayload(db, accountName, ask.recordedId) as { draft?: { link?: unknown } } | null;
  if (recorded) return typeof recorded.draft?.link === 'string' ? { status: 'recorded', link: recorded.draft.link } : { status: 'failed' };
  if (loggedPayload(db, accountName, ask.droppedId)) return { status: 'failed' };

  const place = { connectorId: connection.connectorId, externalAccountKey: connection.externalAccountKey };
  let here = followedHere(db, accountName, ask.itemId, place);
  // A recorded draft still waited on (not one whose wait a turn has ended since).
  const waitedOn = (row: typeof here) => (row && row.draftId !== null && row.statusBeforeDraft !== null ? row.draftId : null);
  const recordedDraft = waitedOn(here);
  if (recordedDraft !== null && ask.replacing !== recordedDraft) {
    return { status: 'look', draftId: recordedDraft, ...askingTheSource(db, accountName, ask.sourceAccountId, { ...place, choice: connection.choice }) };
  }
  if (recordedDraft !== null) {
    // Found gone at the source: deleted unsent, as a check finding it gone drops it.
    runCommand(db, accountName, 'drop_draft', {
      commandId: ask.replacedId,
      issuedAt: at,
      workspaceId: ask.workspaceId,
      itemId: ask.itemId,
      ...place,
      conversationId: here!.conversationId,
      draftId: recordedDraft,
    });
    here = followedHere(db, accountName, ask.itemId, place);
    // Another draft recorded meanwhile is the one to finish.
    if (waitedOn(here) !== null) throw new DraftRefusedError(DRAFT_ALREADY_STARTED);
  }
  const replyIn = here?.conversationId ?? null;

  runCommand(db, accountName, 'start_draft', {
    commandId: ask.clickId,
    issuedAt: at,
    workspaceId: ask.workspaceId,
    itemId: ask.itemId,
    ...place,
    replyIn,
  });
  return { status: 'make', subject: item.title, replyIn, ...askingTheSource(db, accountName, ask.sourceAccountId, { ...place, choice: connection.choice }) };
}

/**
 * The conversation an Item follows at this connection, or none - refused where
 * it follows a LinkedIn conversation or one another connection reads. Stopped
 * ones too: the form still shows one and offers Reply… in it, and the draft
 * recorded follows it again.
 */
function followedHere(db: AccountDb, accountName: string, itemId: string, at: { connectorId: string; externalAccountKey: string }) {
  const followed = db
    .select({
      connectorId: itemConversations.connectorId,
      externalAccountKey: itemConversations.externalAccountKey,
      conversationId: itemConversations.conversationId,
      draftId: itemConversations.draftId,
      statusBeforeDraft: itemConversations.statusBeforeDraft,
    })
    .from(itemConversations)
    .where(and(eq(itemConversations.tenantId, accountName), eq(itemConversations.itemId, itemId)))
    .orderBy(desc(itemConversations.lastAt))
    .all()
    .filter((one) => !isDraftStarting(one));
  if (followed.some((one) => isLinkedInConversation(one))) throw new DraftRefusedError(LINKEDIN_HAS_NO_DRAFT);
  const here = followed.find((one) => one.connectorId === at.connectorId && one.externalAccountKey === at.externalAccountKey);
  if (!here && followed.length > 0) throw new DraftRefusedError(FOLLOWS_ELSEWHERE);
  return here;
}

/** The connection's sealed credential and its connector's state, which the Worker asks the source with. */
function askingTheSource(
  db: AccountDb,
  accountName: string,
  sourceAccountId: string,
  connection: { connectorId: string; externalAccountKey: string; choice: string | null },
): AskingTheSource {
  const sealed = db
    .select({ sealedCredential: connectorAccounts.encryptedCredential, credentialNonce: connectorAccounts.credentialNonce })
    .from(connectorAccounts)
    .where(and(eq(connectorAccounts.tenantId, accountName), eq(connectorAccounts.id, sourceAccountId)))
    .get()!;
  const state = db
    .select({ state: pulledConnections.state })
    .from(pulledConnections)
    .where(and(eq(pulledConnections.tenantId, accountName), eq(pulledConnections.sourceAccountId, sourceAccountId)))
    .get()?.state;
  return {
    connectorId: connection.connectorId,
    externalAccountKey: connection.externalAccountKey,
    choice: connection.choice,
    ...sealed,
    state: state == null ? null : JSON.parse(state),
  };
}

/**
 * The draft the source made, recorded through `follow_conversation`, the one
 * change every way an Item comes to follow a conversation takes: the Item now
 * follows it, waiting on the draft. Logged under the click's derived id, so
 * recording it twice records it once.
 */
export function recordDraft(
  db: AccountDb,
  accountName: string,
  record: { workspaceId: string; itemId: string; sourceAccountId: string; draft: DraftMade } & DraftClick,
  at: string,
): void {
  const connection = getSourceAccount(db, accountName, record.sourceAccountId);
  if (!connection || connection.externalAccountKey === null) throw new SourceAccountNotFoundError(record.sourceAccountId);
  runCommand(db, accountName, 'follow_conversation', {
    commandId: record.recordedId,
    issuedAt: at,
    workspaceId: record.workspaceId,
    itemId: record.itemId,
    connectorId: connection.connectorId,
    externalAccountKey: connection.externalAccountKey,
    conversationId: record.draft.conversationId,
    link: record.draft.conversationLink,
    latest: { by: 'you', from: null, at, excerpt: '' },
    messageCount: 1,
    startedAt: at,
    withWhom: null,
    connectionDays: connection.dueInDays,
    draft: { id: record.draft.draftId, startedBy: record.clickId, link: record.draft.draftLink },
  });
}

/**
 * A draft the source would not make, through `drop_draft`: the Item's status
 * put back and the row that stood in for a new conversation gone. Logged under
 * the click's derived id, so the same click resent afterwards is told it failed.
 */
export function dropDraft(
  db: AccountDb,
  accountName: string,
  drop: { workspaceId: string; itemId: string; sourceAccountId: string; replyIn: string | null } & DraftClick,
  at: string,
): void {
  const connection = getSourceAccount(db, accountName, drop.sourceAccountId);
  if (!connection || connection.externalAccountKey === null) throw new SourceAccountNotFoundError(drop.sourceAccountId);
  runCommand(db, accountName, 'drop_draft', {
    commandId: drop.droppedId,
    issuedAt: at,
    workspaceId: drop.workspaceId,
    itemId: drop.itemId,
    connectorId: connection.connectorId,
    externalAccountKey: connection.externalAccountKey,
    conversationId: drop.replyIn ?? `${DRAFT_STARTING_PREFIX}${drop.clickId}`,
    draftId: null,
  });
}

/**
 * Saves a credential the source rotated while a draft was made, only while the
 * stored one is still `was`, the one opened - as a run's is saved
 * (`resealPulledCredential`), with no run to hold.
 */
export function resealCredential(
  db: AccountDb,
  accountName: string,
  sourceAccountId: string,
  was: { sealedCredential: string; credentialNonce: string },
  sealed: { sealedCredential: string; credentialNonce: string },
): 'saved' | 'not saved' {
  const saved = db
    .update(connectorAccounts)
    .set({ encryptedCredential: sealed.sealedCredential, credentialNonce: sealed.credentialNonce })
    .where(
      and(
        eq(connectorAccounts.tenantId, accountName),
        eq(connectorAccounts.id, sourceAccountId),
        eq(connectorAccounts.encryptedCredential, was.sealedCredential),
        eq(connectorAccounts.credentialNonce, was.credentialNonce),
      ),
    )
    .returning({ id: connectorAccounts.id })
    .all();
  return saved.length > 0 ? 'saved' : 'not saved';
}

/** A logged change's payload by its id, or null where none was logged. */
function loggedPayload(db: AccountDb, accountName: string, commandId: string): unknown {
  const row = db
    .select({ payload: commands.payload })
    .from(commands)
    .where(and(eq(commands.tenantId, accountName), eq(commands.commandId, commandId)))
    .get();
  return row ? JSON.parse(row.payload) : null;
}
