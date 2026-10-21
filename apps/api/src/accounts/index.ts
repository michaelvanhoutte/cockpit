import type {
  CommandName,
  CommandPayload,
  CommandResult,
  ConnectionHistory,
  Item,
  Panel,
  ServerEvent,
  SourceAccount,
  Workspace,
  RememberedSentenceView,
} from '@cockpit/shared';
import type { Env } from '../env.js';
import { GUEST_ACCOUNT_NAME } from './new-user.js';
import {
  accountIsRegistered,
  accountOwnedBy,
  registeredAccountNames,
  endSignInsOf,
  removeFromRegister,
  whoCanBeDeleted,
  whoHoldsTheGuestAccount,
} from './register.js';
import { describeForeignRows, type AccountBackup } from './backup.js';
import { ALLOWANCE_SPENT_MESSAGE } from './allowance.js';
import type { RestoreReport } from './rpc.js';
import type { AccountSnapshot, Answer } from './answer.js';
import type { ClaudeProposalContext, SendToOfferOn, UnfiledCandidate } from './repo.js';
import type { AttachmentForDownload } from '../domain/attachments.js';
import type { DecisionHistoryEntry } from '../domain/decision-history.js';
import type { PlaceTreeWorkspace } from '../domain/spoken-path.js';
import type { QueuedRewriteAttempt, RewriteHistoryEntryRow, RewriteOutcome } from '../domain/rewrite-history.js';
import type { TextCorrectionEntry, WhatStood } from '../domain/text-corrections.js';
import type { RefreshAsk } from './debounce.js';
import type {
  CompleteListing,
  EmittedItem,
  NamesReport,
  OpenStateWanted,
  SourceItem,
  SourceStateChange,
} from '@cockpit/connector-sdk';
import type { CheckedNow, PulledRunBegun } from './pulled.js';
import type { CheckDid, NamedOn } from '../domain/connection-history.js';
import type { NameForms } from '../domain/filing-by-name.js';

export type { AccountSnapshot } from './answer.js';
export type { AccountBackup } from './backup.js';
export {
  RegisterDisagreesError,
  RegisterRowUnusableError,
  addUser,
  changeUser,
  nobodyHere,
  registerContents,
  registeredAccountNames,
  registeredUsers,
  restoreRegister,
  setAccess,
} from './register.js';
export type { RegisterBackup, RegisterPlan } from './register.js';

/** The account is not in the register, so it has no data and never had any. */
export class AccountNotInRegisterError extends Error {
  constructor(accountName: string) {
    super(`account ${accountName} is not in the register`);
    this.name = 'AccountNotInRegisterError';
  }
}

/** A change to the account's store could not be applied; the message says which and why. */
export class AccountNotUpToDateError extends Error {
  constructor(failure: string) {
    super(failure);
    this.name = 'AccountNotUpToDateError';
  }
}

/** The free tier's daily allowance is spent; the message names the limit and no account. */
export class AllowanceSpentError extends Error {
  constructor() {
    super(ALLOWANCE_SPENT_MESSAGE);
    this.name = 'AllowanceSpentError';
  }
}

/** Something the change would create is already in the account under that name. */
export class ConflictInAccountError extends Error {
  constructor(what: string) {
    super(what);
    this.name = 'ConflictInAccountError';
  }
}

/** The request named something the product does not offer - not a collision, just not on the menu. */
export class RefusedByAccountError extends Error {
  constructor(what: string) {
    super(what);
    this.name = 'RefusedByAccountError';
  }
}

/** Something a request named does not exist in the account. */
export class NotFoundInAccountError extends Error {
  constructor(what: string) {
    super(what);
    this.name = 'NotFoundInAccountError';
  }
}

/**
 * Everything the rest of the Worker may do with an account's data. Reading and
 * writing it goes through here and nowhere else, which is what let the data
 * move stores without an excavation.
 */
export interface Account {
  workspaces(): Promise<Workspace[]>;
  snapshot(workspaceId: string): Promise<AccountSnapshot>;
  /**
   * One Item by its id, or null where this account holds no such Item - which
   * an id belonging to another account also is, every query filtering on the
   * account. Read by the enrichment job and by nothing else (issue 296): a
   * browser holds the whole workspace and has no reason to ask for one row.
   */
  item(itemId: string): Promise<Item | null>;
  /**
   * One attachment by its id, with the R2 key its bytes are stored under -
   * what the download route reads ("Attach a file to an item", issue 441).
   * Null where this account holds no such attachment, the same as `item`
   * above answers for an item.
   */
  attachmentForDownload(attachmentId: string): Promise<AttachmentForDownload | null>;
  /**
   * Whether this account already has an attachment by this id - what the
   * upload route checks before it ever writes to R2 ("Attach a file to an
   * item", issue 441).
   */
  attachmentExists(attachmentId: string): Promise<boolean>;
  /**
   * Every live Panel of one Workspace that takes items and is not flagged
   * Never propose - what a routing proposal may choose from ("Propose where a
   * captured note belongs, without filing it there", issue 298; "Keep a Panel
   * out of proposals with Never propose", issue 848). Read by the enrichment job and by nothing
   * else.
   */
  panelsThatTakeItems(workspaceId: string): Promise<Panel[]>;
  /**
   * The names of the places a capture may reach - every live Workspace where
   * `workspaceId` is null, its own otherwise - with their live Dashboards and
   * Panels ("File a capture on the panels you name, read from the spoken
   * path", issue 1116). Read by the enrichment job and by nothing else.
   */
  placeTree(workspaceId: string | null): Promise<PlaceTreeWorkspace[]>;
  /**
   * What a routing proposal reads beside the note itself, in one round trip
   * ("Learn where notes belong from where you actually file them", issue
   * 299): the most recent 50 settled decisions for one workspace whose
   * chosen panel still exists and is not flagged Never propose, oldest first,
   * and what else it has captured
   * lately and not yet filed, most recent first, `excludeItemId` left out
   * ("Cap the routing prompt to the last 50 decisions on panels that still
   * exist, and drop the correction override", issue 450). Read by the
   * enrichment job and by nothing else.
   */
  routingContext(
    workspaceId: string,
    excludeItemId: string,
  ): Promise<{ history: DecisionHistoryEntry[]; recentlyCaptured: string[] }>;
  /**
   * The distinct time zones of the account's latest captures, most recent
   * first, and none where none carried one ("Read a due date you say when you
   * capture, on your own calendar", issue 1077).
   */
  recentCapturedTimeZones(): Promise<string[]>;
  /** Whether the Item is on a live Panel already, so the proposal job leaves it alone (issue 1101). */
  itemIsFiled(itemId: string): Promise<boolean>;
  /** Where an Item stands - its Workspace, the Panels it is on, the folders sent to before - for proposing what to do with it (issue 1161). Read by the enrichment job and by nothing else. */
  claudeProposalContext(itemId: string, model: string): Promise<ClaudeProposalContext>;
  /** The send kept under a Run, with what an offer to remember a sentence is made from (issue 1163); null where none was kept. */
  sendToOfferOn(runId: string): Promise<SendToOfferOn | null>;
  /** The account's remembered sentences, newest first (issue 1164). */
  rememberedSentences(): Promise<RememberedSentenceView[]>;
  /** The open Items a sentence for this kind of source, in this Workspace or in any, may fit (issue 1163). */
  openItemsASentenceMayFit(sourceKind: string, workspaceId: string | null): Promise<string[]>;
  /**
   * What a title or description proposal reads about how this account
   * writes ("Learn how you write from the titles you correct", issue 394).
   */
  textLearningContext(): Promise<{
    promptCorrections: TextCorrectionEntry[];
    promptStood: WhatStood | null;
  }>;
  /**
   * Every item in one Workspace's Inbox with a captured note - the rest of
   * the inbox a settled filing re-proposes ("Re-propose the rest of the
   * inbox the moment you file one", issue 300). Read by the enrichment job
   * and by nothing else, the same as `panelsThatTakeItems` above.
   */
  unfiledItemsInWorkspace(
    workspaceId: string,
  ): Promise<UnfiledCandidate[]>;
  /**
   * The meaning of each candidate, and of each note filed in the Workspace
   * since `since` (`null` where `since` is) - what a filing's refresh chooses
   * which candidates to read again by ("Cut what cleaning up a captured note
   * costs", issue 887). Read by the enrichment job and by nothing else.
   */
  meaningsForRefresh(
    workspaceId: string,
    since: string | null,
    candidateIds: string[],
    model: string,
  ): Promise<{ filings: (number[] | null)[] | null; candidates: { itemId: string; reading: number[] | null }[] }>;
  /**
   * Records when one Workspace's refresh last ran, so the next weighs only
   * the filings made since. Advisory: losing it makes the next refresh
   * consider every candidate.
   */
  recordRefreshRan(refresh: string, at: string): Promise<null>;
  /** When one refresh last ran, or null where none is recorded. */
  lastRefreshRan(refresh: string): Promise<string | null>;
  /**
   * Records an ask for one refresh as the latest, and reads back the latest -
   * what debounces the settle-triggered refreshes ("Debounce the
   * settle-triggered repropose fan-out across a real time window", issue
   * 582). Written and read by the enrichment jobs and by nothing else.
   */
  recordRefreshAsk(refresh: string, ask: RefreshAsk): Promise<null>;
  latestRefreshAsk(refresh: string): Promise<RefreshAsk | null>;
  /**
   * Queues one rewrite attempt, "Pending" until `recordRewriteOutcome` below
   * settles it ("See the history of what Cockpit proposed for the Inbox's
   * items", issue 444). Written by the enrichment job (and the route that
   * fires it) and by nothing else.
   */
  queueRewriteAttempt(attempt: QueuedRewriteAttempt): Promise<null>;
  /**
   * Settles one queued rewrite attempt by its own id - a queue retry of the
   * same attempt calls this again with the same id, updating that one row
   * rather than adding another (issue 444). Written by the enrichment job and
   * by nothing else.
   */
  recordRewriteOutcome(attemptId: string, outcome: RewriteOutcome): Promise<null>;
  /**
   * Every rewrite attempt for one Workspace's items, most recent first - the
   * table opened from the Inbox's own menu (issue 444).
   */
  rewriteHistoryForWorkspace(workspaceId: string): Promise<RewriteHistoryEntryRow[]>;
  /**
   * Every rewrite attempt for one item, most recent first - the table opened
   * from that item's own menu (issue 444).
   */
  rewriteHistoryForItem(itemId: string): Promise<RewriteHistoryEntryRow[]>;
  /**
   * Writes what one Item means, and pairs it against every other Item of the
   * account that says the same thing ("Flag a captured note that says what
   * another one already said", issue 407). Written by the job that reads a note
   * and by nothing else.
   */
  rememberWhatAnItemMeans(
    itemId: string,
    model: string,
    reading: number[],
  ): Promise<'remembered' | 'no such item'>;
  /**
   * Forgets what an Item means, and every pair built on it - for an Item whose
   * two texts have been emptied and which now says nothing to compare.
   */
  forgetWhatAnItemMeans(itemId: string): Promise<null>;
  /**
   * One batch of the open Items nothing has read yet, from `after` onwards -
   * what `pnpm duplicates:backfill` walks ("Give every item already there a
   * vector", issue 409). Read by the operator's route and by nothing else.
   */
  itemsToRead(
    model: string,
    after: string | null,
    limit: number,
  ): Promise<{ id: string; title: string; description: string | null }[]>;
  /**
   * Writes what a batch of Items mean and pairs each against every Item of the
   * account that says the same thing, in one go ("Give every item already there
   * a vector", issue 409). Written by the operator's route and by nothing else.
   */
  rememberWhatTheseItemsMean(
    model: string,
    readings: readonly { itemId: string; reading: number[] }[],
  ): Promise<{ remembered: string[] }>;
  /**
   * The source accounts one Workspace has connected, oldest first, and never
   * the credential sealed in each ("Connect a Microsoft Teams source
   * account", issue 485).
   */
  sourceAccounts(workspaceId: string): Promise<SourceAccount[]>;
  /**
   * The connection one Workspace holds to an account at a source, by the key
   * that source names it with, or null ("Save a Teams message to Cockpit",
   * issue 486). What an inbound push is matched against, before anything
   * sealed is read.
   */
  connectionUnder(
    workspaceId: string,
    connectorId: string,
    externalAccountKey: string,
  ): Promise<{ id: string } | null>;
  /**
   * The sealed credential of one connection, opened by the Worker that holds
   * the key (issue 486) - read only for a push already matched to that one
   * connection.
   */
  sealedCredential(
    sourceAccountId: string,
  ): Promise<{ sealedCredential: string; credentialNonce: string; externalAccountKey: string | null } | null>;
  /** An app connected to this account calling `create_item`, under one grant ("Connect Claude to Cockpit, and capture an item from it", issue 599). */
  appCaptureArrived(grantId: string, at: string): Promise<'admitted' | 'too-many'>;
  /** A recording sent to be transcribed, counted against the account's 20 a minute (issue 1043). */
  transcriptionArrived(at: string): Promise<'admitted' | 'too-many'>;
  /** An offer to remember a sentence asked for, or Remember pressed, counted against the account's minute (issue 1163). */
  sentenceCallArrived(kind: 'offer' | 'remember', at: string): Promise<'admitted' | 'too-many'>;
  /** A code asked for a source to text, counted against the account's hour (issue 1335). */
  textedCodeAsked(connectorId: string, limit: number, at: string): Promise<'admitted' | 'too-many'>;
  /** One connection of this Workspace's history, newest line first (issue 1140). */
  connectionHistory(workspaceId: string, sourceAccountId: string): Promise<ConnectionHistory>;
  /** A delivery a source pushed to one of this account's connections, filed with its history line (issue 1144). */
  capturePushed(sourceAccountId: string, capture: CommandPayload<'capture_item'>): Promise<CommandResult>;
  /** A delivery that failed after it was attributed to a connection, as its *Failed* line (issue 1144). */
  pushFailed(sourceAccountId: string, failure: { message: string; status: number | null }): Promise<void>;
  changesSince(since: string): Promise<{ events: ServerEvent[]; cursor: string }>;
  applyChange<N extends CommandName>(
    name: N,
    payload: CommandPayload<N>,
  ): Promise<CommandResult>;
  /**
   * A delivered check of one pulled connection taking its lease, or learning
   * it does nothing ("Check a pulled connector on its cadence through the
   * generic host", issue 891).
   */
  beginPulledRun(sourceAccountId: string): Promise<PulledRunBegun>;
  /** *Check now* on one pulled connection of this Workspace - its check made due at once (issue 1143). */
  checkNow(workspaceId: string, sourceAccountId: string): Promise<CheckedNow>;
  /** What a run that took its lease may do with its connection, until it ends (issue 891). */
  pulledRun(sourceAccountId: string, runId: string): PulledRun;
}

/**
 * The store's half of one run of a pulled connection's check (issue 891):
 * every call names the run, and one that no longer holds its connection -
 * disconnected, or taken over after its lease ran out - files and saves
 * nothing.
 */
export interface PulledRun {
  state(): Promise<unknown>;
  saveState(state: unknown): Promise<'saved' | 'not this run'>;
  sealedCredential(): Promise<{ sealedCredential: string; credentialNonce: string } | null>;
  reseal(
    was: { sealedCredential: string; credentialNonce: string },
    sealed: { sealedCredential: string; credentialNonce: string },
  ): Promise<'saved' | 'not saved'>;
  fileItem(
    item: SourceItem & { sourceId: string },
    ids: { itemId: string; commandId: string },
    forms: NameForms,
  ): Promise<{ answer: EmittedItem | 'disconnected'; named: NamedOn | null }>;
  /** Records an Item's names as the source reported them, filing it by the new ones (issue 1146), and answers what each name did (issue 1197). */
  reportNames(report: NamesReport, forms: NameForms): Promise<{ answer: 'recorded' | 'unknown' | 'disconnected'; named: NamedOn | null }>;
  applySourceChange(change: SourceStateChange): Promise<{ changed: string } | 'unchanged' | 'disconnected'>;
  /** Closes the Items the connection filed under the listing's choice that it did not see, answering their ids (issues 938, 1141). */
  closeItemsNotListed(listing: CompleteListing): Promise<string[] | 'disconnected'>;
  /** Every open state a person set that the source has not confirmed (issue 893). */
  openStatesWaiting(): Promise<OpenStateWanted[]>;
  /** Clears the ones the source confirmed, each only where still what was handed over, answering the Item of each cleared (issues 893, 1141). */
  confirmOpenStates(
    confirmed: readonly OpenStateWanted[],
  ): Promise<{ cleared: { sourceId: string; itemId: string }[] } | 'not this run'>;
  /**
   * `moreToDo` asks for the next check soon, and is ignored where the run failed (issue 957).
   * `did` is what the run did, which its line of the history keeps (issue 1141).
   * `status` is the HTTP status the source answered a failure with, kept beside its message (issue 1142).
   */
  end(failing: string | null, moreToDo?: boolean, did?: CheckDid, status?: number): Promise<null>;
}

/**
 * Resolves an account to its store: check the register, then address the store
 * by name.
 *
 * **The name comes from whoever is signed in** (`src/auth/gate.ts`), which is
 * what the constant that used to stand here promised would be the only line to
 * change when signing in landed - and it was. Nothing below moved: this already
 * took the account's name as an argument, looked it up in the register and
 * addressed the store by it.
 *
 * There is deliberately no "the store is not configured" failure here.
 * Addressing a store by account name cannot fail - one binding names the whole
 * namespace and every account is a name inside it - so being absent from the
 * register is the only way to miss, which is one failure mode fewer than a
 * database per account would have had.
 */
export async function openAccount(env: Env, accountName: string): Promise<Account> {
  if (!(await accountIsRegistered(env, accountName))) {
    throw new AccountNotInRegisterError(accountName);
  }
  const store = env.ACCOUNT.get(env.ACCOUNT.idFromName(accountName));

  return {
    workspaces: async () => unwrap(await store.workspaces(accountName)),
    snapshot: async (workspaceId) => unwrap(await store.snapshot(accountName, workspaceId)),
    item: async (itemId) => unwrap(await store.item(accountName, itemId)),
    attachmentForDownload: async (attachmentId) =>
      unwrap(await store.attachmentForDownload(accountName, attachmentId)),
    attachmentExists: async (attachmentId) =>
      unwrap(await store.attachmentExists(accountName, attachmentId)),
    panelsThatTakeItems: async (workspaceId) =>
      unwrap(await store.panelsThatTakeItems(accountName, workspaceId)),
    placeTree: async (workspaceId) => unwrap(await store.placeTree(accountName, workspaceId)),
    routingContext: async (workspaceId, excludeItemId) =>
      unwrap(await store.routingContext(accountName, workspaceId, excludeItemId)),
    textLearningContext: async () => unwrap(await store.textLearningContext(accountName)),
    recentCapturedTimeZones: async () => unwrap(await store.recentCapturedTimeZones(accountName)),
    itemIsFiled: async (itemId) => unwrap(await store.itemIsFiled(accountName, itemId)),
    claudeProposalContext: async (itemId, model) => unwrap(await store.claudeProposalContext(accountName, itemId, model)),
    sendToOfferOn: async (runId) => unwrap(await store.sendToOfferOn(accountName, runId)),
    rememberedSentences: async () => unwrap(await store.rememberedSentences(accountName)),
    openItemsASentenceMayFit: async (sourceKind, workspaceId) =>
      unwrap(await store.openItemsASentenceMayFit(accountName, sourceKind, workspaceId)),
    unfiledItemsInWorkspace: async (workspaceId) =>
      unwrap(await store.unfiledItemsInWorkspace(accountName, workspaceId)),
    meaningsForRefresh: async (workspaceId, since, candidateIds, model) =>
      unwrap(await store.meaningsForRefresh(accountName, workspaceId, since, candidateIds, model)),
    recordRefreshRan: async (refresh, at) => unwrap(await store.recordRefreshRan(accountName, refresh, at)),
    lastRefreshRan: async (refresh) => unwrap(await store.lastRefreshRan(accountName, refresh)),
    recordRefreshAsk: async (refresh, ask) => unwrap(await store.recordRefreshAsk(accountName, refresh, ask)),
    latestRefreshAsk: async (refresh) => unwrap(await store.latestRefreshAsk(accountName, refresh)),
    queueRewriteAttempt: async (attempt) => unwrap(await store.queueRewriteAttempt(accountName, attempt)),
    recordRewriteOutcome: async (attemptId, outcome) =>
      unwrap(await store.recordRewriteOutcome(accountName, attemptId, outcome)),
    rewriteHistoryForWorkspace: async (workspaceId) =>
      unwrap(await store.rewriteHistoryForWorkspace(accountName, workspaceId)),
    rewriteHistoryForItem: async (itemId) => unwrap(await store.rewriteHistoryForItem(accountName, itemId)),
    rememberWhatAnItemMeans: async (itemId, model, reading) =>
      unwrap(await store.rememberWhatAnItemMeans(accountName, itemId, model, reading)),
    forgetWhatAnItemMeans: async (itemId) =>
      unwrap(await store.forgetWhatAnItemMeans(accountName, itemId)),
    itemsToRead: async (model, after, limit) =>
      unwrap(await store.itemsToRead(accountName, model, after, limit)),
    rememberWhatTheseItemsMean: async (model, readings) =>
      unwrap(await store.rememberWhatTheseItemsMean(accountName, model, readings)),
    sourceAccounts: async (workspaceId) =>
      unwrap(await store.sourceAccounts(accountName, workspaceId)),
    connectionUnder: async (workspaceId, connectorId, externalAccountKey) =>
      unwrap(await store.connectionUnder(accountName, workspaceId, connectorId, externalAccountKey)),
    sealedCredential: async (sourceAccountId) =>
      unwrap(await store.sealedCredential(accountName, sourceAccountId)),
    appCaptureArrived: async (grantId, at) => store.appCaptureArrived(grantId, at),
    transcriptionArrived: async (at) => store.transcriptionArrived(at),
    sentenceCallArrived: async (kind, at) => store.sentenceCallArrived(kind, at),
    textedCodeAsked: async (connectorId, limit, at) => store.textedCodeAsked(connectorId, limit, at),
    connectionHistory: async (workspaceId, sourceAccountId) =>
      unwrap(await store.connectionHistory(accountName, workspaceId, sourceAccountId)),
    capturePushed: async (sourceAccountId, capture) =>
      unwrap(await store.capturePushed(accountName, sourceAccountId, capture)),
    pushFailed: async (sourceAccountId, failure) => {
      unwrap(await store.pushFailed(accountName, sourceAccountId, failure));
    },
    changesSince: async (since) => unwrap(await store.changesSince(accountName, since)),
    applyChange: async (name, payload) => unwrap(await store.applyChange(accountName, name, payload)),
    beginPulledRun: async (sourceAccountId) => unwrap(await store.beginPulledRun(accountName, sourceAccountId)),
    checkNow: async (workspaceId, sourceAccountId) =>
      unwrap(await store.checkPulledConnectionNow(accountName, workspaceId, sourceAccountId)),
    pulledRun: (sourceAccountId, runId) => ({
      state: async () => unwrap(await store.pulledState(accountName, sourceAccountId, runId)),
      saveState: async (state) => unwrap(await store.savePulledState(accountName, sourceAccountId, runId, state)),
      sealedCredential: async () =>
        unwrap(await store.pulledSealedCredential(accountName, sourceAccountId, runId)),
      reseal: async (was, sealed) =>
        unwrap(await store.resealPulledCredential(accountName, sourceAccountId, runId, was, sealed)),
      fileItem: async (item, ids, forms) =>
        unwrap(await store.filePulledItem(accountName, sourceAccountId, runId, item, ids, forms)),
      reportNames: async (report, forms) =>
        unwrap(await store.reportPulledNames(accountName, sourceAccountId, runId, report, forms)),
      applySourceChange: async (change) =>
        unwrap(await store.applyPulledSourceChange(accountName, sourceAccountId, runId, change)),
      closeItemsNotListed: async (listing) =>
        unwrap(await store.closePulledItemsNotListed(accountName, sourceAccountId, runId, listing)),
      openStatesWaiting: async () => unwrap(await store.pulledOpenStatesWaiting(accountName, sourceAccountId, runId)),
      confirmOpenStates: async (confirmed) =>
        unwrap(await store.confirmPulledOpenStates(accountName, sourceAccountId, runId, confirmed)),
      end: async (failing, moreToDo, did, status) =>
        unwrap(await store.endPulledRun(accountName, sourceAccountId, runId, failing, moreToDo, did, status)),
    }),
  };
}

/** A store held a row belonging to another account, so nothing was backed up. */
export class RowsFromAnotherAccountError extends Error {
  constructor(what: string) {
    super(what);
    this.name = 'RowsFromAnotherAccountError';
  }
}

/**
 * One account's store as it stands, for a backup.
 *
 * Separate from `openAccount` rather than a sixth method on `Account`, for the
 * two reasons that make a backup different from use: it must not bring the
 * account up to date (`backup.ts`), and it names the account it wants instead
 * of taking whoever is signed in - there being nobody signed in when an
 * operator takes a backup.
 *
 * The register is still what says an account is real, exactly as it does for
 * `openAccount`: a store is addressed by name and `idFromName` hands back an
 * empty one for a name nobody ever created, so without this a typo would back
 * up an account that does not exist and report nothing wrong.
 */
export async function backUpAccount(env: Env, accountName: string): Promise<AccountBackup> {
  if (!(await accountIsRegistered(env, accountName))) {
    throw new AccountNotInRegisterError(accountName);
  }
  const store = env.ACCOUNT.get(env.ACCOUNT.idFromName(accountName));
  const { backup, foreign } = await store.exportAsItStands(accountName);
  if (foreign.length > 0) {
    throw new RowsFromAnotherAccountError(describeForeignRows(foreign, accountName));
  }
  return backup;
}

/**
 * How many live workspaces somebody's account holds, and whether it holds
 * anything at all, for the question asked before they are deleted - or null
 * for somebody the register does not hold. Counted as the store stands
 * (`rpc.ts`), so looking opens nothing.
 */
export async function accountHoldings(
  env: Env,
  userId: string,
): Promise<{ workspaces: number; empty: boolean } | null> {
  const accountId = await accountOwnedBy(env, userId);
  if (!accountId) return null;
  return env.ACCOUNT.get(env.ACCOUNT.idFromName(accountId)).holdings(accountId);
}

/** Somebody was deleted, or was not and this is why - `because` as a change's (`register.ts`). */
export type Deleted =
  | { deleted: true }
  | { deleted: false; refused: string; because: 'nobody' | 'a rule' };

/**
 * Deletes somebody, and destroys the account they owned ("Delete a user, and
 * the account they owned with them", issue 234) - the one operation in the
 * product that empties an account, and one only a backup taken beforehand can
 * undo.
 *
 * **The order is the answer to stopping halfway**: sign-ins, then the account's
 * data, then the register.
 *
 * | Stopped | What is left |
 * |---|---|
 * | before the sign-ins end | nothing has happened |
 * | after the sign-ins, before the data | they are signed out of an account that is still whole |
 * | after the data, before the register | they can sign in, to an empty account - visible, and finished by deleting again |
 *
 * The other order leaves an account nobody can see, holding data, under a name
 * `addUser` derives again - handing one person's work to the next person of
 * that name, which is the failure this exists to prevent.
 *
 * **Run a second time, it answers that there is nobody** and touches nothing:
 * the register no longer holds them. An account nobody ever opened holds no
 * data, and destroying it is a change with no effect rather than a failure.
 *
 * **Two windows are left open knowingly**, as `changeUser` leaves its own,
 * because no request can be timed to prove a lock on either: two admins
 * deleting each other in the same instant both pass the refusals and leave no
 * admin at all; and anything already holding the account when this starts - a
 * request past the gate before their sign-ins end, or a background job midway
 * through a model call, like the nightly summary - can reach the store after
 * it is destroyed, rebuilding it with whatever it writes, which the next
 * person given this account would inherit. Closing that means a store refusing
 * to rebuild itself for an account the register no longer holds.
 */
export async function deleteUser(env: Env, userId: string, askedBy: string): Promise<Deleted> {
  const who = await whoCanBeDeleted(env, userId, askedBy);
  if (!who.deletable) return { deleted: false, refused: who.refused, because: who.because };

  await endSignInsOf(env, userId);
  await env.ACCOUNT.get(env.ACCOUNT.idFromName(who.accountId)).destroy();
  await removeFromRegister(env, { userId, accountId: who.accountId });
  return { deleted: true };
}

/**
 * Puts one account's store back from a backup.
 *
 * **The register is deliberately not consulted**, which is the one place this
 * differs from `backUpAccount` beside it. An account's store is restored
 * *before* its register row is written, so that a user never exists pointing at
 * data that has not arrived - which means at this moment the account is
 * routinely not in the register yet, and requiring it would make restoring into
 * an empty environment impossible.
 *
 * **What stands in for that check is the route, not this function.** A backup
 * carries the name it was taken from, and `http/app.ts` refuses one whose name
 * is not the account it is going into. That is what stops a file reaching the
 * wrong store; the rows' own `tenant_id` (`foreignRows`) is a second lock
 * behind it and not a substitute, because it can only disagree with rows that
 * exist - a backup of an account nobody has opened has none, and used to pass
 * straight through into whichever store was named.
 */
export async function restoreAccount(
  env: Env,
  accountName: string,
  backup: AccountBackup,
  force: boolean,
): Promise<RestoreReport> {
  const store = env.ACCOUNT.get(env.ACCOUNT.idFromName(accountName));
  return unwrap(await store.restoreFrom(accountName, backup, force));
}

/**
 * Puts the guest account back to its demonstration - the one reset both the
 * operator's route and the nightly run call ("Reset the guest account to its
 * seeded state", issue 356).
 *
 * **Takes no account, so no caller can point it at one.** The guest's store is
 * the only one this addresses, and two locks stand in front of wiping it: the
 * register has to say the guest's id is the guest's rather than somebody's
 * added under that name (`whoHoldsTheGuestAccount`), and the store has to hold
 * nothing but the guest's rows (`resetGuest`, store.ts). Either failing is a
 * conflict, and nothing is dropped.
 *
 * **An environment with no guest account resets nothing and creates nothing.**
 * Addressing a store by name makes one, so without the register check the
 * nightly run would build a demonstration in staging - where guest sign-in is
 * refused (`GUEST_SIGN_IN`) - for nobody to open.
 */
export async function resetGuestAccount(env: Env): Promise<'reset' | 'no guest account'> {
  const holder = await whoHoldsTheGuestAccount(env);
  if (holder === 'nobody') return 'no guest account';
  if (holder === 'somebody real') {
    throw new ConflictInAccountError(
      `${GUEST_ACCOUNT_NAME} belongs to somebody added under the name Guest rather than to the guest, so nothing was reset`,
    );
  }
  const store = env.ACCOUNT.get(env.ACCOUNT.idFromName(GUEST_ACCOUNT_NAME));
  unwrap(await store.resetGuest());
  return 'reset';
}

/**
 * Re-arms the alarm of every account holding a pulled connection whose alarm
 * is not armed ("Check a pulled connector on its cadence through the generic
 * host", issue 891) - the nightly guard against an alarm that was lost, which
 * would otherwise stop the checks without a word. Answers how many it armed;
 * one account failing is logged and costs only itself.
 */
export async function keepEveryAccountChecking(env: Env): Promise<number> {
  let armed = 0;
  for (const accountName of await registeredAccountNames(env)) {
    try {
      const store = env.ACCOUNT.get(env.ACCOUNT.idFromName(accountName));
      if (unwrap(await store.keepCheckingPulledConnections(accountName)) === 'armed') armed += 1;
    } catch (error) {
      notLookedAt(accountName, 'pulled connections’ check', error);
    }
  }
  return armed;
}

/**
 * Deletes every account's connection history older than 30 days ("Keep a
 * connection's history 30 days, and fold a quiet past day into one line",
 * issue 1145), reaching each account the way `keepEveryAccountChecking` does.
 * Answers how many lines went; one account failing is logged and costs only
 * itself, keeping its lines until a later night works.
 */
export async function pruneEveryAccountsHistory(env: Env): Promise<number> {
  let pruned = 0;
  for (const accountName of await registeredAccountNames(env)) {
    try {
      const store = env.ACCOUNT.get(env.ACCOUNT.idFromName(accountName));
      pruned += unwrap(await store.pruneConnectionHistory(accountName));
    } catch (error) {
      notLookedAt(accountName, 'connection history', error);
    }
  }
  return pruned;
}

function notLookedAt(accountName: string, what: string, error: unknown): void {
  console.error(
    JSON.stringify({
      level: 'error',
      message: `account ${accountName}'s ${what} was not looked at tonight`,
      cause: error instanceof Error ? error.message : String(error),
    }),
  );
}

/** Turns the store's answer back into a value or the error that belongs to it. */
function unwrap<T>(answer: Answer<T>): T {
  switch (answer.status) {
    case 'ok':
      return answer.value;
    case 'missing':
      throw new NotFoundInAccountError(answer.what);
    case 'conflict':
      throw new ConflictInAccountError(answer.what);
    case 'refused':
      throw new RefusedByAccountError(answer.what);
    case 'not-up-to-date':
      throw new AccountNotUpToDateError(answer.failure);
    case 'allowance-spent':
      throw new AllowanceSpentError();
  }
}

/**
 * Opens an account the register has just made, and says whether it opened -
 * for adding somebody, and for somebody's first sign-in making them one.
 *
 * **Opened straight away**, so a change that will not apply is met by whoever
 * made the account rather than by its owner's first request.
 *
 * **Never throws.** After the register and never before it: a store opened for
 * an account nobody owns is an object nothing can reach, while a person whose
 * account is not ready simply has it made on their first request. So what a
 * failure here costs is a log line, not the answer.
 */
export async function accountOpened(env: Env, accountId: string, who: string): Promise<boolean> {
  try {
    await (await openAccount(env, accountId)).workspaces();
    return true;
  } catch (error) {
    console.error(
      JSON.stringify({
        level: 'error',
        message: `${who} but their account would not open`,
        cause: error instanceof Error ? error.message : String(error),
      }),
    );
    return false;
  }
}

/**
 * An attachment's bytes as a response, or null where R2 no longer holds them
 * - what the signed-in download and an agent's link both answer with.
 */
export async function serveAttachment(env: Env, attachment: AttachmentForDownload): Promise<Response | null> {
  const object = await env.ATTACHMENTS.get(attachment.r2Key);
  if (!object) return null;
  // The same DOM-lib-vs-workers-types conflict the upload route's own
  // comment explains - `unknown` bridges this one cleanly, unlike the
  // upload route's `.put()` call, whose own parameter type needed `any`
  // instead: the two sides of that conflict don't fail identically.
  return new Response(object.body as unknown as ReadableStream, {
    status: 200,
    headers: {
      // The stored, allowlisted type - never a passthrough of whatever the
      // upload claimed (issue 441's own download test case), even though
      // `add_attachment`'s own write already made the two agree.
      'Content-Type': attachment.contentType,
      'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(attachment.filename)}`,
    },
  });
}
