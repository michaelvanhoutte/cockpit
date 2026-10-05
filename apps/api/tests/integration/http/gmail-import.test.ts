import { beforeEach, describe, expect, inject, it } from 'vitest';
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
  gmailAnswersWith,
  gmailCalls,
  gmailHolds,
  gmailIsEmpty,
  googleRefreshes,
  issuerIsReachable,
  issuerWillIdentify,
  refreshes,
  whileGmailIsAsked,
  type Grant,
} from '../issuer.js';
import { COCKPIT_LABEL_ID, historyRecord, labelsAnswer, plainThread } from '../../gmail-payloads.js';
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

/** Connect, Google says whose mailbox it is, and back - as gmail-connections.test.ts walks it. */
async function connect(grant: Grant = granted('anna-refresh'), workspaceId = WORKSPACE_ID): Promise<void> {
  await issuerIsReachable();
  const session = await signInAs(USER_ID);
  const started = await SELF.fetch(`http://cockpit.test/v1/workspaces/${workspaceId}/connections/gmail/connect`, {
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
  expect(back.headers.get('location')).toBe(`/w/${workspaceId}?connections=gmail-connected`);
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

async function rowOf(workspaceId = WORKSPACE_ID): Promise<{ lastTestedAt: string | null; failingBecause: string | null }> {
  const res = await asUser(`http://cockpit.test/v1/workspaces/${workspaceId}/connections`);
  const { sourceAccounts } = (await res.json()) as {
    sourceAccounts: { lastTestedAt: string | null; failingBecause: string | null }[];
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

/** Marks an Item done or dismisses it, as its row's own menu does. */
async function personMarks(itemId: string, as: 'done' | 'dismissed'): Promise<void> {
  const res = await asUser(`http://cockpit.test/v1/commands/${as === 'done' ? 'set_done' : 'set_dismissed'}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      commandId: crypto.randomUUID(),
      issuedAt: new Date().toISOString(),
      workspaceId: WORKSPACE_ID,
      itemId,
      ...(as === 'done' ? { done: true } : { dismissed: true }),
    }),
  });
  expect(res.status).toBe(200);
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
      // Neither in any history record: only the listing finds them.
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
