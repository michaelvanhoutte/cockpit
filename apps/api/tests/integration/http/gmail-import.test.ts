import { beforeEach, describe, expect, inject, it, vi } from 'vitest';
import { SELF, applyD1Migrations, env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import {
  ACCOUNT_NAME,
  TASK_TYPE_ID,
  USER_ID,
  WORKSPACE_ID,
  alsoWorkspaces,
  asUser,
  inTheStore,
  seedRegister,
  signInAs,
  startFromEmpty,
  storeNamed,
} from '../seed.js';
import {
  gmailAnswersAgain,
  gmailAnswersWith,
  gmailCalls,
  gmailHolds,
  gmailModifies,
  gmailIsEmpty,
  googleRefreshes,
  issuerIsReachable,
  issuerWillIdentify,
  refreshes,
  whileGmailIsAsked,
  type Grant,
} from '../issuer.js';
import { COCKPIT_LABEL_ID, STARRED, historyRecord, labelsAnswer, plainThread } from '../../gmail-payloads.js';
import { NO_LABEL, SIGN_IN_REFUSED } from '../../../src/connectors/gmail-check.js';
import { derivedUuid } from '../../../src/connectors/push-host.js';
import { handleScheduled } from '../../../src/jobs/index.js';

/**
 * Integration level, through the real Worker and the account's own alarm,
 * because every rule here is about what ends up in the store - which Items,
 * in which Workspace, linked to which conversation - and about the alarm that
 * brings them in ("Bring in the conversations already labelled Cockpit as
 * tasks", issue 725). Gmail and Google are faked at the network boundary
 * (../issuer.ts), answering in the shapes ../../gmail-payloads.ts records.
 *
 * What a conversation's Item says, which label is Cockpit's and what a
 * refresh leaves sealed are tests/unit/connectors/gmail.test.ts's; what the
 * row draws is apps/web's.
 */

const OTHER_WORKSPACE_ID = 'ws-atlas';
const MODIFY = 'https://www.googleapis.com/auth/gmail.modify';
const ANNA = { email: 'anna@example.com', subject: 'google-anna' };

function granted(refreshToken: string, expiresIn = 3599): Grant {
  return {
    refresh_token: refreshToken,
    access_token: `access-for-${refreshToken}`,
    expires_in: expiresIn,
    scope: `openid https://www.googleapis.com/auth/userinfo.email ${MODIFY}`,
  };
}

/** Connect, Google says whose mailbox it is, and back - as gmail-connections.test.ts walks it - by label, or by star. */
async function connect(
  grant: Grant = granted('anna-refresh'),
  workspaceId = WORKSPACE_ID,
  follows: 'label' | 'star' = 'label',
): Promise<void> {
  await issuerIsReachable();
  const session = await signInAs(USER_ID);
  const choosing = follows === 'star' ? '?follows=star' : '';
  const started = await SELF.fetch(`http://cockpit.test/v1/workspaces/${workspaceId}/connections/gmail/connect${choosing}`, {
    redirect: 'manual',
    headers: { cookie: session },
  });
  const asked = new URL(started.headers.get('location')!);
  const attempt = started.headers
    .getSetCookie()
    .map((cookie) => cookie.split(';')[0]!)
    .find((cookie) => cookie.startsWith('cockpit_connect='))!;
  issuerWillIdentify({ ...ANNA, nonce: asked.searchParams.get('nonce')! }, 'a-code', grant);
  const back = await SELF.fetch(
    `http://cockpit.test/v1/connections/gmail/callback?code=a-code&state=${asked.searchParams.get('state')}`,
    { redirect: 'manual', headers: { cookie: `${session}; ${attempt}` } },
  );
  expect(back.headers.get('location')).toBe(
    `/w/${workspaceId}?connections=${follows === 'star' ? 'gmail-star-connected' : 'gmail-connected'}`,
  );
}

/** A mailbox holding `count` conversations labelled Cockpit, and one that is not. */
function mailboxWith(count: number): void {
  threadsHeld = [
    ...Array.from({ length: count }, (_, at) => {
      const id = `thread-${String(at).padStart(3, '0')}`;
      return { id, labelled: true, answer: plainThread(id, `Subject ${at}`, `Text ${at}`) };
    }),
    { id: 'thread-unlabelled', labelled: false, answer: plainThread('thread-unlabelled') },
  ];
  gmailHolds({ labels: labelsAnswer(), historyId: '777', threads: threadsHeld, history: [], historyLapsed: false });
}

let threadsHeld: { id: string; labelled: boolean; answer: unknown }[] = [];

/**
 * The mailbox after the first check: each of these conversations gains the
 * label - one history record apiece, from position 778 - and its position
 * moves on to `now`. Several records may name one conversation.
 */
function labelledAfterwards(threadIds: string[], now = '900'): void {
  for (const id of new Set(threadIds)) {
    threadsHeld.push({ id, labelled: true, answer: plainThread(id, `Subject ${id}`, `Text ${id}`) });
  }
  gmailHolds({
    historyId: now,
    threads: threadsHeld,
    history: threadIds.map((id, at) =>
      historyRecord(String(778 + at), { labelled: `m-${at}`, threadId: id, with: [COCKPIT_LABEL_ID], labelIds: ['INBOX', COCKPIT_LABEL_ID] }),
    ),
  });
}

/** The positions history was asked to read from, oldest first. */
function historyReadsFrom(): string[] {
  return gmailCalls
    .filter((call) => call.startsWith('history?'))
    .map((call) => new URL(`http://x/${call}`).searchParams.get('startHistoryId')!);
}

/** One run of the account's Gmail check, as the alarm fires it. */
function aCheckRuns(): Promise<boolean> {
  return runDurableObjectAlarm(storeNamed(ACCOUNT_NAME));
}

/**
 * Waits for the run the alarm started by itself to finish - connecting checks
 * at once, so the first run is nobody's to start - which is when it has armed
 * the next one.
 */
async function runningCheckFinishes(): Promise<void> {
  for (let waited = 0; waited < 10_000; waited += 25) {
    const next = await nextCheck();
    if (next !== null && next > Date.now()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('the check connecting started never finished');
}

/**
 * Lets the check started by connecting finish, then runs it until it has
 * nothing more to bring in before five minutes from now - at most `limit`
 * times - and answers how many runs that took.
 */
async function checksSettle(limit = 20): Promise<number> {
  await runningCheckFinishes();
  for (let runs = 1; runs <= limit; runs += 1) {
    const next = await nextCheck();
    if (next === null || next > Date.now() + 60_000) return runs;
    await aCheckRuns();
  }
  throw new Error(`the check had more to do after ${limit} runs`);
}

function nextCheck(): Promise<number | null> {
  return runInDurableObject(storeNamed(ACCOUNT_NAME), (_instance, state) => state.storage.getAlarm());
}

interface InboxItem {
  id: string;
  title: string;
  description: string | null;
  source: string;
  sourceId: string | null;
  sourceLink: string | null;
  sender: string | null;
  typeId: string | null;
}

async function inboxOf(workspaceId = WORKSPACE_ID): Promise<InboxItem[]> {
  const res = await asUser(`http://cockpit.test/v1/workspaces/${workspaceId}/snapshot`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { items: InboxItem[] }).items.filter((item) => item.source === 'mail');
}

async function rowOf(
  workspaceId = WORKSPACE_ID,
): Promise<{ lastTestedAt: string | null; failingBecause: string | null; follows?: string }> {
  const res = await asUser(`http://cockpit.test/v1/workspaces/${workspaceId}/connections`);
  const { sourceAccounts } = (await res.json()) as {
    sourceAccounts: { lastTestedAt: string | null; failingBecause: string | null; follows?: string }[];
  };
  return sourceAccounts[0]!;
}

/** Disconnects the Workspace's Gmail connection, as its row's Disconnect does. */
async function disconnect(workspaceId: string, commandId: string): Promise<void> {
  const listed = await asUser(`http://cockpit.test/v1/workspaces/${workspaceId}/connections`);
  const [held] = ((await listed.json()) as { sourceAccounts: { id: string }[] }).sourceAccounts;
  const res = await asUser('http://cockpit.test/v1/commands/disconnect_source_account', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ commandId, issuedAt: new Date().toISOString(), workspaceId, sourceAccountId: held!.id }),
  });
  expect(res.status).toBe(200);
}

/** The Items whose clean-up has been asked for, by id. */
function cleanUpsAskedFor(): Promise<string[]> {
  return inTheStore((sql) => [...sql.exec<{ item_id: string }>('SELECT item_id FROM rewrite_history')].map((row) => row.item_id));
}

/**
 * Waits until `count` Items have had their clean-up asked for - the last thing
 * a run does, for a run that arms nothing after it.
 */
async function cleanUpsReach(count: number): Promise<void> {
  for (let waited = 0; waited < 10_000; waited += 25) {
    if ((await cleanUpsAskedFor()).length >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`fewer than ${count} clean-ups were ever asked for`);
}

function sealedCredential(): Promise<string> {
  return inTheStore(
    (sql) =>
      [...sql.exec<{ encrypted_credential: string }>("SELECT encrypted_credential FROM connector_accounts WHERE connector_id = 'gmail'")][0]!
        .encrypted_credential,
  );
}

beforeEach(async () => {
  await applyD1Migrations(env.DB, inject('migrations'));
  await startFromEmpty();
  await seedRegister();
  await alsoWorkspaces();
  gmailIsEmpty();
});

describe('Capture', () => {
  describe('every conversation labelled Cockpit is exactly one open Item in the connecting Workspace’s Inbox', () => {
    it('three labelled at connect are three Tasks there, carrying what each conversation says, and none elsewhere', async () => {
      mailboxWith(3);
      await connect();

      await checksSettle();

      const items = await inboxOf();
      expect(items.map((item) => item.title).sort()).toEqual(['Subject 0', 'Subject 1', 'Subject 2']);
      expect(items.find((item) => item.title === 'Subject 1')).toMatchObject({
        description: 'Text 1',
        sender: 'Pieter Claes',
        sourceId: 'thread-001',
        sourceLink: 'https://mail.google.com/mail/?authuser=anna%40example.com#all/thread-001',
        typeId: TASK_TYPE_ID,
      });
      expect(await inboxOf(OTHER_WORKSPACE_ID)).toEqual([]);
    });

    it('none labelled is no Items, and the row reads when it was last checked', async () => {
      mailboxWith(0);
      await connect();

      await checksSettle();

      expect(await inboxOf()).toEqual([]);
      expect(await rowOf()).toMatchObject({ lastTestedAt: expect.any(String), failingBecause: null });
    });

    it('bringing them in again, after connecting the same mailbox again, still leaves three', async () => {
      mailboxWith(3);
      await connect();
      await checksSettle();

      await connect(granted('anna-refresh-again'));
      await checksSettle();

      expect(await inboxOf()).toHaveLength(3);
      expect(gmailCalls.filter((call) => call.startsWith('threads?'))).toHaveLength(2);
    });

    it('120 across several pages are 120 Items, over successive runs', async () => {
      mailboxWith(120);
      await connect();

      const runs = await checksSettle();

      const items = await inboxOf();
      expect(items).toHaveLength(120);
      expect(new Set(items.map((item) => item.sourceId)).size).toBe(120);
      expect(runs).toBeGreaterThan(1);
    });

    it('a run that stops after the first page resumes at the second, and makes no Item twice', async () => {
      mailboxWith(80);
      await connect();
      gmailAnswersWith(503, (call) => call.startsWith('threads?') && call.includes('pageToken=50'));

      await checksSettle();
      // The next run, five minutes on.
      await aCheckRuns();
      await checksSettle();

      const listed = gmailCalls.filter((call) => call.startsWith('threads?'));
      const failedAt = listed.findIndex((call) => call.includes('pageToken=50'));
      expect(listed.slice(failedAt, failedAt + 2).every((call) => call.includes('pageToken=50'))).toBe(true);
      expect(listed.slice(failedAt + 1).some((call) => !call.includes('pageToken'))).toBe(false);
      const items = await inboxOf();
      expect(items).toHaveLength(80);
      expect(new Set(items.map((item) => item.sourceId)).size).toBe(80);
    });

    it('one made just before a check stopped is not made again, and is cleaned up like the rest', async () => {
      mailboxWith(2);
      // The Item a stopped check made, without the record of which
      // conversation it came from that the check would have written next.
      whileGmailIsAsked(
        (call) => call.startsWith('threads?'),
        async () => {
          const named = `gmail:${WORKSPACE_ID}:${ANNA.subject}:thread-000`;
          const answer = await storeNamed(ACCOUNT_NAME).applyChange(ACCOUNT_NAME, 'capture_item', {
            commandId: await derivedUuid(`capture:${named}`),
            issuedAt: new Date().toISOString(),
            workspaceId: WORKSPACE_ID,
            itemId: await derivedUuid(`item:${named}`),
            title: 'Subject 0',
            message: 'Text 0',
            typeId: TASK_TYPE_ID,
            capturedFrom: { source: 'mail', sourceId: 'thread-000', sourceLink: 'https://mail.google.com/mail/#all/thread-000' },
          });
          expect(answer.status).toBe('ok');
        },
      );
      await connect();

      await checksSettle();

      const items = await inboxOf();
      expect(items).toHaveLength(2);
      expect((await cleanUpsAskedFor()).sort()).toEqual(items.map((item) => item.id).sort());
    });

    it('the same mailbox connected to two Workspaces gives each its own Item', async () => {
      mailboxWith(2);
      await connect(granted('anna-in-work'));
      await connect(granted('anna-in-atlas'), OTHER_WORKSPACE_ID);

      await checksSettle();

      const inWork = await inboxOf();
      const inAtlas = await inboxOf(OTHER_WORKSPACE_ID);
      expect(inWork).toHaveLength(2);
      expect(inAtlas).toHaveLength(2);
      expect(inWork.some((item) => inAtlas.some((other) => other.id === item.id))).toBe(false);
    });
  });
});

describe('Capture', () => {
  describe('a conversation labelled after connecting is one open Item within the next check, once', () => {
    it('one labelled between two runs is one more Item after the second, and a reply in it adds nothing', async () => {
      mailboxWith(1);
      await connect();
      await checksSettle();
      expect(await inboxOf()).toHaveLength(1);

      labelledAfterwards(['thread-later']);
      await aCheckRuns();

      expect((await inboxOf()).map((item) => item.sourceId).sort()).toEqual(['thread-000', 'thread-later']);
      expect(historyReadsFrom()).toEqual(['777']);

      // A reply in either arrives as a message without the label.
      gmailHolds({
        historyId: '950',
        history: [
          historyRecord('901', { added: 'm-reply', threadId: 'thread-later', labelIds: ['INBOX', 'UNREAD'] }),
          historyRecord('902', { added: 'm-reply-2', threadId: 'thread-000', labelIds: ['INBOX', 'UNREAD'] }),
        ],
      });
      const readsBefore = gmailCalls.length;
      await aCheckRuns();

      expect(await inboxOf()).toHaveLength(2);
      expect(historyReadsFrom()).toEqual(['777', '900']);
      expect(gmailCalls.slice(readsBefore).some((call) => call.startsWith('threads/'))).toBe(false);
    });

    it('one brought in by a run is a change the live-updates stream tells open tabs of', async () => {
      mailboxWith(1);
      await connect();
      await checksSettle();
      const before = await storeNamed(ACCOUNT_NAME).changesSince(ACCOUNT_NAME, '2026-01-01T00:00:00.000Z');
      if (before.status !== 'ok') throw new Error('the store could not be read');

      labelledAfterwards(['thread-later']);
      await aCheckRuns();

      const after = await storeNamed(ACCOUNT_NAME).changesSince(ACCOUNT_NAME, before.value.cursor);
      if (after.status !== 'ok') throw new Error('the store could not be read');
      expect(after.value.events).toEqual([
        expect.objectContaining({ type: 'snapshot_invalidated', workspaceId: WORKSPACE_ID }),
      ]);
    });

    it('one whose read fails is brought in by the next run, which reads from the same position', async () => {
      mailboxWith(1);
      await connect();
      await checksSettle();
      labelledAfterwards(['thread-later']);
      gmailAnswersWith(503, (call) => call.startsWith('threads/thread-later'));

      await aCheckRuns();
      expect(await inboxOf()).toHaveLength(1);
      await aCheckRuns();

      expect((await inboxOf()).map((item) => item.sourceId).sort()).toEqual(['thread-000', 'thread-later']);
      expect(historyReadsFrom()).toEqual(['777', '777']);
    });

    it('one made just before a run stopped, with no link yet, is not made again and is cleaned up like the rest', async () => {
      mailboxWith(1);
      await connect();
      await checksSettle();
      labelledAfterwards(['thread-later']);
      whileGmailIsAsked(
        (call) => call.startsWith('history?'),
        async () => {
          const named = `gmail:${WORKSPACE_ID}:${ANNA.subject}:thread-later`;
          const answer = await storeNamed(ACCOUNT_NAME).applyChange(ACCOUNT_NAME, 'capture_item', {
            commandId: await derivedUuid(`capture:${named}`),
            issuedAt: new Date().toISOString(),
            workspaceId: WORKSPACE_ID,
            itemId: await derivedUuid(`item:${named}`),
            title: 'Subject thread-later',
            message: 'Text thread-later',
            typeId: TASK_TYPE_ID,
            capturedFrom: { source: 'mail', sourceId: 'thread-later', sourceLink: 'https://mail.google.com/mail/#all/thread-later' },
          });
          expect(answer.status).toBe('ok');
        },
      );

      await aCheckRuns();

      const items = await inboxOf();
      expect(items).toHaveLength(2);
      expect((await cleanUpsAskedFor()).sort()).toEqual(items.map((item) => item.id).sort());
    });

    it('several history pages are all read, and the position is the last one’s', async () => {
      mailboxWith(1);
      await connect();
      await checksSettle();
      // A hundred records is a page: the hundred-and-first is on the second.
      labelledAfterwards([...Array.from({ length: 100 }, () => 'thread-first'), 'thread-second'], '1200');

      await aCheckRuns();

      expect((await inboxOf()).map((item) => item.sourceId).sort()).toEqual(['thread-000', 'thread-first', 'thread-second']);
      expect(gmailCalls.filter((call) => call.startsWith('history?'))).toHaveLength(2);

      await aCheckRuns();
      expect(historyReadsFrom().at(-1)).toBe('1200');
    });

    it('more labelled at once than one check can read are all brought in, over successive runs', async () => {
      mailboxWith(1);
      await connect();
      await checksSettle();
      const later = Array.from({ length: 45 }, (_, at) => `thread-later-${at}`);
      labelledAfterwards(later);

      await runsSettle();

      expect((await inboxOf()).map((item) => item.sourceId).sort()).toEqual(['thread-000', ...later].sort());
    });

    it('a position Gmail no longer keeps starts the full reconcile, which brings in what is labelled and missing', async () => {
      mailboxWith(1);
      await connect();
      await checksSettle();
      // Labelled while the position had lapsed: no history record to find it by.
      threadsHeld.push({ id: 'thread-missed', labelled: true, answer: plainThread('thread-missed', 'Missed', 'Missed text') });
      gmailHolds({ threads: threadsHeld, historyLapsed: true, historyId: '3000' });

      await aCheckRuns();

      expect((await inboxOf()).map((item) => item.sourceId).sort()).toEqual(['thread-000', 'thread-missed']);

      // The fresh position was recorded first: the next run reads from it.
      gmailHolds({ historyLapsed: false });
      await aCheckRuns();
      expect(historyReadsFrom().at(-1)).toBe('3000');
    });
  });
});

type HistoryChange = Parameters<typeof historyRecord>[1];
type Held = 'labelled' | 'unlabelled' | 'binned' | 'deleted';

/** The conversation as Gmail holds it now: labelled, with the label taken off, in the bin, or deleted for good. */
function nowIs(threadId: string, held: Held): void {
  threadsHeld = threadsHeld.filter((one) => one.id !== threadId);
  if (held !== 'deleted') {
    threadsHeld.push({
      id: threadId,
      labelled: held === 'labelled',
      answer: plainThread(threadId, `Subject ${threadId}`, `Text ${threadId}`, {
        labelled: held !== 'unlabelled',
        trashed: held === 'binned',
      }),
    });
  }
  gmailHolds({ threads: threadsHeld });
}

/** What Gmail's history records since the last check: one record per change from `from`, and the position moved on to `now`. */
function historySays(changes: HistoryChange[], { from = 778, now = '900' } = {}): void {
  gmailHolds({ historyId: now, history: changes.map((change, at) => historyRecord(String(from + at), change)) });
}

const labelOff = (threadId: string): HistoryChange => ({
  unlabelled: `m-${threadId}`,
  threadId,
  with: [COCKPIT_LABEL_ID],
  labelIds: ['INBOX'],
});
const labelOn = (threadId: string): HistoryChange => ({
  labelled: `m-${threadId}`,
  threadId,
  with: [COCKPIT_LABEL_ID],
  labelIds: ['INBOX', COCKPIT_LABEL_ID],
});

/** A conversation's Item as the store holds it: its id, and whether it is open, done or dismissed. */
async function itemFor(threadId: string, workspaceId = WORKSPACE_ID): Promise<{ id: string; is: 'open' | 'done' | 'dismissed' } | null> {
  const [row] = await inTheStore((sql) => [
    ...sql.exec<{ id: string; completed_at: string | null; deleted_at: string | null }>(
      "SELECT id, completed_at, deleted_at FROM items WHERE source = 'mail' AND source_id = ? AND workspace_id = ?",
      threadId,
      workspaceId,
    ),
  ]);
  if (!row) return null;
  return { id: row.id, is: row.deleted_at ? 'dismissed' : row.completed_at ? 'done' : 'open' };
}

/**
 * Marks an Item done, dismisses it, or takes either back, as its row's own
 * menu does - and lets the check that brings forward finish, unless told the
 * person acts while a check is already part-way through.
 */
async function personMarks(
  itemId: string,
  as: 'done' | 'dismissed' | 'reopened' | 'undismissed',
  { checkFinishes = true } = {},
): Promise<void> {
  const dismissing = as === 'dismissed' || as === 'undismissed';
  const res = await asUser(`http://cockpit.test/v1/commands/${dismissing ? 'set_dismissed' : 'set_done'}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      commandId: crypto.randomUUID(),
      issuedAt: new Date().toISOString(),
      workspaceId: WORKSPACE_ID,
      itemId,
      ...(dismissing ? { dismissed: as === 'dismissed' } : { done: as === 'done' }),
    }),
  });
  expect(res.status).toBe(200);
  if (checkFinishes) await runningCheckFinishes();
}

/** Whether Gmail holds the conversation labelled Cockpit now. */
function labelIsOn(threadId: string): boolean {
  return threadsHeld.find((one) => one.id === threadId)!.labelled;
}

/** The changes to this conversation's labels Gmail was asked for, oldest first: `off` or `on`. */
function labelChangesAskedOf(threadId: string): ('off' | 'on')[] {
  return gmailModifies
    .filter((one) => one.threadId === threadId)
    .map((one) => {
      expect([...(one.addLabelIds ?? []), ...(one.removeLabelIds ?? [])]).toEqual([COCKPIT_LABEL_ID]);
      return (one.addLabelIds ?? []).length > 0 ? 'on' : 'off';
    });
}

/** How many changes the account's log holds. */
function changesLogged(): Promise<number> {
  return inTheStore((sql) => [...sql.exec<{ n: number }>('SELECT count(*) AS n FROM commands')][0]!.n);
}

/** Runs the check until it has nothing more to do before five minutes from now. */
async function runsSettle(): Promise<void> {
  await aCheckRuns();
  await checksSettle();
}

describe('Capture', () => {
  describe('a conversation’s Item is open exactly while the conversation carries the label', () => {
    it.each([
      { situation: 'the label taken off in Gmail', before: 'open', held: 'unlabelled', change: labelOff('thread-000'), becomes: 'done' },
      {
        situation: 'its mail moved to the bin',
        before: 'open',
        held: 'binned',
        change: { labelled: 'm-0', threadId: 'thread-000', with: ['TRASH'], labelIds: ['TRASH', COCKPIT_LABEL_ID] },
        becomes: 'done',
      },
      {
        situation: 'its mail deleted for good',
        before: 'open',
        held: 'deleted',
        change: { deleted: 'm-0', threadId: 'thread-000' },
        becomes: 'done',
      },
      { situation: 'the label put back on a done conversation', before: 'done', held: 'labelled', change: labelOn('thread-000'), becomes: 'open' },
      {
        situation: 'the label put back on a dismissed conversation',
        before: 'dismissed',
        held: 'labelled',
        change: labelOn('thread-000'),
        becomes: 'open',
      },
    ] as { situation: string; before: 'open' | 'done' | 'dismissed'; held: Held; change: HistoryChange; becomes: 'open' | 'done' }[])(
      '$situation leaves the same Item $becomes at the next check',
      async ({ before, held, change, becomes }) => {
        mailboxWith(2);
        await connect();
        await checksSettle();
        const item = (await itemFor('thread-000'))!;
        if (before !== 'open') await personMarks(item.id, before);

        nowIs('thread-000', held);
        historySays([change]);
        await aCheckRuns();

        expect(await itemFor('thread-000')).toEqual({ id: item.id, is: becomes });
        expect(await itemFor('thread-001')).toMatchObject({ is: 'open' });
      },
    );

    it('the label taken off a conversation that never had an Item makes nothing, and reads nothing', async () => {
      mailboxWith(1);
      await connect();
      await checksSettle();

      historySays([labelOff('thread-unlabelled')]);
      await aCheckRuns();

      expect(await itemFor('thread-unlabelled')).toBeNull();
      expect(gmailCalls.some((call) => call.startsWith('threads/thread-unlabelled'))).toBe(false);
      expect(await itemFor('thread-000')).toMatchObject({ is: 'open' });
    });

    it('the label taken off a mailbox connected to two Workspaces marks both Items done', async () => {
      mailboxWith(1);
      await connect(granted('anna-in-work'));
      await connect(granted('anna-in-atlas'), OTHER_WORKSPACE_ID);
      await checksSettle();

      nowIs('thread-000', 'unlabelled');
      historySays([labelOff('thread-000')]);
      await aCheckRuns();

      expect(await itemFor('thread-000')).toMatchObject({ is: 'done' });
      expect(await itemFor('thread-000', OTHER_WORKSPACE_ID)).toMatchObject({ is: 'done' });
    });

    it('the label taken off more conversations at once than one check can read marks every one done, over successive runs', async () => {
      mailboxWith(45);
      await connect();
      await checksSettle();

      const all = threadsHeld.filter((one) => one.labelled).map((one) => one.id);
      for (const id of all) nowIs(id, 'unlabelled');
      historySays(all.map(labelOff));
      await runsSettle();

      const still = [];
      for (const id of all) if ((await itemFor(id))?.is !== 'done') still.push(id);
      expect(still).toEqual([]);
    });
  });

  describe('the full reconcile marks done only from a complete listing of what is labelled', () => {
    /** 120 labelled - three pages - brought in, then one unlabelled and one done, found only by listing them all again. */
    async function relistedAfter(): Promise<{ unlabelled: string; done: string }> {
      mailboxWith(120);
      await connect();
      await checksSettle();
      await personMarks((await itemFor('thread-110'))!.id, 'done');
      // Neither in any history record: only the listing finds them - the
      // label Cockpit took off put back on, and another taken off.
      nowIs('thread-110', 'labelled');
      nowIs('thread-005', 'unlabelled');
      gmailHolds({ historyLapsed: true, historyId: '3000' });
      return { unlabelled: 'thread-005', done: 'thread-110' };
    }

    it('an open Item whose conversation is no longer labelled is done once the last page is in, and a done one that is labelled is open again', async () => {
      const { unlabelled, done } = await relistedAfter();

      await runsSettle();

      expect(await itemFor(unlabelled)).toMatchObject({ is: 'done' });
      expect(await itemFor(done)).toMatchObject({ is: 'open' });
      expect(await itemFor('thread-006')).toMatchObject({ is: 'open' });
    });

    it('a listing that fails after page one of three marks nothing done, and the next run resumes it', async () => {
      const { unlabelled } = await relistedAfter();
      gmailAnswersWith(503, (call) => call.startsWith('threads?') && call.includes('pageToken=50'));

      await aCheckRuns();
      expect(await itemFor(unlabelled)).toMatchObject({ is: 'open' });

      const listedBefore = gmailCalls.filter((call) => call.startsWith('threads?')).length;
      await runsSettle();

      const listed = gmailCalls.filter((call) => call.startsWith('threads?')).slice(listedBefore);
      expect(listed[0]).toContain('pageToken=50');
      expect(await itemFor(unlabelled)).toMatchObject({ is: 'done' });
    });

    it('a mailbox with no label called Cockpit fails the row and marks nothing done', async () => {
      mailboxWith(2);
      await connect();
      await checksSettle();
      nowIs('thread-000', 'unlabelled');
      gmailHolds({ labels: labelsAnswer({ cockpit: false }), historyLapsed: true });

      await aCheckRuns();

      expect((await rowOf()).failingBecause).toBe(NO_LABEL);
      expect(await itemFor('thread-000')).toMatchObject({ is: 'open' });
      expect(await itemFor('thread-001')).toMatchObject({ is: 'open' });
    });

    it('one the listing missed but that is still labelled when read stays open', async () => {
      mailboxWith(2);
      await connect();
      await checksSettle();
      // Listed by nothing - as a conversation a new reply moves between two
      // pages being read - but labelled when read.
      threadsHeld = threadsHeld.map((one) => (one.id === 'thread-001' ? { ...one, labelled: false } : one));
      gmailHolds({ threads: threadsHeld, historyLapsed: true });

      await runsSettle();

      expect(await itemFor('thread-001')).toMatchObject({ is: 'open' });
    });
  });

  describe('Gmail saying again what an Item already shows changes nothing', () => {
    it.each([
      { situation: 'the label taken off a conversation whose Item is done', done: true, change: labelOff('thread-000'), held: 'unlabelled' },
      { situation: 'the label put on a conversation whose Item is open', done: false, change: labelOn('thread-000'), held: 'labelled' },
    ] as { situation: string; done: boolean; change: HistoryChange; held: Held }[])(
      '$situation: no change, and nothing more in the log',
      async ({ done, change, held }) => {
        mailboxWith(1);
        await connect();
        await checksSettle();
        if (done) await personMarks((await itemFor('thread-000'))!.id, 'done');
        const before = await itemFor('thread-000');
        const logged = await changesLogged();

        nowIs('thread-000', held);
        historySays([change]);
        await aCheckRuns();

        expect(await itemFor('thread-000')).toEqual(before);
        expect(await changesLogged()).toBe(logged);
      },
    );
  });

  describe('the nightly sweep corrects what the history missed', () => {
    it('a label taken off that the history never reported is done after the nightly run', async () => {
      mailboxWith(2);
      await connect();
      await checksSettle();
      nowIs('thread-001', 'unlabelled');

      await aCheckRuns();
      expect(await itemFor('thread-001')).toMatchObject({ is: 'open' });

      await handleScheduled({} as never, env);
      await runsSettle();

      expect(await itemFor('thread-001')).toMatchObject({ is: 'done' });
      expect(await itemFor('thread-000')).toMatchObject({ is: 'open' });
    });

    it('the nightly run landing while a check reads the history lists the mailbox from its first page', async () => {
      mailboxWith(1);
      await connect();
      await checksSettle();
      // Two history pages; the nightly run lands while the first is read,
      // and the second does not answer.
      labelledAfterwards([...Array.from({ length: 100 }, () => 'thread-first'), 'thread-second'], '1200');
      whileGmailIsAsked(
        (call) => call.startsWith('history?'),
        () => handleScheduled({} as never, env),
      );
      gmailAnswersWith(503, (call) => call.startsWith('history?') && call.includes('pageToken=100'));

      const listedBefore = gmailCalls.filter((call) => call.startsWith('threads?')).length;
      await runsSettle();

      const listed = gmailCalls.filter((call) => call.startsWith('threads?')).slice(listedBefore);
      expect(listed[0]).toBeDefined();
      expect(listed[0]).not.toContain('pageToken');
      expect((await inboxOf()).map((item) => item.sourceId).sort()).toEqual(['thread-000', 'thread-first', 'thread-second']);
    });
  });
});

/**
 * "Take the Cockpit label off in Gmail when its task is done in Cockpit"
 * (issue 728). Which side applies when both changed is
 * tests/unit/connectors/gmail.test.ts's; here, that the change reaches Gmail
 * and is never lost on the way.
 */
describe('Capture', () => {
  describe('a Gmail task done or dismissed in Cockpit takes the label off its conversation, and reopening it puts the label back', () => {
    it.each([
      { situation: 'marking it done', steps: ['done'], labelled: false, asked: ['off'] },
      { situation: 'dismissing it', steps: ['dismissed'], labelled: false, asked: ['off'] },
      { situation: 'reopening it after marking it done', steps: ['done', 'reopened'], labelled: true, asked: ['off', 'on'] },
      { situation: 'undoing the dismiss', steps: ['dismissed', 'undismissed'], labelled: true, asked: ['off', 'on'] },
    ] as { situation: string; steps: ('done' | 'dismissed' | 'reopened' | 'undismissed')[]; labelled: boolean; asked: string[] }[])(
      '$situation leaves the conversation labelled: $labelled',
      async ({ steps, labelled, asked }) => {
        mailboxWith(2);
        await connect();
        await checksSettle();
        const item = (await itemFor('thread-000'))!;

        for (const step of steps) await personMarks(item.id, step);

        expect(labelIsOn('thread-000')).toBe(labelled);
        expect(labelChangesAskedOf('thread-000')).toEqual(asked);
        expect(labelChangesAskedOf('thread-001')).toEqual([]);
        // And Gmail reporting it back changes nothing.
        await aCheckRuns();
        expect(await itemFor('thread-000')).toMatchObject({ is: labelled ? 'open' : steps[0] });
      },
    );

    it('an Item of your own marked done asks nothing of Gmail, and the check stays five minutes out', async () => {
      mailboxWith(1);
      await connect();
      await checksSettle();
      const itemId = '018f0000-0000-7000-8000-0000000728c1';
      const captured = await asUser('http://cockpit.test/v1/commands/capture_item', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          commandId: '018f0000-0000-7000-8000-0000000728c2',
          issuedAt: new Date().toISOString(),
          workspaceId: WORKSPACE_ID,
          itemId,
          message: 'Ring the plumber',
          typeId: TASK_TYPE_ID,
        }),
      });
      expect(captured.status).toBe(200);

      await personMarks(itemId, 'done');

      expect(gmailModifies).toEqual([]);
      expect((await nextCheck())! - Date.now()).toBeGreaterThan(4 * 60_000);
    });
  });

  describe('a change made in Cockpit reaches Gmail within seconds, not at the next five-minute check', () => {
    it('marking a Gmail task done brings the check forward, which takes the label off', async () => {
      mailboxWith(1);
      await connect();
      await checksSettle();
      expect((await nextCheck())! - Date.now()).toBeGreaterThan(4 * 60_000);

      // Nobody runs a check: the one marking it done brought forward does.
      await personMarks((await itemFor('thread-000'))!.id, 'done');

      expect(labelChangesAskedOf('thread-000')).toEqual(['off']);
      expect(labelIsOn('thread-000')).toBe(false);
    });
  });

  describe('a change made in Cockpit waits until Gmail has it, and none is lost', () => {
    async function connectedWithOne(): Promise<string> {
      mailboxWith(1);
      await connect();
      await checksSettle();
      return (await itemFor('thread-000'))!.id;
    }

    it('Google refusing the sign-in leaves the task done and the row failing, and the next check that works takes the label off', async () => {
      const itemId = await connectedWithOne();
      gmailAnswersWith(401, (call) => call.endsWith('/modify'), { once: false });

      await personMarks(itemId, 'done');

      expect(await itemFor('thread-000')).toMatchObject({ is: 'done' });
      expect((await rowOf()).failingBecause).toBe(SIGN_IN_REFUSED);
      expect(labelIsOn('thread-000')).toBe(true);

      gmailAnswersAgain();
      await aCheckRuns();

      expect(labelIsOn('thread-000')).toBe(false);
      expect(await itemFor('thread-000')).toMatchObject({ is: 'done' });
      expect((await rowOf()).failingBecause).toBeNull();
    });

    it.each([
      {
        situation: 'Gmail answering 503 to the change',
        fails: (call: string) => call.endsWith('/modify'),
        applied: false,
        asked: ['off'],
      },
      { situation: 'a check that stops before asking Gmail', fails: (call: string) => call === 'labels', applied: false, asked: ['off'] },
      {
        situation: 'a check that stops after Gmail took the label off, before that was recorded',
        fails: (call: string) => call.endsWith('/modify'),
        applied: true,
        asked: ['off', 'off'],
      },
    ])('$situation: the next check takes the label off, and the one after asks nothing more', async ({ fails, applied, asked }) => {
      const itemId = await connectedWithOne();
      gmailAnswersWith(503, fails, { applied });

      await personMarks(itemId, 'done');
      expect(labelIsOn('thread-000')).toBe(!applied);

      await aCheckRuns();
      await aCheckRuns();

      expect(labelIsOn('thread-000')).toBe(false);
      expect(labelChangesAskedOf('thread-000')).toEqual(asked);
      expect(await itemFor('thread-000')).toMatchObject({ is: 'done' });
    });

    it('disconnecting while a change waits drops it: connecting again asks nothing of Gmail', async () => {
      const itemId = await connectedWithOne();
      gmailAnswersWith(503, (call) => call === 'labels');
      await personMarks(itemId, 'done');

      await disconnect(WORKSPACE_ID, '018f0000-0000-7000-8000-0000000728d1');
      await connect(granted('anna-refresh-again'));
      await checksSettle();

      expect(gmailModifies).toEqual([]);
      expect(labelIsOn('thread-000')).toBe(true);
    });

    it('done in one tab and reopened in another before Gmail is asked leaves the later: the label on', async () => {
      const itemId = await connectedWithOne();
      gmailAnswersWith(503, (call) => call === 'labels', { once: false });
      await personMarks(itemId, 'done');
      await personMarks(itemId, 'reopened');

      gmailAnswersAgain();
      await aCheckRuns();

      expect(labelChangesAskedOf('thread-000')).toEqual(['on']);
      expect(labelIsOn('thread-000')).toBe(true);
      expect(await itemFor('thread-000')).toMatchObject({ is: 'open' });
    });

    it.each([
      { situation: 'Gmail answering 429', status: 429, reason: undefined },
      { situation: 'Gmail answering 403 for a rate limit', status: 403, reason: 'userRateLimitExceeded' },
    ])('$situation to the change leaves it waiting, reads on, and the next check takes the label off', async ({ status, reason }) => {
      const itemId = await connectedWithOne();
      gmailAnswersWith(status, (call) => call.endsWith('/modify'), { reason });

      const before = gmailCalls.length;
      await personMarks(itemId, 'done');

      const run = gmailCalls.slice(before);
      expect(run.some((call) => call.startsWith('history?'))).toBe(true);
      expect(labelIsOn('thread-000')).toBe(true);
      expect((await rowOf()).failingBecause).toBeNull();

      await aCheckRuns();

      expect(labelIsOn('thread-000')).toBe(false);
      expect(await itemFor('thread-000')).toMatchObject({ is: 'done' });
    });
  });

  describe('a change Gmail will never take is given up on, and holds up nothing else', () => {
    it.each([
      { situation: '400', status: 400, reason: undefined },
      { situation: '403 for want of permission', status: 403, reason: 'insufficientPermissions' },
    ])('Gmail answering $situation to one conversation’s change: the task stays done, the other conversation’s change and the history still go through, and it is asked no more', async ({ status, reason }) => {
      mailboxWith(2);
      await connect();
      await checksSettle();
      const refused = (call: string) => call === 'threads/thread-000/modify';
      gmailAnswersWith(status, refused, { once: false, reason });
      const logged = vi.spyOn(console, 'log');
      try {
        const before = gmailCalls.length;
        await personMarks((await itemFor('thread-000'))!.id, 'done');
        expect(gmailCalls.slice(before).some((call) => call.startsWith('history?'))).toBe(true);
        await personMarks((await itemFor('thread-001'))!.id, 'done');
        await aCheckRuns();

        expect(await itemFor('thread-000')).toMatchObject({ is: 'done' });
        expect(labelIsOn('thread-000')).toBe(true);
        expect(gmailCalls.filter(refused)).toHaveLength(1);
        expect(labelIsOn('thread-001')).toBe(false);
        expect((await rowOf()).failingBecause).toBeNull();
        // Logged by the connection, the mark it follows and Gmail's answer, and nothing of the mail or the sign-in.
        const warning = logged.mock.calls.map(([line]) => String(line)).find((line) => line.includes('refused a label change'));
        expect(JSON.parse(warning!)).toMatchObject({ level: 'warn', data: { follows: 'label', status } });
        expect(Object.keys(JSON.parse(warning!).data).sort()).toEqual(['follows', 'sourceAccountId', 'status']);
        expect(warning).not.toContain('thread-000');
        expect(warning).not.toContain('access-for-');
      } finally {
        logged.mockRestore();
      }
    });
  });

  describe('a task dismissed in Cockpit, its label taken off, is left as it is by the full reconcile', () => {
    it('not found by the listing, it is not read again by every check after', async () => {
      mailboxWith(2);
      await connect();
      await checksSettle();
      await personMarks((await itemFor('thread-000'))!.id, 'dismissed');
      gmailHolds({ historyLapsed: true });
      await runsSettle();
      gmailHolds({ historyLapsed: false });

      const before = gmailCalls.length;
      await aCheckRuns();
      await aCheckRuns();

      expect(gmailCalls.slice(before).filter((call) => call.startsWith('threads/thread-000'))).toEqual([]);
      expect(await itemFor('thread-000')).toMatchObject({ is: 'dismissed' });
    });
  });

  describe('a change made in Cockpit and not yet in Gmail wins', () => {
    it('done in Cockpit while a check reads Gmail still finding the label on: the task stays done, and the next check takes the label off', async () => {
      const itemId = await (async () => {
        mailboxWith(1);
        await connect();
        await checksSettle();
        return (await itemFor('thread-000'))!.id;
      })();
      historySays([labelOn('thread-000')]);
      whileGmailIsAsked(
        (call) => call.startsWith('history?'),
        () => personMarks(itemId, 'done', { checkFinishes: false }),
      );

      await aCheckRuns();
      expect(await itemFor('thread-000')).toMatchObject({ is: 'done' });

      await runningCheckFinishes();
      expect(labelIsOn('thread-000')).toBe(false);
      expect(await itemFor('thread-000')).toMatchObject({ is: 'done' });
    });
  });

  describe('what Gmail changed is never sent back to it', () => {
    it('the label taken off in Gmail and then put back leaves the task open and the label on, asking nothing of Gmail', async () => {
      mailboxWith(1);
      await connect();
      await checksSettle();

      nowIs('thread-000', 'unlabelled');
      historySays([labelOff('thread-000')]);
      await aCheckRuns();
      expect(await itemFor('thread-000')).toMatchObject({ is: 'done' });

      nowIs('thread-000', 'labelled');
      historySays([labelOn('thread-000')], { from: 901, now: '950' });
      await aCheckRuns();

      expect(await itemFor('thread-000')).toMatchObject({ is: 'open' });
      expect(labelIsOn('thread-000')).toBe(true);
      expect(gmailModifies).toEqual([]);
    });
  });
});

describe('Live updates', () => {
  describe('an Item a check marks done is a change open tabs hear of', () => {
    it('the label taken off reaches the live-updates stream', async () => {
      mailboxWith(1);
      await connect();
      await checksSettle();
      const before = await storeNamed(ACCOUNT_NAME).changesSince(ACCOUNT_NAME, '2026-01-01T00:00:00.000Z');
      if (before.status !== 'ok') throw new Error('the store could not be read');

      nowIs('thread-000', 'unlabelled');
      historySays([labelOff('thread-000')]);
      await aCheckRuns();

      const after = await storeNamed(ACCOUNT_NAME).changesSince(ACCOUNT_NAME, before.value.cursor);
      if (after.status !== 'ok') throw new Error('the store could not be read');
      expect(after.value.events).toEqual([expect.objectContaining({ type: 'snapshot_invalidated', workspaceId: WORKSPACE_ID })]);
    });
  });
});

describe('Connector management', () => {
  describe('the account checks Gmail while it holds a Gmail connection, and only then', () => {
    it('checks at once on the first connection, every five minutes after, and stops with the last disconnect', async () => {
      mailboxWith(1);
      expect(await nextCheck()).toBeNull();

      // Nobody runs the first check: connecting arms it for now, and it runs.
      await connect();
      await runningCheckFinishes();
      expect((await rowOf()).lastTestedAt).not.toBeNull();

      await aCheckRuns();
      const next = (await nextCheck())! - Date.now();
      expect(next).toBeGreaterThan(4 * 60_000);
      expect(next).toBeLessThanOrEqual(5 * 60_000);

      await connect(granted('anna-in-atlas'), OTHER_WORKSPACE_ID);

      await disconnect(WORKSPACE_ID, '018f0000-0000-7000-8000-0000000725a1');
      expect(await nextCheck()).not.toBeNull();
      await disconnect(OTHER_WORKSPACE_ID, '018f0000-0000-7000-8000-0000000725a2');
      expect(await nextCheck()).toBeNull();
      expect(await aCheckRuns()).toBe(false);
    });

    it('the nightly run arms the check again for an account holding a connection but no alarm, and for no other', async () => {
      mailboxWith(1);
      await connect();
      await runInDurableObject(storeNamed(ACCOUNT_NAME), (_instance, state) => state.storage.deleteAlarm());

      await handleScheduled({} as never, env);

      expect(await nextCheck()).not.toBeNull();
      expect(
        await runInDurableObject(storeNamed('tenant-ada'), (_instance, state) => state.storage.getAlarm()),
      ).toBeNull();
    });
  });

  describe('a check part-way through gives way to what the person does to the connection meanwhile', () => {
    it('disconnecting stops it bringing anything more in, and what it brought in stays', async () => {
      mailboxWith(5);
      whileGmailIsAsked(
        (call) => call.startsWith('threads/thread-002'),
        () => disconnect(WORKSPACE_ID, '018f0000-0000-7000-8000-0000000725b1'),
      );
      await connect();

      await cleanUpsReach(2);

      expect((await inboxOf()).map((item) => item.sourceId).sort()).toEqual(['thread-000', 'thread-001']);
      expect(gmailCalls).not.toContain('threads/thread-003?format=full');
      expect(await nextCheck()).toBeNull();
    });

    it('connecting again keeps the new sign-in, not the old one the check refreshed meanwhile', async () => {
      mailboxWith(3);
      let connectedAgain = '';
      whileGmailIsAsked(
        (call) => call === 'refresh',
        async () => {
          await connect(granted('anna-refresh-again'));
          connectedAgain = await sealedCredential();
        },
      );
      await connect(granted('anna-refresh', 30));

      await checksSettle();

      expect(connectedAgain).not.toBe('');
      expect(await sealedCredential()).toBe(connectedAgain);
      expect(await inboxOf()).toHaveLength(3);
    });
  });

  describe('a Gmail connection that cannot be checked says why, and changes nothing', () => {
    it('no label called Cockpit fails the row and lists nothing', async () => {
      mailboxWith(3);
      gmailHolds({ labels: labelsAnswer({ cockpit: false }) });
      await connect();

      await checksSettle();

      expect(await inboxOf()).toEqual([]);
      expect(gmailCalls.some((call) => call.startsWith('threads'))).toBe(false);
      expect(await rowOf()).toMatchObject({ failingBecause: NO_LABEL, lastTestedAt: null });
    });

    it('Google refusing the refresh fails the row with the sign-in', async () => {
      mailboxWith(3);
      googleRefreshes('refuses');
      await connect(granted('anna-refresh', 30));

      await checksSettle();

      expect(await inboxOf()).toEqual([]);
      expect((await rowOf()).failingBecause).toBe(SIGN_IN_REFUSED);
    });

    it('an access token that has lapsed is refreshed, sealed again, and the check runs', async () => {
      mailboxWith(3);
      await connect(granted('anna-refresh', 30));

      await checksSettle();
      // A second run reads with the token the first sealed, rather than
      // refreshing again.
      await aCheckRuns();

      expect(await inboxOf()).toHaveLength(3);
      expect(refreshes).toEqual(['anna-refresh']);
      expect(await sealedCredential()).toBeTruthy();
      expect((await rowOf()).failingBecause).toBeNull();
    });

    it.each([
      { situation: 'Gmail answers 503', status: 503 },
      { situation: 'Gmail rate-limits', status: 429 },
      { situation: 'Google answers a refresh with a 503', status: 'refresh' as const },
    ])('$situation, so nothing changes and the next run tries again', async ({ status }) => {
      mailboxWith(3);
      if (status === 'refresh') googleRefreshes('fails');
      else gmailAnswersWith(status, (call) => call === 'labels');
      await connect(granted('anna-refresh', status === 'refresh' ? 30 : 3599));

      await runningCheckFinishes();

      expect(await inboxOf()).toEqual([]);
      expect(await rowOf()).toMatchObject({ lastTestedAt: null, failingBecause: null });
      expect((await nextCheck())! - Date.now()).toBeGreaterThan(4 * 60_000);

      googleRefreshes('answers');
      await aCheckRuns();
      await checksSettle();
      expect(await inboxOf()).toHaveLength(3);
    });
  });
});

/**
 * "Connect Gmail by star, and bring in conversations starred from then on"
 * (issue 822). Which history records put the star on is
 * tests/unit/connectors/gmail.test.ts's `historyPage`, read for any label;
 * here, that only a star added after connecting ever becomes an Item.
 */
const starOn = (threadId: string): HistoryChange => ({
  labelled: `m-${threadId}`,
  threadId,
  with: [STARRED],
  labelIds: ['INBOX', STARRED],
});
const starOff = (threadId: string): HistoryChange => ({
  unlabelled: `m-${threadId}`,
  threadId,
  with: [STARRED],
  labelIds: ['INBOX'],
});

/**
 * A mailbox at position 777 holding these conversations starred - each by a
 * history record before that position - and one neither starred nor labelled.
 */
function starredBefore(threadIds: string[]): void {
  threadsHeld = [
    ...threadIds.map((id) => ({
      id,
      labelled: false,
      answer: plainThread(id, `Subject ${id}`, `Text ${id}`, { labelled: false, starred: true }),
    })),
    { id: 'thread-plain', labelled: false, answer: plainThread('thread-plain', undefined, undefined, { labelled: false }) },
  ];
  gmailHolds({
    labels: labelsAnswer(),
    historyId: '777',
    threads: threadsHeld,
    history: threadIds.map((id, at) => historyRecord(String(700 + at), starOn(id))),
    historyLapsed: false,
  });
}

/**
 * What Gmail's history records after the first check - one record per change
 * from `from`, the position moving on to `now` - with each conversation it
 * names that the mailbox does not hold yet added, carrying what was put on it.
 */
function afterwards(changes: HistoryChange[], { from = 778, now = '900' } = {}): void {
  for (const change of changes) {
    if (threadsHeld.some((one) => one.id === change.threadId)) continue;
    const marks = 'labelled' in change ? change.with : [];
    threadsHeld.push({
      id: change.threadId,
      labelled: marks.includes(COCKPIT_LABEL_ID),
      answer: plainThread(change.threadId, `Subject ${change.threadId}`, `Text ${change.threadId}`, {
        labelled: marks.includes(COCKPIT_LABEL_ID),
        starred: marks.includes(STARRED),
      }),
    });
  }
  gmailHolds({ historyId: now, threads: threadsHeld, history: changes.map((change, at) => historyRecord(String(from + at), change)) });
}

async function broughtInto(workspaceId = WORKSPACE_ID): Promise<string[]> {
  return (await inboxOf(workspaceId)).map((item) => item.sourceId!).sort();
}

describe('Capture', () => {
  describe('by star, only a conversation starred after connecting becomes an Item, and only once', () => {
    it('three starred before connecting are no Items after the first check, which lists nothing', async () => {
      starredBefore(['thread-a', 'thread-b', 'thread-c']);
      await connect(granted('anna-refresh'), WORKSPACE_ID, 'star');

      await checksSettle();

      expect(await inboxOf()).toEqual([]);
      expect(await rowOf()).toMatchObject({ follows: 'star', lastTestedAt: expect.any(String), failingBecause: null });
      expect(gmailCalls.some((call) => call.startsWith('threads'))).toBe(false);
    });

    it('one starred between two checks is one open Task after the second, carrying what the conversation says', async () => {
      starredBefore(['thread-a']);
      await connect(granted('anna-refresh'), WORKSPACE_ID, 'star');
      await checksSettle();

      afterwards([starOn('thread-later')]);
      await aCheckRuns();

      expect(await inboxOf()).toEqual([
        expect.objectContaining({
          title: 'Subject thread-later',
          description: 'Text thread-later',
          sender: 'Pieter Claes',
          sourceId: 'thread-later',
          typeId: TASK_TYPE_ID,
        }),
      ]);
      expect(await itemFor('thread-later')).toMatchObject({ is: 'open' });
      expect(historyReadsFrom()).toEqual(['777']);
      expect(gmailCalls.find((call) => call.startsWith('history?'))).toContain(`labelId=${STARRED}`);
    });

    it('connecting the same mailbox again leaves out what was starred before it', async () => {
      starredBefore(['thread-a', 'thread-b']);
      await connect(granted('anna-refresh'), WORKSPACE_ID, 'star');
      await checksSettle();
      // Starred while connected, and connected again before a check read it.
      afterwards([starOn('thread-later')]);

      await connect(granted('anna-refresh-again'), WORKSPACE_ID, 'star');
      await checksSettle();
      await aCheckRuns();

      expect(await inboxOf()).toEqual([]);
    });

    it.each([
      { situation: 'a position Gmail no longer keeps', lapsed: true },
      { situation: 'the nightly run', lapsed: false },
    ])('the full reconcile after $situation makes nothing of what is starred, and a star after it still counts', async ({ lapsed }) => {
      starredBefore(['thread-a', 'thread-b']);
      await connect(granted('anna-refresh'), WORKSPACE_ID, 'star');
      await checksSettle();

      if (lapsed) {
        gmailHolds({ historyLapsed: true, historyId: '3000' });
        await aCheckRuns();
        gmailHolds({ historyLapsed: false });
      } else {
        await handleScheduled({} as never, env);
      }
      await runsSettle();

      expect(await inboxOf()).toEqual([]);
      // Listed, to close (issue 823), and none read to be brought in.
      expect(gmailCalls.some((call) => call.startsWith(`threads?labelIds=${STARRED}`))).toBe(true);
      expect(gmailCalls.some((call) => call.startsWith('threads/'))).toBe(false);

      afterwards([starOn('thread-later')], lapsed ? { from: 3001, now: '3100' } : {});
      await aCheckRuns();
      expect(await broughtInto()).toEqual(['thread-later']);
    });

    it('one starred before connecting, then unstarred and starred again after, is one open Task', async () => {
      starredBefore(['thread-a']);
      await connect(granted('anna-refresh'), WORKSPACE_ID, 'star');
      await checksSettle();

      afterwards([starOff('thread-a'), starOn('thread-a')]);
      await aCheckRuns();

      expect(await broughtInto()).toEqual(['thread-a']);
      expect(await itemFor('thread-a')).toMatchObject({ is: 'open' });
    });

    it('a star read again, by a run that stopped before moving on from it, is still one Item', async () => {
      starredBefore([]);
      await connect(granted('anna-refresh'), WORKSPACE_ID, 'star');
      await checksSettle();
      afterwards([starOn('thread-one'), starOn('thread-two')]);
      gmailAnswersWith(503, (call) => call.startsWith('threads/thread-two'));

      await aCheckRuns();
      expect(await broughtInto()).toEqual(['thread-one']);
      await aCheckRuns();

      expect(await broughtInto()).toEqual(['thread-one', 'thread-two']);
      expect(historyReadsFrom()).toEqual(['777', '777']);
    });

  });

  describe('the same mailbox connected to two Workspaces, by label and by star, brings into each only what carries its own mark', () => {
    it('the label’s conversations in one, the star’s in the other, each its own Items', async () => {
      threadsHeld = [
        { id: 'thread-labelled', labelled: true, answer: plainThread('thread-labelled') },
        { id: 'thread-starred', labelled: false, answer: plainThread('thread-starred', undefined, undefined, { labelled: false, starred: true }) },
      ];
      gmailHolds({ labels: labelsAnswer(), historyId: '777', threads: threadsHeld, history: [], historyLapsed: false });
      await connect(granted('anna-in-work'));
      await connect(granted('anna-in-atlas'), OTHER_WORKSPACE_ID, 'star');
      await checksSettle();

      afterwards([labelOn('thread-labelled-later'), starOn('thread-starred-later')]);
      await aCheckRuns();

      expect(await broughtInto()).toEqual(['thread-labelled', 'thread-labelled-later']);
      expect(await broughtInto(OTHER_WORKSPACE_ID)).toEqual(['thread-starred-later']);
    });
  });
});

/**
 * "Keep a starred Gmail task in step with its star, both ways" (issue 823).
 * What the push asks, and which side wins, are one path with the label's -
 * proved above; here, that the star is the mark it reads and writes, and that
 * the full reconcile by star lists only to close.
 */
type StarHeld = 'starred' | 'unstarred' | 'binned' | 'deleted';

/** The conversation as Gmail holds it now: starred, unstarred, starred in the bin, or deleted for good. */
function starNowIs(threadId: string, held: StarHeld): void {
  threadsHeld = threadsHeld.filter((one) => one.id !== threadId);
  if (held !== 'deleted') {
    threadsHeld.push({
      id: threadId,
      labelled: false,
      answer: plainThread(threadId, `Subject ${threadId}`, `Text ${threadId}`, {
        labelled: false,
        starred: held !== 'unstarred',
        trashed: held === 'binned',
      }),
    });
  }
  gmailHolds({ threads: threadsHeld });
}

/** Whether Gmail holds the conversation starred now. */
function starIsOn(threadId: string): boolean {
  const { messages } = threadsHeld.find((one) => one.id === threadId)!.answer as { messages: { labelIds: string[] }[] };
  return messages.some((one) => one.labelIds.includes(STARRED));
}

/** The changes to this conversation Gmail was asked for, oldest first: the star `off` or `on`, and nothing else. */
function starChangesAskedOf(threadId: string): ('off' | 'on')[] {
  return gmailModifies
    .filter((one) => one.threadId === threadId)
    .map((one) => {
      expect([...(one.addLabelIds ?? []), ...(one.removeLabelIds ?? [])]).toEqual([STARRED]);
      return (one.addLabelIds ?? []).length > 0 ? 'on' : 'off';
    });
}

/**
 * Connected by star with nothing starred, then these starred after it: each an
 * open Task once a check has run, the position moved on to 900.
 */
async function starredAfterConnecting(threadIds: string[], workspaces: string[] = [WORKSPACE_ID]): Promise<void> {
  starredBefore([]);
  for (const [at, workspaceId] of workspaces.entries()) {
    await connect(granted(`anna-in-${at}`), workspaceId, 'star');
  }
  await checksSettle();
  afterwards(threadIds.map(starOn));
  await aCheckRuns();
}

/** What Gmail's history records after `starredAfterConnecting`'s check: one record per change, past position 900. */
function starsChange(changes: HistoryChange[]): void {
  historySays(changes, { from: 901, now: '950' });
}

describe('Capture', () => {
  describe('a starred conversation’s Item is open exactly while the conversation is starred', () => {
    it.each([
      { situation: 'the star taken off in Gmail', before: 'open', held: 'unstarred', change: starOff('thread-x'), becomes: 'done' },
      {
        situation: 'its mail moved to the bin',
        before: 'open',
        held: 'binned',
        change: { labelled: 'm-x', threadId: 'thread-x', with: ['TRASH'], labelIds: ['TRASH', STARRED] },
        becomes: 'done',
      },
      { situation: 'its mail deleted for good', before: 'open', held: 'deleted', change: { deleted: 'm-x', threadId: 'thread-x' }, becomes: 'done' },
      { situation: 'starred again after being done', before: 'done', held: 'starred', change: starOn('thread-x'), becomes: 'open' },
      { situation: 'starred again after being dismissed', before: 'dismissed', held: 'starred', change: starOn('thread-x'), becomes: 'open' },
    ] as { situation: string; before: 'open' | 'done' | 'dismissed'; held: StarHeld; change: HistoryChange; becomes: 'open' | 'done' }[])(
      '$situation leaves the same Item $becomes at the next check',
      async ({ before, held, change, becomes }) => {
        await starredAfterConnecting(['thread-x', 'thread-y']);
        const item = (await itemFor('thread-x'))!;
        if (before !== 'open') await personMarks(item.id, before);

        starNowIs('thread-x', held);
        starsChange([change]);
        await aCheckRuns();

        expect(await itemFor('thread-x')).toEqual({ id: item.id, is: becomes });
        expect(await itemFor('thread-y')).toMatchObject({ is: 'open' });
      },
    );

    it('the star taken off a conversation that never had an Item makes nothing, and reads nothing', async () => {
      await starredAfterConnecting(['thread-x']);

      starsChange([starOff('thread-plain')]);
      await aCheckRuns();

      expect(await itemFor('thread-plain')).toBeNull();
      expect(gmailCalls.some((call) => call.startsWith('threads/thread-plain'))).toBe(false);
      expect(await itemFor('thread-x')).toMatchObject({ is: 'open' });
    });

    it('connecting the mailbox again reads each open Item once: one still starred stays open, one unstarred meanwhile is done', async () => {
      await starredAfterConnecting(['thread-x', 'thread-y']);
      // Unstarred with no history record a check after connecting again would read.
      starNowIs('thread-y', 'unstarred');
      const before = gmailCalls.length;

      await connect(granted('anna-refresh-again'), WORKSPACE_ID, 'star');
      await checksSettle();
      await aCheckRuns();

      expect(await itemFor('thread-x')).toMatchObject({ is: 'open' });
      expect(await itemFor('thread-y')).toMatchObject({ is: 'done' });
      const reads = gmailCalls.slice(before).filter((call) => call.startsWith('threads/'));
      expect(reads.filter((call) => call.startsWith('threads/thread-x'))).toHaveLength(1);
      expect(reads.filter((call) => call.startsWith('threads/thread-y'))).toHaveLength(1);
    });

    /**
     * One history record naming each of these conversations unstarred - as
     * unstarring many at once in Gmail records it - then a record apiece for
     * the changes after it.
     */
    function unstarredAtOnce(threadIds: string[], after: HistoryChange[] = []): void {
      const records = threadIds.map((id) => historyRecord('901', starOff(id)) as { messages: unknown[]; labelsRemoved: unknown[] });
      const atOnce = { id: '901', messages: records.flatMap((one) => one.messages), labelsRemoved: records.flatMap((one) => one.labelsRemoved) };
      gmailHolds({ historyId: '950', history: [atOnce, ...after.map((change, at) => historyRecord(String(902 + at), change))] });
    }

    it('unstarred among more conversations than a run can read, the one with an Item is still done at the next check', async () => {
      await starredAfterConnecting(['thread-x']);
      starNowIs('thread-x', 'unstarred');
      unstarredAtOnce(['thread-x', ...Array.from({ length: 40 }, (_, at) => `thread-other-${at}`)]);

      await aCheckRuns();

      expect(await itemFor('thread-x')).toMatchObject({ is: 'done' });
      expect(gmailCalls.some((call) => call.startsWith('threads/thread-other'))).toBe(false);
    });

    it('more Items unstarred at once than a run can read lose nothing: a star beside them still comes in, and the nightly read marks each done', async () => {
      const threadIds = Array.from({ length: 31 }, (_, at) => `thread-${String(at).padStart(2, '0')}`);
      await starredAfterConnecting(threadIds);
      for (const id of threadIds) starNowIs(id, 'unstarred');
      starNowIs('thread-later', 'starred');
      unstarredAtOnce(threadIds, [starOn('thread-later')]);

      await aCheckRuns();
      expect(await itemFor('thread-later')).toMatchObject({ is: 'open' });

      await handleScheduled({} as never, env);
      await runsSettle();

      for (const id of threadIds) expect(await itemFor(id)).toMatchObject({ is: 'done' });
      expect(await itemFor('thread-later')).toMatchObject({ is: 'open' });
    });
  });

  describe('the full reconcile by star marks done only from a complete listing of what is starred, and makes nothing', () => {
    /**
     * 120 starred before connecting - three pages listed, none an Item - and
     * three starred after: one then unstarred and one marked done that is
     * still starred, neither in any history record, so only the listing finds them.
     */
    async function relistedAfter(): Promise<void> {
      starredBefore([]);
      for (let at = 0; at < 120; at += 1) starNowIs(`thread-${String(at).padStart(3, '0')}`, 'starred');
      await connect(granted('anna-refresh'), WORKSPACE_ID, 'star');
      await checksSettle();
      afterwards(['thread-kept', 'thread-unstarred', 'thread-done'].map(starOn));
      await aCheckRuns();
      await personMarks((await itemFor('thread-done'))!.id, 'done');
      starNowIs('thread-done', 'starred');
      starNowIs('thread-unstarred', 'unstarred');
      gmailHolds({ historyLapsed: true, historyId: '3000' });
    }

    it('an open Item whose conversation is no longer starred is done once the last page is in, a done one still starred is open again, and nothing is made', async () => {
      await relistedAfter();

      await runsSettle();

      expect(await itemFor('thread-unstarred')).toMatchObject({ is: 'done' });
      expect(await itemFor('thread-done')).toMatchObject({ is: 'open' });
      expect(await itemFor('thread-kept')).toMatchObject({ is: 'open' });
      expect(await broughtInto()).toEqual(['thread-done', 'thread-kept', 'thread-unstarred']);
    });

    it('a listing that fails after page one of three marks nothing done, and the next run resumes it', async () => {
      await relistedAfter();
      gmailAnswersWith(503, (call) => call.startsWith('threads?') && call.includes('pageToken=50'));

      await aCheckRuns();
      expect(await itemFor('thread-unstarred')).toMatchObject({ is: 'open' });

      const listedBefore = gmailCalls.filter((call) => call.startsWith('threads?')).length;
      await runsSettle();

      const listed = gmailCalls.filter((call) => call.startsWith('threads?')).slice(listedBefore);
      expect(listed[0]).toContain('pageToken=50');
      expect(await itemFor('thread-unstarred')).toMatchObject({ is: 'done' });
    });
  });

  describe('a starred task done or dismissed in Cockpit takes the star off its conversation, and reopening it puts the star back', () => {
    it.each([
      { situation: 'marking it done', steps: ['done'], starred: false, asked: ['off'] },
      { situation: 'dismissing it, then undoing the dismiss', steps: ['dismissed', 'undismissed'], starred: true, asked: ['off', 'on'] },
      { situation: 'reopening it after marking it done', steps: ['done', 'reopened'], starred: true, asked: ['off', 'on'] },
    ] as { situation: string; steps: ('done' | 'dismissed' | 'reopened' | 'undismissed')[]; starred: boolean; asked: string[] }[])(
      '$situation leaves the conversation starred: $starred, and no other changed',
      async ({ steps, starred, asked }) => {
        await starredAfterConnecting(['thread-x', 'thread-y']);
        const item = (await itemFor('thread-x'))!;

        for (const step of steps) await personMarks(item.id, step);

        expect(starIsOn('thread-x')).toBe(starred);
        expect(starChangesAskedOf('thread-x')).toEqual(asked);
        expect(starChangesAskedOf('thread-y')).toEqual([]);
      },
    );
  });

  describe('a change made in Cockpit to a starred task wins, and does not come back as Gmail’s', () => {
    it('done in Cockpit, and starred again in Gmail before the star came off: the task stays done, and the next check takes the star off', async () => {
      await starredAfterConnecting(['thread-x']);
      const item = (await itemFor('thread-x'))!;
      gmailAnswersWith(429, (call) => call.endsWith('/modify'));
      // Unstarred and starred again by hand meanwhile, which the check reads.
      starsChange([starOff('thread-x'), starOn('thread-x')]);

      await personMarks(item.id, 'done');
      expect(starIsOn('thread-x')).toBe(true);
      expect(await itemFor('thread-x')).toMatchObject({ is: 'done' });

      await aCheckRuns();

      expect(starIsOn('thread-x')).toBe(false);
      expect(await itemFor('thread-x')).toMatchObject({ is: 'done' });
    });

    it('Cockpit’s own unstar read back from the history changes nothing, and asks Gmail nothing more', async () => {
      await starredAfterConnecting(['thread-x']);
      await personMarks((await itemFor('thread-x'))!.id, 'done');
      const before = await itemFor('thread-x');
      const logged = await changesLogged();

      starsChange([starOff('thread-x')]);
      await aCheckRuns();

      expect(await itemFor('thread-x')).toEqual(before);
      expect(await changesLogged()).toBe(logged);
      expect(starChangesAskedOf('thread-x')).toEqual(['off']);
    });
  });

  describe('the same mailbox starred into two Workspaces keeps both in step with one star', () => {
    it('done in one takes the star off, and the other’s Item is done at its next check', async () => {
      await starredAfterConnecting(['thread-x'], [WORKSPACE_ID, OTHER_WORKSPACE_ID]);
      expect(await itemFor('thread-x', OTHER_WORKSPACE_ID)).toMatchObject({ is: 'open' });

      await personMarks((await itemFor('thread-x'))!.id, 'done');
      expect(starIsOn('thread-x')).toBe(false);
      starsChange([starOff('thread-x')]);
      await aCheckRuns();

      expect(await itemFor('thread-x', OTHER_WORKSPACE_ID)).toMatchObject({ is: 'done' });
    });
  });
});

describe('Connector management', () => {
  describe('a connection by star never fails for want of a label called Cockpit', () => {
    it('a mailbox with no such label reads when it was last checked, and nothing says it is failing', async () => {
      starredBefore([]);
      gmailHolds({ labels: labelsAnswer({ cockpit: false }) });
      await connect(granted('anna-refresh'), WORKSPACE_ID, 'star');
      await checksSettle();

      afterwards([starOn('thread-later')]);
      await aCheckRuns();

      expect(await rowOf()).toMatchObject({ lastTestedAt: expect.any(String), failingBecause: null });
      expect(await broughtInto()).toEqual(['thread-later']);
    });
  });
});

/**
 * "Change what a Gmail connection follows, without reconnecting" (issue 824):
 * the row's own switch, through its real endpoint, and what each mark's
 * Items do once the other is followed. What the window draws and sends is
 * apps/web's ManageConnections test.
 */

/** Switches the Workspace's Gmail connection to `follows`, as "Change what's followed…" does, answering the status. */
async function switchTo(
  follows: 'label' | 'star',
  { workspaceId = WORKSPACE_ID, sourceAccountId }: { workspaceId?: string; sourceAccountId?: string } = {},
): Promise<number> {
  let id = sourceAccountId;
  if (!id) {
    const listed = await asUser(`http://cockpit.test/v1/workspaces/${workspaceId}/connections`);
    id = ((await listed.json()) as { sourceAccounts: { id: string }[] }).sourceAccounts[0]!.id;
  }
  const res = await asUser('http://cockpit.test/v1/commands/set_gmail_follows', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ commandId: crypto.randomUUID(), issuedAt: new Date().toISOString(), workspaceId, sourceAccountId: id, follows }),
  });
  return res.status;
}

/** When the connection's current full reconcile started, which names the position it reads from. */
function positionStartedAt(): Promise<string | null> {
  return inTheStore(
    (sql) => [...sql.exec<{ started_at: string }>('SELECT started_at FROM gmail_checks')][0]?.started_at ?? null,
  );
}

describe('Connector management', () => {
  describe('a Gmail connection switches the one mark it follows without connecting again', () => {
    it.each([
      { situation: 'from the label to the star', to: 'star' as const, startsAgain: true },
      { situation: 'to the label it already follows', to: 'label' as const, startsAgain: false },
    ])('$situation: the row reads the mark, and the position starts again only for a switch', async ({ to, startsAgain }) => {
      mailboxWith(1);
      await connect();
      await checksSettle();
      const before = await positionStartedAt();

      expect(await switchTo(to)).toBe(200);
      await runningCheckFinishes();

      expect(await rowOf()).toMatchObject({ follows: to, lastTestedAt: expect.any(String) });
      expect((await positionStartedAt()) !== before).toBe(startsAgain);
    });

    it('a switch for a connection disconnected meanwhile is refused, and nothing is stored', async () => {
      mailboxWith(1);
      await connect();
      await checksSettle();
      const listed = await asUser(`http://cockpit.test/v1/workspaces/${WORKSPACE_ID}/connections`);
      const [held] = ((await listed.json()) as { sourceAccounts: { id: string }[] }).sourceAccounts;
      await disconnect(WORKSPACE_ID, '018f0000-0000-7000-8000-0000000824a1');

      expect(await switchTo('star', { sourceAccountId: held!.id })).toBe(404);
      expect(
        await inTheStore((sql) => [...sql.exec("SELECT command_id FROM commands WHERE name = 'set_gmail_follows'")]),
      ).toEqual([]);
    });

    it('a check part-way through when the switch lands brings nothing more in under the old mark', async () => {
      mailboxWith(5);
      whileGmailIsAsked(
        (call) => call.startsWith('threads/thread-002'),
        async () => {
          expect(await switchTo('star')).toBe(200);
        },
      );
      await connect();

      await checksSettle();

      expect(await broughtInto()).toEqual(['thread-000', 'thread-001']);
      expect(gmailCalls.some((call) => call.startsWith('threads/thread-003'))).toBe(false);
    });
  });

  describe('a missing label called Cockpit fails only a connection following the label', () => {
    it.each([
      { situation: 'a failing label connection switched to the star reads when it was last checked', from: 'label' as const, to: 'star' as const, failing: null },
      { situation: 'a star connection switched to the label fails, naming the label', from: 'star' as const, to: 'label' as const, failing: NO_LABEL },
    ])('$situation, at the next check', async ({ from, to, failing }) => {
      starredBefore([]);
      gmailHolds({ labels: labelsAnswer({ cockpit: false }) });
      await connect(granted('anna-refresh'), WORKSPACE_ID, from);
      await checksSettle();
      expect((await rowOf()).failingBecause).toBe(from === 'label' ? NO_LABEL : null);

      expect(await switchTo(to)).toBe(200);
      await runningCheckFinishes();

      expect(await rowOf()).toMatchObject({ follows: to, failingBecause: failing, lastTestedAt: expect.any(String) });
    });
  });
});

describe('Capture', () => {
  describe('switched to the star, only a conversation starred after the switch becomes an Item', () => {
    it('one starred before the switch is no Item, and one starred after it is one open Task', async () => {
      mailboxWith(1);
      await connect();
      await checksSettle();
      afterwards([starOn('thread-before')], { now: '778' });

      expect(await switchTo('star')).toBe(200);
      await runningCheckFinishes();
      afterwards([starOn('thread-before'), starOn('thread-after')]);
      await aCheckRuns();

      expect(await broughtInto()).toEqual(['thread-000', 'thread-after']);
      expect(await itemFor('thread-after')).toMatchObject({ is: 'open' });
    });
  });

  describe('only the Items under the mark followed now are kept in step with Gmail', () => {
    it('switched to the star, a label Item whose conversation is not starred stays open through the nightly read', async () => {
      mailboxWith(2);
      await connect();
      await checksSettle();
      await switchTo('star');
      await runningCheckFinishes();

      await handleScheduled({} as never, env);
      await runsSettle();

      expect(await itemFor('thread-000')).toMatchObject({ is: 'open' });
      expect(await itemFor('thread-001')).toMatchObject({ is: 'open' });
    });

    it('switched to the star, a label Item marked done changes nothing in Gmail', async () => {
      mailboxWith(1);
      await connect();
      await checksSettle();
      await switchTo('star');
      await runningCheckFinishes();

      await personMarks((await itemFor('thread-000'))!.id, 'done');
      await aCheckRuns();

      expect(gmailModifies).toEqual([]);
      expect(labelIsOn('thread-000')).toBe(true);
    });

    it('switched back to the label, a conversation whose label came off meanwhile has its Item done', async () => {
      mailboxWith(2);
      await connect();
      await checksSettle();
      await switchTo('star');
      await runningCheckFinishes();
      nowIs('thread-000', 'unlabelled');

      expect(await switchTo('label')).toBe(200);
      await checksSettle();

      expect(await itemFor('thread-000')).toMatchObject({ is: 'done' });
      expect(await itemFor('thread-001')).toMatchObject({ is: 'open' });
    });

    it('switched to the label, a star Item whose conversation is unstarred stays open', async () => {
      await starredAfterConnecting(['thread-x']);
      await switchTo('label');
      await checksSettle();

      starNowIs('thread-x', 'unstarred');
      starsChange([starOff('thread-x')]);
      await aCheckRuns();
      await handleScheduled({} as never, env);
      await runsSettle();

      expect(await itemFor('thread-x')).toMatchObject({ is: 'open' });
    });
  });

  describe('a change still waiting for Gmail under the old mark is dropped at the switch', () => {
    it('done on a label Item and not yet in Gmail, then switched to the star: the label is never taken off, even once it follows the label again', async () => {
      mailboxWith(1);
      await connect();
      await checksSettle();
      gmailAnswersWith(503, (call) => call === 'labels');
      await personMarks((await itemFor('thread-000'))!.id, 'done');

      await switchTo('star');
      await checksSettle();
      expect(await itemFor('thread-000')).toMatchObject({ is: 'done' });
      await switchTo('label');
      await checksSettle();

      expect(gmailModifies).toEqual([]);
      expect(labelIsOn('thread-000')).toBe(true);
    });
  });
});
