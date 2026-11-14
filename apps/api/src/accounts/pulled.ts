import { and, asc, eq, inArray, isNotNull, isNull, like, lte, min, not, notExists, or } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import { CONVERSATION_EXCERPT_LENGTH, DRAFT_STARTING_PREFIX, TITLE_LENGTH, cutTo } from '@cockpit/shared';
import type {
  CompleteListing,
  ConversationTurn,
  DraftWaiting,
  DueDayReport,
  EmittedItem,
  NamesReport,
  OpenStateWanted,
  SourceItem,
  SourceStateChange,
} from '@cockpit/connector-sdk';
import type { AccountDb } from './client.js';
import { GUEST_ACCOUNT_NAME } from './new-user.js';
import { SourceAccountNotFoundError, runCommand } from './command-service.js';
import {
  getItem,
  getSourceAccount,
  listDashboards,
  listFilingsOnPanel,
  listPanels,
  recentCapturedTimeZones,
} from './repo.js';
import { connectionFailures, connectorAccounts, itemConversations, items, pulledConnections, pulledLinks } from './schema.js';
import { confirmOpenStates, openStatesWaiting } from './pulled-open-state.js';
import { applySourceStateChange } from './source-state.js';
import {
  namesNewSince,
  namesToRecord,
  recordedNames,
  whatNamesDid,
  type NameForms,
  type NameOutcome,
  type NamedTarget,
} from '../domain/filing-by-name.js';
import { dueDateIsTheConnections, dueDateOnArrival, sourceDay } from '../domain/due-in-days.js';
import { statusBeforeDraftIn } from '../domain/conversations.js';
import { PULLED_CHECK_LEASE_MS, leaseFrom, nextCheckAfter, whatADeliveryDoes } from '../domain/pulled-checks.js';
import { keptMessage, type CheckDid, type NamedOn } from '../domain/connection-history.js';
import { recordCheck } from './connection-history.js';

/** The forms of name a connection that declared none reads. */
const NO_FORMS: NameForms = { byDashboard: false };

/**
 * The store's half of checking a pulled connection through the generic host
 * ("Check a pulled connector on its cadence through the generic host", issue
 * 891): when each connection is due, which run holds it, and every call that
 * run makes - each synchronous, so no `await` falls between asking whether the
 * run still holds its connection and the write that answer allows.
 *
 * **Nothing here opens a credential.** The run's Worker does; the store hands
 * it the sealed bytes and takes sealed bytes back.
 *
 * `pulledIds` is which connectors are pulled - the registry's to say, and
 * never more values than there are connectors.
 */

/** A connection this store keeps checked, as a run is handed it. */
export interface PulledRunStarted {
  status: 'started';
  runId: string;
  connectorId: string;
  /** Who the connection is at the source, and whose Workspace - what the ids of the Items it files are derived from. */
  workspaceId: string;
  externalAccountKey: string;
  /** The choice the connection holds as the run starts, or null where it holds none (issue 942). */
  choice: string | null;
}

export type PulledRunBegun = PulledRunStarted | { status: 'already running' | 'not queued' | 'disconnected' };

/**
 * Gives every pulled connection the account holds a check, due now where it
 * had none - what connecting arms - and answers when the earliest is due, or
 * null where the account holds no pulled connection. Never the guest's, whose
 * connections are demonstrations.
 */
export function schedulePulledChecks(
  db: AccountDb,
  accountName: string,
  pulledIds: readonly string[],
  now: Date,
): string | null {
  if (accountName === GUEST_ACCOUNT_NAME || pulledIds.length === 0) return null;
  const unscheduled = db
    .select({ id: connectorAccounts.id })
    .from(connectorAccounts)
    .leftJoin(pulledConnections, eq(pulledConnections.sourceAccountId, connectorAccounts.id))
    .where(
      and(
        eq(connectorAccounts.tenantId, accountName),
        inArray(connectorAccounts.connectorId, [...pulledIds]),
        isNull(pulledConnections.sourceAccountId),
      ),
    )
    .all();
  for (const { id } of unscheduled) {
    db.insert(pulledConnections)
      .values({ sourceAccountId: id, tenantId: accountName, dueAt: now.toISOString() })
      .onConflictDoNothing()
      .run();
  }
  return (
    db
      .select({ dueAt: min(pulledConnections.dueAt) })
      .from(pulledConnections)
      .innerJoin(connectorAccounts, eq(connectorAccounts.id, pulledConnections.sourceAccountId))
      .where(
        and(
          eq(pulledConnections.tenantId, accountName),
          eq(connectorAccounts.tenantId, accountName),
          inArray(connectorAccounts.connectorId, [...pulledIds]),
        ),
      )
      .get()?.dueAt ?? null
  );
}

/**
 * The connections whose check is due by `dueBy`, each marked queued and due
 * again when its lease would run out - so a message that never arrives is
 * queued again then rather than stopping the check.
 */
export function queueDuePulledChecks(
  db: AccountDb,
  accountName: string,
  pulledIds: readonly string[],
  dueBy: Date,
  now: Date,
): string[] {
  if (accountName === GUEST_ACCOUNT_NAME || pulledIds.length === 0) return [];
  const due = db
    .select({ id: pulledConnections.sourceAccountId })
    .from(pulledConnections)
    .innerJoin(connectorAccounts, eq(connectorAccounts.id, pulledConnections.sourceAccountId))
    .where(
      and(
        eq(pulledConnections.tenantId, accountName),
        eq(connectorAccounts.tenantId, accountName),
        inArray(connectorAccounts.connectorId, [...pulledIds]),
        lte(pulledConnections.dueAt, dueBy.toISOString()),
      ),
    )
    .orderBy(asc(pulledConnections.dueAt), asc(pulledConnections.sourceAccountId))
    .all()
    .map((row) => row.id);
  for (const id of due) {
    db.update(pulledConnections)
      .set({ queuedAt: now.toISOString(), dueAt: leaseFrom(now) })
      .where(and(eq(pulledConnections.tenantId, accountName), eq(pulledConnections.sourceAccountId, id)))
      .run();
  }
  return due;
}

/** What pressing *Check now* did: made a check due, relabelled the one queued, or found one running. */
export type CheckedNow = 'queued' | 'already queued' | 'running';

/**
 * Makes a pulled connection's check due now, labelled *Check now* (issue 1143),
 * by the path a person's change takes (`bringPulledCheckForward`) - no queue of
 * its own:
 *
 * | The connection is | Does |
 * |---|---|
 * | idle | due now, reason *Check now*; answers `queued`, for the caller to arm the alarm |
 * | queued | the queued check takes the reason; `already queued` |
 * | running | nothing - the run keeps its own reason; `running` |
 *
 * Refused as not found where it is not a live pulled connection of this
 * Workspace. The reason is a column of the connection's row, so one queued
 * before a deploy is read by the code after it.
 */
export function checkPulledConnectionNow(
  db: AccountDb,
  accountName: string,
  workspaceId: string,
  sourceAccountId: string,
  pulledIds: readonly string[],
  now: Date,
): CheckedNow {
  const held = getSourceAccount(db, accountName, sourceAccountId);
  if (
    accountName === GUEST_ACCOUNT_NAME ||
    !held ||
    held.workspaceId !== workspaceId ||
    !pulledIds.includes(held.connectorId)
  ) {
    throw new SourceAccountNotFoundError(sourceAccountId);
  }
  // A connection the alarm has not yet scheduled has no row to relabel.
  db.insert(pulledConnections)
    .values({ sourceAccountId, tenantId: accountName, dueAt: now.toISOString() })
    .onConflictDoNothing()
    .run();
  const where = and(
    eq(pulledConnections.tenantId, accountName),
    eq(pulledConnections.sourceAccountId, sourceAccountId),
  );
  const row = db
    .select({ queuedAt: pulledConnections.queuedAt, runId: pulledConnections.runId })
    .from(pulledConnections)
    .where(where)
    .get()!;
  if (row.runId !== null) return 'running';
  if (row.queuedAt !== null) {
    db.update(pulledConnections).set({ checkReason: 'check-now' }).where(where).run();
    return 'already queued';
  }
  db.update(pulledConnections).set({ dueAt: now.toISOString(), checkReason: 'check-now' }).where(where).run();
  return 'queued';
}

/**
 * A delivered check: the run takes the connection's lease, or nothing happens
 * - one run at a time, and one run per queued check.
 */
export function beginPulledRun(
  db: AccountDb,
  accountName: string,
  sourceAccountId: string,
  runId: string,
  now: Date,
): PulledRunBegun {
  const connection = connectionOf(db, accountName, sourceAccountId);
  const held = db
    .select({ queuedAt: pulledConnections.queuedAt, leaseUntil: pulledConnections.leaseUntil })
    .from(pulledConnections)
    .where(and(eq(pulledConnections.tenantId, accountName), eq(pulledConnections.sourceAccountId, sourceAccountId)))
    .get();
  if (!connection || !held) return { status: 'disconnected' };
  const does = whatADeliveryDoes(held, now);
  if (does !== 'run') return { status: does };
  const leaseUntil = leaseFrom(now);
  db.update(pulledConnections)
    .set({ queuedAt: null, runId, leaseUntil, dueAt: leaseUntil })
    .where(and(eq(pulledConnections.tenantId, accountName), eq(pulledConnections.sourceAccountId, sourceAccountId)))
    .run();
  return {
    status: 'started',
    runId,
    connectorId: connection.connectorId,
    workspaceId: connection.workspaceId,
    externalAccountKey: connection.externalAccountKey,
    choice: connection.choice,
  };
}

/**
 * Whether this run still holds its connection: the connection is there and
 * no other run has taken it. Asked by every call that writes, in the same
 * synchronous step as the write.
 */
function runHolds(db: AccountDb, accountName: string, sourceAccountId: string, runId: string) {
  const connection = connectionOf(db, accountName, sourceAccountId);
  if (!connection) return null;
  const held = db
    .select({ runId: pulledConnections.runId, state: pulledConnections.state })
    .from(pulledConnections)
    .where(and(eq(pulledConnections.tenantId, accountName), eq(pulledConnections.sourceAccountId, sourceAccountId)))
    .get();
  return held?.runId === runId ? { ...connection, state: held.state } : null;
}

/** The connector's private state for this connection, or null before it saved any. */
export function pulledState(db: AccountDb, accountName: string, sourceAccountId: string, runId: string): unknown {
  const holds = runHolds(db, accountName, sourceAccountId, runId);
  return holds?.state == null ? null : JSON.parse(holds.state);
}

/** Saves the connector's private state, while the run still holds its connection. */
export function savePulledState(
  db: AccountDb,
  accountName: string,
  sourceAccountId: string,
  runId: string,
  state: unknown,
): 'saved' | 'not this run' {
  if (!runHolds(db, accountName, sourceAccountId, runId)) return 'not this run';
  db.update(pulledConnections)
    .set({ state: state === undefined ? null : JSON.stringify(state) })
    .where(and(eq(pulledConnections.tenantId, accountName), eq(pulledConnections.sourceAccountId, sourceAccountId)))
    .run();
  return 'saved';
}

/** The connection's sealed credential, for the run's Worker to open - null once the run no longer holds it. */
export function pulledSealedCredential(
  db: AccountDb,
  accountName: string,
  sourceAccountId: string,
  runId: string,
): { sealedCredential: string; credentialNonce: string } | null {
  const holds = runHolds(db, accountName, sourceAccountId, runId);
  return holds ? { sealedCredential: holds.sealedCredential, credentialNonce: holds.credentialNonce } : null;
}

/**
 * Saves a credential the source rotated, only while the stored one is still
 * `was`, the one the run opened: a reconnect made meanwhile keeps its own.
 */
export function resealPulledCredential(
  db: AccountDb,
  accountName: string,
  sourceAccountId: string,
  runId: string,
  was: { sealedCredential: string; credentialNonce: string },
  sealed: { sealedCredential: string; credentialNonce: string },
): 'saved' | 'not saved' {
  if (!runHolds(db, accountName, sourceAccountId, runId)) return 'not saved';
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

/**
 * Files what the connector read as an Item of the connection's Workspace,
 * once per source id - through `capture_item`, the one command every front
 * door captures through, under ids the caller derived from the connection and
 * the source id, so a run that stops after the capture and before the link
 * captures again as a replay the store ignores.
 *
 * Answers `disconnected` where the run no longer holds its connection, and
 * files nothing.
 */
export function filePulledItem(
  db: AccountDb,
  accountName: string,
  sourceAccountId: string,
  runId: string,
  item: SourceItem & { sourceId: string },
  ids: { itemId: string; commandId: string; followCommandId?: string },
  at: string,
  forms: NameForms = NO_FORMS,
): { answer: EmittedItem | 'disconnected'; named: NamedOn | null } {
  const holds = runHolds(db, accountName, sourceAccountId, runId);
  if (!holds) return { answer: 'disconnected', named: null };
  // One transaction for the Item, its filings, its link and the conversation it
  // follows, so a check that fails partway leaves no Item and the next one makes
  // and files it once (issue 1146). What each name did is decided in it, and
  // answered with it (issue 1197).
  return db.transaction((): { answer: EmittedItem; named: NamedOn | null } => {
    const link = linkOf(db, accountName, holds, item.sourceId);
    if (link) {
      // An Item emitted again still says what its names are now, and follows
      // the conversation it says it follows: a label's Item for the same thread
      // is the same Item, which starts following it here (issue 1705).
      const outcomes = item.names ? recordNames(db, accountName, holds, link, item.names, item.followed, at, forms) : [];
      followTheConversation(db, accountName, holds, link.itemId, item, ids.followCommandId, at);
      return { answer: 'already-known', named: namedOn(link.itemId, outcomes) };
    }
    // A mark on a conversation an open Item follows already - one Email… made
    // follow it, which no link names (issue 1708) - adds to that Item rather
    // than making another.
    if (item.conversation && followedBy(db, accountName, holds, item.conversation.id).get()) {
      return { answer: 'already-known', named: null };
    }
    const message = item.capturedMessage ?? item.title;
    if (!message) throw new Error('a pulled item carries neither a message nor a title');
    const names = item.names ? namesToRecord(item.names) : null;
    // Every name is new on an Item just made, so each names its Panel - while
    // the connection files by name, and recorded either way.
    const decided = whatNamesDid(names ?? [], names && holds.filesByName ? panelsOf(db, accountName, holds.workspaceId) : [], {
      skipAll: holds.filesByName ? null : 'off',
      alreadyOn: new Set(),
      forms,
    });
    const panelIds = decided.panelIds;
    // The date the connection gives the Item, counted from the day it arrives
    // here and read as the connection stands now (issue 1409).
    // The day the source names, where it names one, comes ahead of the days.
    const sourceGave = sourceDay(item.dueDay);
    const given =
      sourceGave !== null
        ? sourceGave
        : holds.dueInDays === null
          ? null
          : dueDateOnArrival(at, recentCapturedTimeZones(db, accountName), holds.dueInDays);
    const captured = runCommand(
      db,
      accountName,
      'capture_item',
      {
        commandId: ids.commandId,
        issuedAt: at,
        workspaceId: holds.workspaceId,
        itemId: ids.itemId,
        message,
        // The source's title, or the one cut from its message - also where the
        // title is all the source said, which would otherwise be repeated as the
        // description.
        ...(item.title && item.title !== message ? { title: item.title } : {}),
        ...(panelIds.length > 0 ? { panelIds } : {}),
        capturedFrom: {
          // The connection's own connector, whatever the connector said: a
          // connector never chooses where its Items say they came from.
          source: holds.connectorId,
          sourceId: item.sourceId,
          ...(item.sourceLink ? { sourceLink: item.sourceLink } : {}),
          ...(item.sender ? { sender: item.sender } : {}),
          ...(item.sourceTimestamp ? { sourceTimestamp: item.sourceTimestamp } : {}),
        },
      },
      // Filed by the source's names, so nothing is learned from it.
      { fromTheSource: true },
    );
    // Written here, in the transaction that makes the Item, rather than through
    // `capture_item`, whose due date is stamped as the person's own: a date a
    // connection gives is not their choice, so a reading may replace it and a
    // reopen may move it. The capture's entry in the command log is what tells
    // open tabs to read the Item, date included. Only for an Item this call
    // made: a replay leaves the Item as it is.
    if (given !== null && captured.applied) {
      db.update(items)
        .set({ dueDate: given, dueDateSetAt: at })
        .where(and(eq(items.tenantId, accountName), eq(items.id, ids.itemId)))
        .run();
    }
    db.insert(pulledLinks)
      .values({
        tenantId: accountName,
        workspaceId: holds.workspaceId,
        connectorId: holds.connectorId,
        externalAccountKey: holds.externalAccountKey,
        sourceId: item.sourceId,
        itemId: ids.itemId,
        linkedAt: at,
        choice: item.choice ?? null,
        names: names ? JSON.stringify(names) : null,
        givenDueDate: given !== null && captured.applied ? given : null,
      })
      .onConflictDoNothing()
      .run();
    followTheConversation(db, accountName, holds, ids.itemId, item, ids.followCommandId, at);
    return { answer: 'filed', named: namedOn(ids.itemId, outcomesWithMark(decided.outcomes, item.followed)) };
  });
}

/**
 * Applies the day a pulled connector reports its source now gives an Item
 * ("A flag's date becomes the Outlook Item's due date", issue 1759): the Item's
 * date becomes that day, as the source's own change through `set_due_date`, and
 * the day is recorded on the link as the connection's, so readings, replies,
 * reopen and a person's edits treat it as they treat the connection's days.
 *
 * **Only while the date is still the connection's**: the one the link recorded,
 * not set or cleared by a person, not replaced by a reading - or the Item has
 * no date at all and nobody set or cleared it. A source id the connection never
 * filed changes nothing, and the same day reported twice changes nothing.
 */
export function reportPulledDueDay(
  db: AccountDb,
  accountName: string,
  sourceAccountId: string,
  runId: string,
  report: DueDayReport,
  at: string,
): 'recorded' | 'unchanged' | 'unknown' | 'disconnected' {
  const holds = runHolds(db, accountName, sourceAccountId, runId);
  if (!holds) return 'disconnected';
  const day = sourceDay(report.dueDay);
  return db.transaction((): 'recorded' | 'unchanged' | 'unknown' => {
    const link = linkOf(db, accountName, holds, report.sourceId);
    if (!link) return 'unknown';
    if (day === null) return 'unchanged';
    const item = getItem(db, accountName, link.itemId);
    if (!item) return 'unchanged';
    const untouched = item.dueDate === null && item.dueDateChosenAt === null;
    if (!untouched && !dueDateIsTheConnections(item, link.givenDueDate)) return 'unchanged';
    // Past the check above, the Item already on the day is one the link already records.
    if (item.dueDate === day) return 'unchanged';
    // Never older than what the Item last heard, or the change would be refused as stale.
    const issuedAt = at < item.updatedAt ? item.updatedAt : at;
    const result = runCommand(
      db,
      accountName,
      'set_due_date',
      {
        commandId: crypto.randomUUID(),
        issuedAt,
        workspaceId: item.workspaceId,
        itemId: item.id,
        dueDate: day,
      },
      { fromTheSource: true },
    );
    if (!result.applied) return 'unchanged';
    db.update(pulledLinks)
      .set({ givenDueDate: day })
      .where(
        and(
          eq(pulledLinks.tenantId, accountName),
          eq(pulledLinks.workspaceId, link.workspaceId),
          eq(pulledLinks.connectorId, link.connectorId),
          eq(pulledLinks.externalAccountKey, link.externalAccountKey),
          eq(pulledLinks.sourceId, link.sourceId),
        ),
      )
      .run();
    return 'recorded';
  });
}

/** How much of a message a conversation keeps (`CONVERSATION_EXCERPT_LENGTH`), and of a name. */
const EXCERPT_LENGTH = CONVERSATION_EXCERPT_LENGTH;
const NAME_LENGTH = TITLE_LENGTH;
/** The longest link a conversation keeps, as `record_conversation_turn` takes it. */
const LINK_LENGTH = 2_000;

/**
 * Has the Item follow the conversation the connector says it does, through
 * `follow_conversation`, the one change every way an Item comes to follow one
 * takes ("A Gmail starred conversation is one Item whose status follows who
 * wrote last", issue 1705). Nothing where the connector names none. Inside the
 * caller's transaction.
 */
function followTheConversation(
  db: AccountDb,
  accountName: string,
  holds: { workspaceId: string; connectorId: string; externalAccountKey: string; dueInDays: number | null },
  itemId: string,
  item: SourceItem,
  commandId: string | undefined,
  at: string,
): void {
  const read = item.conversation;
  if (!read || !commandId) return;
  runCommand(
    db,
    accountName,
    'follow_conversation',
    {
      commandId,
      issuedAt: at,
      workspaceId: holds.workspaceId,
      itemId,
      connectorId: holds.connectorId,
      externalAccountKey: holds.externalAccountKey,
      conversationId: read.id,
      link: read.link,
      latest: {
        by: read.latest.by,
        from: cut(read.latest.from, NAME_LENGTH),
        at: read.latest.at,
        excerpt: cut(read.latest.excerpt, EXCERPT_LENGTH) ?? '',
      },
      messageCount: Math.max(1, Math.trunc(read.messageCount)),
      startedAt: read.startedAt,
      withWhom: cut(read.withWhom, NAME_LENGTH),
      connectionDays: holds.dueInDays,
    },
    { fromTheSource: true },
  );
}

/** `cutTo`, which never splits a character in two, passing a missing text through. */
function cut<T extends string | null>(text: T, limit: number): T {
  return (text === null ? null : cutTo(text, limit)) as T;
}

/**
 * The conversations this connection's open Items follow, by the source's id -
 * what a run hands its connector to read turns for (issue 1705). Of the Items
 * a connection brought in, only those this one filed in its own Workspace, so
 * another Workspace's Item following the same mailbox's conversation is never
 * this run's; an Item Email… made follow one (issue 1708) is every run's at
 * that mailbox, a turn read twice being applied once.
 */
export function followedPulledConversations(
  db: AccountDb,
  accountName: string,
  sourceAccountId: string,
  runId: string,
): string[] {
  const holds = runHolds(db, accountName, sourceAccountId, runId);
  if (!holds) return [];
  return [
    ...new Set(
      followedBy(db, accountName, holds)
        .all()
        .map((row) => row.conversationId),
    ),
  ];
}

/**
 * Records a turn the connector reported in a conversation an open Item of
 * this connection follows, through `record_conversation_turn`, which decides
 * what it does to the Item (issue 1705). Its id is the caller's, derived from
 * the message, so a turn reported twice is applied once. Answers `not followed`
 * for a conversation no open Item of this connection's Workspace follows.
 */
export function recordPulledTurn(
  db: AccountDb,
  accountName: string,
  sourceAccountId: string,
  runId: string,
  turn: ConversationTurn,
  commandId: string,
  at: string,
): 'recorded' | 'not followed' | 'disconnected' {
  const holds = runHolds(db, accountName, sourceAccountId, runId);
  if (!holds) return 'disconnected';
  const followed = followedBy(db, accountName, holds, turn.conversationId).get();
  if (!followed) return 'not followed';
  runCommand(
    db,
    accountName,
    'record_conversation_turn',
    {
      commandId,
      issuedAt: at,
      // The Item's own Workspace, whose open tabs read it again: an Item Email…
      // made follow a conversation may be read by another Workspace's connection.
      workspaceId: followed.itemWorkspaceId,
      itemId: followed.itemId,
      connectorId: holds.connectorId,
      externalAccountKey: holds.externalAccountKey,
      conversationId: turn.conversationId,
      by: turn.by,
      from: cut(turn.from, NAME_LENGTH),
      at: turn.at,
      excerpt: cut(turn.excerpt, EXCERPT_LENGTH),
      connectionDays: holds.dueInDays,
      // Where the source shows the message, which Open goes to once it is the latest (issue 1720);
      // one too long to keep leaves the link as it was rather than refusing the turn.
      ...(turn.link && turn.link.length <= LINK_LENGTH ? { link: turn.link } : {}),
    },
    { fromTheSource: true },
  );
  return 'recorded';
}

/**
 * The drafts Email… made that this connection's open Items still wait on
 * ("Email… makes a Gmail draft the Item then follows", issue 1708): what a run
 * hands its connector to look for once it has read the turns.
 */
export function pulledDraftsWaiting(
  db: AccountDb,
  accountName: string,
  sourceAccountId: string,
  runId: string,
): DraftWaiting[] {
  const holds = runHolds(db, accountName, sourceAccountId, runId);
  if (!holds) return [];
  return followedBy(db, accountName, holds)
    .all()
    .flatMap((row) => {
      const before = statusBeforeDraftIn(row.statusBeforeDraft);
      if (row.draftId === null || !before) return [];
      return [{ conversationId: row.conversationId, draftId: row.draftId, after: before.opened ? null : row.lastAt }];
    });
}

/**
 * A draft the connector found gone unsent, through `drop_draft`, which puts
 * the Item's status back (issue 1708). Its id is the caller's, derived from
 * the draft, so a draft reported twice changes things once; a draft no open
 * Item of this connection waits on changes nothing.
 */
export function reportPulledDraftGone(
  db: AccountDb,
  accountName: string,
  sourceAccountId: string,
  runId: string,
  draft: { conversationId: string; draftId: string },
  commandId: string,
  at: string,
): 'dropped' | 'not waited on' | 'disconnected' {
  const holds = runHolds(db, accountName, sourceAccountId, runId);
  if (!holds) return 'disconnected';
  const waiting = followedBy(db, accountName, holds, draft.conversationId)
    .all()
    .find((row) => row.draftId === draft.draftId);
  if (!waiting) return 'not waited on';
  runCommand(
    db,
    accountName,
    'drop_draft',
    {
      commandId,
      issuedAt: at,
      workspaceId: waiting.itemWorkspaceId,
      itemId: waiting.itemId,
      connectorId: holds.connectorId,
      externalAccountKey: holds.externalAccountKey,
      conversationId: draft.conversationId,
      draftId: draft.draftId,
    },
    { fromTheSource: true },
  );
  return 'dropped';
}

/** The links checked for an Item no connection to a mailbox brought in (`followedBy`). */
const broughtIn = alias(pulledLinks, 'brought_in');

/**
 * The open Items that follow a conversation at this connection's account -
 * one, or all of them where no conversation is named: those it brought in,
 * by their links to it, and those no connection to this mailbox brought in,
 * whose Email… started or replied in one there.
 */
export function followedBy(
  db: AccountDb,
  accountName: string,
  holds: { workspaceId: string; connectorId: string; externalAccountKey: string },
  conversationId?: string,
) {
  return db
    .select({
      itemId: itemConversations.itemId,
      itemWorkspaceId: items.workspaceId,
      conversationId: itemConversations.conversationId,
      lastAt: itemConversations.lastAt,
      draftId: itemConversations.draftId,
      statusBeforeDraft: itemConversations.statusBeforeDraft,
    })
    .from(itemConversations)
    .leftJoin(
      pulledLinks,
      and(
        eq(pulledLinks.tenantId, accountName),
        eq(pulledLinks.itemId, itemConversations.itemId),
        eq(pulledLinks.workspaceId, holds.workspaceId),
        eq(pulledLinks.connectorId, holds.connectorId),
        eq(pulledLinks.externalAccountKey, holds.externalAccountKey),
      ),
    )
    .innerJoin(items, and(eq(items.tenantId, accountName), eq(items.id, itemConversations.itemId)))
    .where(
      and(
        eq(itemConversations.tenantId, accountName),
        eq(itemConversations.connectorId, holds.connectorId),
        eq(itemConversations.externalAccountKey, holds.externalAccountKey),
        // Brought in by this connection, or an Item no connection to this
        // mailbox brought in, whose Email… started or replied in the
        // conversation here (issue 1708): whatever Workspace it is in now, an
        // undecided Inbox Item or one moved since included.
        or(
          isNotNull(pulledLinks.itemId),
          notExists(
            db
              .select({ itemId: broughtIn.itemId })
              .from(broughtIn)
              .where(
                and(
                  eq(broughtIn.tenantId, accountName),
                  eq(broughtIn.itemId, itemConversations.itemId),
                  eq(broughtIn.connectorId, holds.connectorId),
                  eq(broughtIn.externalAccountKey, holds.externalAccountKey),
                ),
              ),
          ),
        ),
        // Not a conversation Email… is still starting, which the source has not named.
        not(like(itemConversations.conversationId, `${DRAFT_STARTING_PREFIX}%`)),
        ...(conversationId === undefined ? [] : [eq(itemConversations.conversationId, conversationId)]),
        // Not stopped: reopened in Cockpit while unmarked at the source.
        isNull(itemConversations.stoppedAt),
        // Open, as `isOpen` has it: neither done nor dismissed.
        isNull(items.completedAt),
        isNull(items.deletedAt),
      ),
    )
    .orderBy(asc(itemConversations.itemId));
}

/** An Item's outcomes for a check's line, or null where it has none to say. */
function namedOn(itemId: string, names: NameOutcome[]): NamedOn | null {
  return names.length === 0 ? null : { itemId, names };
}

/**
 * Records the names a pulled connector reported for an Item it filed, and
 * files the Item on the Panel each name new since the last report names
 * ("File Outlook mail on the Panel named after its category", issue 1146).
 * A source id this connection never filed changes nothing.
 */
export function reportPulledNames(
  db: AccountDb,
  accountName: string,
  sourceAccountId: string,
  runId: string,
  report: NamesReport,
  at: string,
  forms: NameForms = NO_FORMS,
): { answer: 'recorded' | 'unknown' | 'disconnected'; named: NamedOn | null } {
  const holds = runHolds(db, accountName, sourceAccountId, runId);
  if (!holds) return { answer: 'disconnected', named: null };
  return db.transaction((): { answer: 'recorded' | 'unknown'; named: NamedOn | null } => {
    const link = linkOf(db, accountName, holds, report.sourceId);
    if (!link) return { answer: 'unknown', named: null };
    const outcomes = recordNames(db, accountName, holds, link, report.names, report.followed, at, forms);
    return { answer: 'recorded', named: namedOn(link.itemId, outcomes) };
  });
}

/**
 * The link's names replaced by those reported, and - where the connection
 * files by name and a baseline was recorded - the Item added to each Panel a
 * new name names that it is not on already. Adding, never moving: where it is
 * filed already stays. Inside the caller's transaction.
 */
function recordNames(
  db: AccountDb,
  accountName: string,
  holds: { workspaceId: string; filesByName: boolean },
  link: { itemId: string; names: string | null; workspaceId: string; connectorId: string; externalAccountKey: string; sourceId: string },
  reported: readonly string[],
  followed: string | undefined,
  at: string,
  forms: NameForms,
): NameOutcome[] {
  const names = namesToRecord(reported);
  const baseline = recordedNames(link.names);
  const fresh = namesNewSince(baseline, names);
  db.update(pulledLinks)
    .set({ names: JSON.stringify(names) })
    .where(
      and(
        eq(pulledLinks.tenantId, accountName),
        eq(pulledLinks.workspaceId, link.workspaceId),
        eq(pulledLinks.connectorId, link.connectorId),
        eq(pulledLinks.externalAccountKey, link.externalAccountKey),
        eq(pulledLinks.sourceId, link.sourceId),
      ),
    )
    .run();
  // What a check's line says: the names read for the first time on this Item,
  // or those new since the last report (issue 1197) - none where they are unchanged.
  const changed = baseline === null ? names : fresh;
  if (changed.length === 0) return [];
  const skipAll = !holds.filesByName ? 'off' : baseline === null ? 'baseline' : null;
  if (skipAll) return outcomesWithMark(whatNamesDid(changed, [], { skipAll, alreadyOn: new Set() }).outcomes, followed);
  const item = getItem(db, accountName, link.itemId);
  // An Item moved to another Workspace is filed only by a person there.
  if (!item || item.workspaceId !== holds.workspaceId) return [];
  const panels = panelsOf(db, accountName, holds.workspaceId);
  const wouldFile = whatNamesDid(changed, panels, { skipAll: null, alreadyOn: new Set(), forms }).panelIds;
  const filedBefore = new Map(wouldFile.map((panelId) => [panelId, listFilingsOnPanel(db, accountName, panelId)]));
  const alreadyOn = new Set(
    wouldFile.filter((panelId) => filedBefore.get(panelId)!.some((filing) => filing.itemId === link.itemId)),
  );
  const decided = whatNamesDid(changed, panels, { skipAll: null, alreadyOn, forms });
  for (const panelId of decided.panelIds) {
    const held = filedBefore.get(panelId)!;
    runCommand(
      db,
      accountName,
      'add_item_to_panel',
      {
        commandId: crypto.randomUUID(),
        issuedAt: at,
        workspaceId: holds.workspaceId,
        itemId: link.itemId,
        panelId,
        // At the top, as a capture files it.
        order: [link.itemId, ...held.map((filing) => filing.itemId)],
      },
      { fromTheSource: true },
    );
  }
  return outcomesWithMark(decided.outcomes, followed);
}

/**
 * The outcomes of the names read, with the mark the connection follows put
 * before them where the connector said the Item carries it. Said only beside
 * another name: a message with nothing but the mark has nothing to report.
 */
function outcomesWithMark(outcomes: NameOutcome[], followed: string | undefined): NameOutcome[] {
  if (outcomes.length === 0 || !followed) return outcomes;
  return [{ name: followed, panel: null, dashboard: null, why: 'followed', dashboards: null, panels: null }, ...outcomes];
}

/** Every live Panel of the Workspace, with the Dashboard it is on - what names are matched against. */
function panelsOf(db: AccountDb, accountName: string, workspaceId: string): NamedTarget[] {
  return listDashboards(db, accountName, workspaceId).flatMap((dashboard) =>
    listPanels(db, accountName, dashboard.id).map((panel) => ({
      id: panel.id,
      name: panel.name,
      kind: panel.kind,
      dashboardId: dashboard.id,
      dashboardName: dashboard.name,
    })),
  );
}

/**
 * Closes, as a `resolved` change would, each Item still open that this
 * connection filed under the listing's choice and the listing did not see -
 * through `applySourceStateChange`, the path a source's own `resolved` takes
 * ("Close a pulled connector's Items its complete listing no longer sees",
 * issue 938). Left alone: a link filed under another choice or none, one with
 * an open state still waiting for the source (as in `applyPulledSourceChange`),
 * and an Item already done or dismissed.
 *
 * Reads every open Item's link of the choice and compares in memory rather than binding
 * the listing into a statement, so a listing as long as the source has no
 * limit of parameters to meet. Answers the ids of the Items it closed.
 */
export function closePulledItemsNotListed(
  db: AccountDb,
  accountName: string,
  sourceAccountId: string,
  runId: string,
  listing: CompleteListing,
  observedAt: string,
): string[] | 'disconnected' {
  const holds = runHolds(db, accountName, sourceAccountId, runId);
  if (!holds) return 'disconnected';
  const seen = new Set(listing.sourceIds);
  const candidates = db
    .select({ sourceId: pulledLinks.sourceId, itemId: pulledLinks.itemId })
    .from(pulledLinks)
    .innerJoin(items, and(eq(items.tenantId, accountName), eq(items.id, pulledLinks.itemId)))
    .where(
      and(
        eq(pulledLinks.tenantId, accountName),
        eq(pulledLinks.workspaceId, holds.workspaceId),
        eq(pulledLinks.connectorId, holds.connectorId),
        eq(pulledLinks.externalAccountKey, holds.externalAccountKey),
        eq(pulledLinks.choice, listing.choice),
        isNull(pulledLinks.openWanted),
        // Open, as `isOpen` has it: neither done nor dismissed.
        isNull(items.completedAt),
        isNull(items.deletedAt),
      ),
    )
    .all();
  const closed: string[] = [];
  for (const { sourceId, itemId } of candidates) {
    if (seen.has(sourceId)) continue;
    if (applySourceStateChange(db, accountName, itemId, 'resolved', observedAt) === 'changed') closed.push(itemId);
  }
  return closed;
}

/**
 * Applies a source-state change to the Item this connection filed for that
 * source id; one it never filed, or a run that no longer holds its connection,
 * changes nothing. `removed` is not applied yet (`source-state.ts`). Answers
 * the Item it changed, which a check's line names where the change closed it
 * (issue 1141).
 */
export function applyPulledSourceChange(
  db: AccountDb,
  accountName: string,
  sourceAccountId: string,
  runId: string,
  change: SourceStateChange,
): { changed: string } | 'unchanged' | 'disconnected' {
  const holds = runHolds(db, accountName, sourceAccountId, runId);
  if (!holds) return 'disconnected';
  if (change.change === 'removed') return 'unchanged';
  const link = linkOf(db, accountName, holds, change.sourceId);
  if (!link) return 'unchanged';
  // What a person changed and the source has not yet heard wins over what the
  // source says: the connector is handed it before the next read (issue 893).
  if (link.openWanted !== null) return 'unchanged';
  return applySourceStateChange(db, accountName, link.itemId, change.change, change.observedAt) === 'changed'
    ? { changed: link.itemId }
    : 'unchanged';
}

/**
 * The open states a person set in Cockpit that the connection's source has not
 * confirmed - what the run hands the connector before it reads (issue 893).
 * Nothing once the run no longer holds its connection.
 */
export function pulledOpenStatesWaiting(
  db: AccountDb,
  accountName: string,
  sourceAccountId: string,
  runId: string,
): OpenStateWanted[] {
  const holds = runHolds(db, accountName, sourceAccountId, runId);
  return holds ? openStatesWaiting(db, accountName, holds) : [];
}

/**
 * Clears the open states the connector confirmed, while the run still holds its
 * connection (issue 893), and answers the Item of each it cleared - not one a
 * person changed again meanwhile, which stays waiting (issue 1141).
 *
 * **An Item the connector gave up reopening stops following** its conversation
 * at this connection: reopened in Cockpit while unmarked at the source, which is
 * not asked to mark it again, so the source's changes to it are no longer the
 * Item's. It stays open with its last line; marking the conversation again
 * follows it again (`follow_conversation`).
 */
export function confirmPulledOpenStates(
  db: AccountDb,
  accountName: string,
  sourceAccountId: string,
  runId: string,
  confirmed: readonly OpenStateWanted[],
  gaveUp: readonly OpenStateWanted[] = [],
  at = new Date().toISOString(),
): { cleared: { sourceId: string; itemId: string }[] } | 'not this run' {
  const holds = runHolds(db, accountName, sourceAccountId, runId);
  if (!holds) return 'not this run';
  return db.transaction(() => {
    const cleared = confirmOpenStates(db, accountName, holds, [...confirmed, ...gaveUp]);
    const reopenedUnmarked = new Set(gaveUp.filter((one) => one.open).map((one) => one.sourceId));
    const stopping = cleared.filter((one) => reopenedUnmarked.has(one.sourceId)).map((one) => one.itemId);
    if (stopping.length > 0) {
      db.update(itemConversations)
        .set({ stoppedAt: at })
        .where(
          and(
            eq(itemConversations.tenantId, accountName),
            inArray(itemConversations.itemId, stopping),
            eq(itemConversations.connectorId, holds.connectorId),
            eq(itemConversations.externalAccountKey, holds.externalAccountKey),
          ),
        )
        .run();
    }
    return { cleared };
  });
}

/**
 * Ends a run: its lease goes, the next check is due five minutes on - or soon,
 * as a follow-up, where the run worked and said there is more to do, a failed
 * run's hint being ignored - and the connection's row says why it failed - or,
 * for a run that worked, when it was last checked and nothing about failing.
 * The check's line of the history is written in the same transaction, saying
 * why the check ran (issue 1140) and what it did (issue 1141), a failed
 * check's included, with the source's HTTP status where it gave one (issue 1142). A run that no longer holds its connection
 * ends nothing and writes nothing, since another has it or it has gone.
 */
export function endPulledRun(
  db: AccountDb,
  accountName: string,
  sourceAccountId: string,
  runId: string,
  failing: string | null,
  now: Date,
  moreToDo = false,
  did: CheckDid = { broughtIn: [], closed: [], sentBack: [], refused: [] },
  status?: number,
): void {
  if (!runHolds(db, accountName, sourceAccountId, runId)) return;
  const at = now.toISOString();
  const followUp = failing === null && moreToDo;
  db.transaction((tx) => {
    const ran = tx
      .select({ checkReason: pulledConnections.checkReason, leaseUntil: pulledConnections.leaseUntil })
      .from(pulledConnections)
      .where(and(eq(pulledConnections.tenantId, accountName), eq(pulledConnections.sourceAccountId, sourceAccountId)))
      .get();
    tx.update(pulledConnections)
      .set({
        runId: null,
        leaseUntil: null,
        dueAt: nextCheckAfter(now, followUp),
        checkReason: followUp ? 'follow-up' : null,
      })
      .where(and(eq(pulledConnections.tenantId, accountName), eq(pulledConnections.sourceAccountId, sourceAccountId)))
      .run();
    recordCheck(
      tx,
      accountName,
      sourceAccountId,
      ran?.checkReason ?? 'scheduled',
      failing === null ? { outcome: 'worked' } : { outcome: 'failed', ...keptMessage(failing), status: status ?? null },
      did,
      at,
      // The run took its hold for a fixed length when it began (issue 1725).
      ran?.leaseUntil ? new Date(Date.parse(ran.leaseUntil) - PULLED_CHECK_LEASE_MS).toISOString() : null,
    );
    if (failing === null) {
      tx.update(connectorAccounts)
        .set({ lastTestedAt: at })
        .where(and(eq(connectorAccounts.tenantId, accountName), eq(connectorAccounts.id, sourceAccountId)))
        .run();
      tx.delete(connectionFailures).where(eq(connectionFailures.sourceAccountId, sourceAccountId)).run();
    } else {
      tx.insert(connectionFailures)
        .values({ sourceAccountId, tenantId: accountName, reason: failing, failedAt: at })
        .onConflictDoUpdate({ target: connectionFailures.sourceAccountId, set: { reason: failing, failedAt: at } })
        .run();
    }
  });
}

function connectionOf(db: AccountDb, accountName: string, sourceAccountId: string) {
  return db
    .select({
      connectorId: connectorAccounts.connectorId,
      workspaceId: connectorAccounts.workspaceId,
      externalAccountKey: connectorAccounts.externalAccountKey,
      sealedCredential: connectorAccounts.encryptedCredential,
      credentialNonce: connectorAccounts.credentialNonce,
      choice: connectorAccounts.choice,
      filesByName: connectorAccounts.filesByName,
      dueInDays: connectorAccounts.dueInDays,
    })
    .from(connectorAccounts)
    .where(and(eq(connectorAccounts.tenantId, accountName), eq(connectorAccounts.id, sourceAccountId)))
    .get();
}

function linkOf(
  db: AccountDb,
  accountName: string,
  connection: { workspaceId: string; connectorId: string; externalAccountKey: string },
  sourceId: string,
) {
  return db
    .select({
      itemId: pulledLinks.itemId,
      openWanted: pulledLinks.openWanted,
      names: pulledLinks.names,
      givenDueDate: pulledLinks.givenDueDate,
      workspaceId: pulledLinks.workspaceId,
      connectorId: pulledLinks.connectorId,
      externalAccountKey: pulledLinks.externalAccountKey,
      sourceId: pulledLinks.sourceId,
    })
    .from(pulledLinks)
    .where(
      and(
        eq(pulledLinks.tenantId, accountName),
        eq(pulledLinks.workspaceId, connection.workspaceId),
        eq(pulledLinks.connectorId, connection.connectorId),
        eq(pulledLinks.externalAccountKey, connection.externalAccountKey),
        eq(pulledLinks.sourceId, sourceId),
      ),
    )
    .get();
}
