import { afterEach, beforeEach, describe, expect, inject, it } from 'vitest';
import { SELF, applyD1Migrations, env, runDurableObjectAlarm } from 'cloudflare:test';
import type { Conversation, WorkspaceSnapshot } from '@cockpit/shared';
import type { EnrichmentJob } from '../../../src/jobs/enrichment.js';
import { handleQueue } from '../../../src/jobs/index.js';
import {
  ACCOUNT_NAME,
  WORKSPACE_ID,
  alsoWorkspaces,
  asUser,
  inTheStore,
  seedRegister,
  signInAs,
  startFromEmpty,
  storeNamed,
} from '../seed.js';
import { gmailCalls, gmailHolds, gmailModifies, issuerIsForgotten, issuerIsReachable, issuerWillIdentify } from '../issuer.js';
import { historyRecord, labelsAnswer, message } from '../../../../../packages/connectors/gmail/tests/gmail-payloads.js';

/**
 * Integration level: a Gmail connection following the star, run by the
 * generic host against the real store, with Gmail faked at the network
 * (`../issuer.ts`) - "A Gmail starred conversation is one Item whose status
 * follows who wrote last" (issue 1705). What is under test is the store's: the
 * key an Item's link is filed under, the one logged change a turn is applied
 * by, and the open Items a check reads turns for. What Gmail's history says
 * and which message is a turn is the connector's own, proved in its package
 * (following-starred-conversations.test.ts); what a turn does to a status is
 * apps/api/tests/unit/domain/conversations.test.ts.
 *
 * **The queue is held**, so each check is delivered through the real consumer
 * by the case: the first one connecting queues, then each the alarm queues.
 */

const ANNA = { email: 'anna@example.com', subject: 'google-anna' };

/** The time a change is stamped with: the store's own clock is the real one, and a change older than an Item's last is refused as stale. */
const now = () => new Date(); // clock-ok: the store stamps the Items on the real clock, so a person's change must be no older

type GmailMessage = ReturnType<typeof message>;

/**
 * The mailbox, changed the way a person changes one, writing the history Gmail
 * would - so a case says what happened in Gmail, not what its history holds.
 * Each conversation's answer is the fake's own object, which a label change
 * Cockpit asks for replaces in place.
 */
class Mailbox {
  readonly threads: { id: string; labelled: boolean; answer: { id: string; historyId: string; messages: GmailMessage[] } }[] = [];
  readonly history: { id: string }[] = [];
  #position = 100;
  #sent = 0;

  constructor() {
    this.#publish();
  }

  /** A conversation arriving with one email, starred or not. */
  arrives(threadId: string, subject: string, { starred = false }: { starred?: boolean } = {}): void {
    const first = this.#message(threadId, threadId, { subject, starred, plain: `Hi Anna, about ${subject}.` });
    this.threads.push({ id: threadId, labelled: false, answer: { id: threadId, historyId: '1', messages: [first] } });
    this.#record({ added: first.id, threadId, labelIds: first.labelIds });
  }

  /** A reply in a conversation: from Steven unless said, or sent from this mailbox. Answers its id. */
  replies(threadId: string, { sent = false, text = 'Thursday is tricky, how about Friday?' }: { sent?: boolean; text?: string } = {}): string {
    const thread = this.#thread(threadId);
    const reply = this.#message(threadId, `${threadId}-r${thread.answer.messages.length}`, {
      plain: text,
      from: sent ? `Anna Peeters <${ANNA.email}>` : 'Steven Noels <steven@example.com>',
    });
    if (sent) reply.labelIds = ['SENT'];
    thread.answer.messages.push(reply);
    this.#record({ added: reply.id, threadId, labelIds: reply.labelIds });
    return reply.id;
  }

  star(messageId: string): void {
    this.#label(messageId, true);
  }

  unstar(messageId: string): void {
    this.#label(messageId, false);
  }

  #label(messageId: string, on: boolean): void {
    for (const thread of this.threads) {
      const found = thread.answer.messages.find((one) => one.id === messageId);
      if (!found) continue;
      found.labelIds = on ? [...new Set([...found.labelIds, 'STARRED'])] : found.labelIds.filter((one) => one !== 'STARRED');
      this.#record(
        on
          ? { labelled: messageId, threadId: thread.id, with: ['STARRED'], labelIds: found.labelIds }
          : { unlabelled: messageId, threadId: thread.id, with: ['STARRED'], labelIds: found.labelIds },
      );
      return;
    }
    throw new Error(`no email ${messageId}`);
  }

  #message(threadId: string, id: string, options: { subject?: string; starred?: boolean; plain: string; from?: string }): GmailMessage {
    this.#sent += 1;
    const sentAt = new Date(Date.UTC(2026, 9, 1, 8, this.#sent)).toISOString();
    return message(threadId, { id, sentAt, labelled: false, ...options });
  }

  #thread(id: string) {
    const thread = this.threads.find((one) => one.id === id);
    if (!thread) throw new Error(`no conversation ${id}`);
    return thread;
  }

  #record(change: Parameters<typeof historyRecord>[1]): void {
    this.#position += 1;
    this.history.push(historyRecord(String(this.#position), change));
    this.#publish();
  }

  #publish(): void {
    gmailHolds({
      labels: labelsAnswer(),
      historyId: String(this.#position),
      threads: this.threads,
      history: this.history,
      historyLapsed: false,
    });
  }
}

let held: EnrichmentJob[] = [];
let realQueue: typeof env.ENRICHMENT;

function holdTheQueue(): void {
  realQueue = env.ENRICHMENT;
  env.ENRICHMENT = {
    send: async (body: EnrichmentJob) => void held.push(body),
    sendBatch: async () => {
      throw new Error('nothing here sends a batch');
    },
  } as unknown as typeof env.ENRICHMENT;
}

function takeQueuedChecks(): EnrichmentJob[] {
  const checks = held.filter((job) => job.kind === 'check-a-pulled-connection');
  held = held.filter((job) => job.kind !== 'check-a-pulled-connection');
  return checks;
}

async function deliver(body: EnrichmentJob): Promise<void> {
  await handleQueue(
    {
      queue: 'cockpit-enrichment',
      messages: [{ id: crypto.randomUUID(), timestamp: now(), body, attempts: 1, ack: () => {}, retry: () => {} }],
      ackAll: () => {},
      retryAll: () => {},
    } as unknown as Parameters<typeof handleQueue>[0],
    env,
  );
}

/** The check connecting queues - set for now, so it fires by itself - delivered. */
async function firstCheckRuns(): Promise<void> {
  for (let waited = 0; waited < 10_000; waited += 25) {
    const checks = takeQueuedChecks();
    if (checks.length > 0) {
      for (const check of checks) await deliver(check);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('no check was ever queued');
}

/** The alarm firing, and each check it queued delivered: the next check of every connection. */
async function nextCheckRuns(): Promise<void> {
  await runDurableObjectAlarm(storeNamed(ACCOUNT_NAME));
  for (const check of takeQueuedChecks()) await deliver(check);
}

/** Connect on the Gmail card of a Workspace, picking the star - the whole trip through Google - and its first check. */
async function connectedByStar(workspaceId = WORKSPACE_ID, choice = 'star'): Promise<void> {
  const session = await signInAs();
  const started = await SELF.fetch(
    `http://cockpit.test/v1/workspaces/${workspaceId}/connections/gmail/connect?choice=${choice}`,
    { redirect: 'manual', headers: { cookie: session } },
  );
  const asked = new URL(started.headers.get('location')!);
  const attempt = started.headers
    .getSetCookie()
    .map((cookie) => cookie.split(';')[0]!)
    .find((cookie) => cookie.startsWith('cockpit_connect='))!;
  issuerWillIdentify({ ...ANNA, nonce: asked.searchParams.get('nonce')! }, 'a-code', {
    refresh_token: 'anna-refresh',
    access_token: 'access-for-anna',
    expires_in: 3599,
    scope: 'openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/gmail.modify',
  });
  const back = await SELF.fetch(
    `http://cockpit.test/v1/connections/gmail/callback?code=a-code&state=${asked.searchParams.get('state')}`,
    { redirect: 'manual', headers: { cookie: `${session}; ${attempt}` } },
  );
  expect(back.headers.get('location')).toBe(`/w/${workspaceId}?connections=connected`);
  await firstCheckRuns();
}

async function opened(workspaceId = WORKSPACE_ID): Promise<WorkspaceSnapshot> {
  const res = await asUser(`http://cockpit.test/v1/workspaces/${workspaceId}/snapshot`);
  expect(res.status).toBe(200);
  return (await res.json()) as WorkspaceSnapshot;
}

/** The Gmail Items a Workspace opens with, each with the conversation it follows. */
async function gmailItems(workspaceId = WORKSPACE_ID) {
  const read = await opened(workspaceId);
  return read.items
    .filter((item) => item.source === 'gmail')
    .map((item) => ({ ...item, conversation: (read.conversations ?? []).find((one) => one.itemId === item.id) }));
}

async function theItem(sourceId: string) {
  const found = (await gmailItems()).find((item) => item.sourceId === sourceId);
  if (!found) throw new Error(`no Item from ${sourceId}`);
  return found;
}

function statusOf(item: { completedAt: string | null; waitingSince: string | null; startedAt: string | null }): string {
  return item.completedAt ? 'done' : item.waitingSince ? 'waiting' : item.startedAt ? 'in progress' : 'to do';
}

/** The changes a turn was recorded by, as the store logged them. */
function turnsLogged(): Promise<unknown[]> {
  return inTheStore((sql) =>
    sql.exec("SELECT payload FROM commands WHERE name = 'record_conversation_turn' ORDER BY received_at").toArray(),
  );
}

async function change(name: 'set_done' | 'wait_for_reply', itemId: string, extra: Record<string, unknown>): Promise<void> {
  const res = await asUser(`http://cockpit.test/v1/commands/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ commandId: crypto.randomUUID(), issuedAt: now().toISOString(), workspaceId: WORKSPACE_ID, itemId, ...extra }),
  });
  expect(res.status).toBe(200);
}

/** A conversation from Pieter, starred after connecting, brought in and followed. */
async function aFollowedConversation(): Promise<Mailbox> {
  const mailbox = new Mailbox();
  await connectedByStar();
  mailbox.arrives('t-1', 'Dinner one of these weeks?');
  mailbox.star('t-1');
  await nextCheckRuns();
  return mailbox;
}

let mailbox: Mailbox;

beforeEach(async () => {
  await applyD1Migrations(env.DB, inject('migrations'));
  await startFromEmpty();
  await seedRegister();
  held = [];
  holdTheQueue();
  await issuerIsReachable();
  gmailCalls.length = 0;
  gmailModifies.length = 0;
});

afterEach(() => {
  env.ENRICHMENT = realQueue;
  issuerIsForgotten();
});

describe('Capture', () => {
  describe('a Gmail connection following the star makes one Item per conversation', () => {
    it('makes one Item, titled with the starred email’s subject, following its conversation', async () => {
      mailbox = await aFollowedConversation();

      expect(await gmailItems()).toEqual([
        expect.objectContaining({
          title: 'Dinner one of these weeks?',
          sourceId: 't-1',
          conversation: expect.objectContaining<Partial<Conversation>>({
            source: 'gmail',
            conversationId: 't-1',
            lastBy: 'them',
            lastFrom: 'Pieter Claes',
            messageCount: 1,
            withWhom: 'Pieter Claes',
          }),
        }),
      ]);
    });

    it('makes no new Item for a second email starred in that conversation', async () => {
      mailbox = await aFollowedConversation();
      const reply = mailbox.replies('t-1');
      mailbox.star(reply);

      await nextCheckRuns();

      expect((await gmailItems()).map((item) => item.sourceId)).toEqual(['t-1']);
    });

    it('leaves an Item made of one email before untouched, and makes one conversation Item beside it', async () => {
      mailbox = new Mailbox();
      await connectedByStar();
      mailbox.arrives('t-1', 'Invoice 42', { starred: true });
      // As a release before filed it: the email's own Item, under its own source id.
      const before = await anItemMadeOfOneEmail('t-1', 'Invoice 42');
      const reply = mailbox.replies('t-1');
      mailbox.star(reply);

      await nextCheckRuns();

      const items = await gmailItems();
      expect(items.map((item) => item.sourceId).sort()).toEqual(['message:t-1', 't-1']);
      const old = items.find((item) => item.sourceId === 'message:t-1')!;
      expect(old).toEqual(expect.objectContaining({ id: before, title: 'Invoice 42', completedAt: null, conversation: undefined }));
      expect(items.find((item) => item.sourceId === 't-1')!.conversation).toBeDefined();
    });

    it('is the same Item a connection following the label made of the same conversation', async () => {
      mailbox = new Mailbox();
      // Labelled Cockpit before connecting by the label, whose first listing brings it in as the conversation's Item.
      mailbox.threads.push({
        id: 't-1',
        labelled: true,
        answer: { id: 't-1', historyId: '1', messages: [message('t-1', { id: 't-1', sentAt: '2026-10-01T08:00:00Z', subject: 'Invoice 42', plain: 'x' })] },
      });
      await connectedByStar(WORKSPACE_ID, 'label');
      const fromTheLabel = await theItem('t-1');
      const connection = await gmailConnection();
      expect(
        (
          await asUser('http://cockpit.test/v1/commands/set_connection_choice', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ commandId: crypto.randomUUID(), issuedAt: now().toISOString(), workspaceId: WORKSPACE_ID, sourceAccountId: connection, choice: 'star' }),
          })
        ).status,
      ).toBe(200);
      await nextCheckRuns();
      const reply = mailbox.replies('t-1');
      mailbox.star(reply);

      await nextCheckRuns();

      const items = await gmailItems();
      expect(items.map((item) => item.id)).toEqual([fromTheLabel.id]);
      expect(items[0]!.conversation).toEqual(expect.objectContaining({ conversationId: 't-1' }));
    });
  });
});

describe('Triage', () => {
  describe('a followed conversation’s turn reaches the Item through one logged change', () => {
    it('records one turn for a reply without a star, changing the status and the conversation together', async () => {
      mailbox = await aFollowedConversation();
      const item = await theItem('t-1');
      await change('wait_for_reply', item.id, { days: 3, timeZone: 'Europe/Brussels' });
      expect(statusOf(await theItem('t-1'))).toBe('waiting');

      mailbox.replies('t-1');
      await nextCheckRuns();

      const after = await theItem('t-1');
      expect(await turnsLogged()).toHaveLength(1);
      expect(statusOf(after)).toBe('to do');
      expect(after.dueDate).not.toBe(item.dueDate);
      expect(after.conversation).toEqual(
        expect.objectContaining({ lastBy: 'them', lastFrom: 'Steven Noels', messageCount: 2, lastExcerpt: 'Thursday is tricky, how about Friday?' }),
      );
    });

    it('records the date a turn gives as the connection’s, so a later reopen or reading may still move it', async () => {
      mailbox = await aFollowedConversation();

      mailbox.replies('t-1');
      await nextCheckRuns();

      const after = await theItem('t-1');
      expect(after.dueDate).not.toBeNull();
      const given = await inTheStore((sql) =>
        sql.exec('SELECT given_due_date AS given FROM pulled_links WHERE item_id = ?', after.id).toArray(),
      );
      expect(given).toEqual([{ given: after.dueDate }]);
    });

    it('makes the Item Waiting for reply on a message sent from the mailbox', async () => {
      mailbox = await aFollowedConversation();

      mailbox.replies('t-1', { sent: true, text: 'Sure! Does Thursday the 19th work for you?' });
      await nextCheckRuns();

      const after = await theItem('t-1');
      expect(statusOf(after)).toBe('waiting');
      expect(after.conversation).toEqual(expect.objectContaining({ lastBy: 'you', withWhom: 'Pieter Claes' }));
    });

    it('applies a turn read twice once', async () => {
      mailbox = await aFollowedConversation();
      const position = await savedPosition();
      mailbox.replies('t-1');
      await nextCheckRuns();

      // The saved position taken back: the same history read again, as a run that stopped before saving it would.
      await savedPositionIs(position);
      await nextCheckRuns();

      expect(await turnsLogged()).toHaveLength(1);
      expect((await theItem('t-1')).conversation?.messageCount).toBe(2);
    });

    it('records nothing for a message in a conversation no open Item follows, and reads none of it', async () => {
      mailbox = await aFollowedConversation();
      mailbox.arrives('t-2', 'Newsletter');
      const unfollowed = mailbox.replies('t-2');

      await nextCheckRuns();

      expect(await turnsLogged()).toEqual([]);
      expect(gmailCalls.some((call) => call.includes(unfollowed))).toBe(false);
    });

    it('does not apply a turn to a Workspace whose Items do not follow that conversation', async () => {
      await alsoWorkspaces();
      mailbox = new Mailbox();
      await connectedByStar('ws-personal');
      mailbox.arrives('t-1', 'Dinner one of these weeks?');
      mailbox.star('t-1');
      await nextCheckRuns();
      // The same mailbox connected to this Workspace after the star: nothing here follows it.
      await connectedByStar();
      const before = await opened();

      mailbox.replies('t-1');
      await nextCheckRuns();

      expect((await opened()).items).toEqual(before.items);
      expect((await opened()).conversations).toEqual([]);
      const theirs = (await gmailItems('ws-personal'))[0]!;
      expect(theirs.conversation?.lastFrom).toBe('Steven Noels');
      expect(await turnsLogged()).toHaveLength(1);
    });
  });

  describe('Done ends the following, and starring the conversation again follows it again', () => {
    it('wants the star off the whole conversation, and a later message records no turn', async () => {
      mailbox = await aFollowedConversation();
      const item = await theItem('t-1');
      await change('set_done', item.id, { done: true });

      await nextCheckRuns();
      expect(gmailModifies).toEqual([{ threadId: 't-1', removeLabelIds: ['STARRED'] }]);
      mailbox.replies('t-1');
      await nextCheckRuns();

      expect(await turnsLogged()).toEqual([]);
      expect(statusOf(await theItem('t-1'))).toBe('done');
    });

    it('reopens the same Item, following, once the conversation is starred again', async () => {
      mailbox = await aFollowedConversation();
      const item = await theItem('t-1');
      await change('set_done', item.id, { done: true });
      await nextCheckRuns();

      mailbox.star('t-1');
      await nextCheckRuns();
      expect(await theItem('t-1')).toEqual(expect.objectContaining({ id: item.id, completedAt: null }));
      mailbox.replies('t-1', { sent: true });
      await nextCheckRuns();

      expect(statusOf(await theItem('t-1'))).toBe('waiting');
    });

    it('marks the Item done at the next check once every star in Gmail is taken off', async () => {
      mailbox = await aFollowedConversation();

      mailbox.unstar('t-1');
      await nextCheckRuns();

      expect(statusOf(await theItem('t-1'))).toBe('done');
    });
  });
});

/** The id of this Workspace's Gmail connection. */
async function gmailConnection(): Promise<string> {
  const res = await asUser(`http://cockpit.test/v1/workspaces/${WORKSPACE_ID}/connections`);
  const rows = ((await res.json()) as { sourceAccounts: { id: string; connectorId: string }[] }).sourceAccounts;
  return rows.find((row) => row.connectorId === 'gmail')!.id;
}

/** Where the connection's history reading stands, as the connector saved it. */
function savedPosition(): Promise<string> {
  return inTheStore((sql) => sql.exec<{ state: string }>('SELECT state FROM pulled_connections').one().state);
}

function savedPositionIs(state: string): Promise<void> {
  return inTheStore((sql) => void sql.exec('UPDATE pulled_connections SET state = ?', state));
}

/**
 * An Item a star brought in one email at a time before conversations were
 * followed: captured as any Item, then written into the store as that
 * release's check left it - its source the email's own id, linked under the
 * connection. Written directly, since no interface of this release makes one
 * (testing skill, "the one exception").
 */
async function anItemMadeOfOneEmail(emailId: string, title: string): Promise<string> {
  const itemId = crypto.randomUUID();
  const at = now().toISOString();
  const res = await asUser('http://cockpit.test/v1/commands/capture_item', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      commandId: crypto.randomUUID(),
      issuedAt: at,
      workspaceId: WORKSPACE_ID,
      itemId,
      message: title,
    }),
  });
  expect(res.status).toBe(200);
  await inTheStore((sql) => {
    sql.exec("UPDATE items SET source_connector = 'gmail', source_id = ? WHERE id = ?", `message:${emailId}`, itemId);
    sql.exec(
      `INSERT INTO pulled_links (tenant_id, workspace_id, connector_id, external_account_key, source_id, item_id, linked_at, choice)
       VALUES (?, ?, 'gmail', ?, ?, ?, ?, 'star')`,
      ACCOUNT_NAME,
      WORKSPACE_ID,
      ANNA.subject,
      `message:${emailId}`,
      itemId,
      at,
    );
  });
  return itemId;
}
