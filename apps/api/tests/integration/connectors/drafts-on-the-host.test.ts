import { afterEach, beforeEach, describe, expect, inject, it } from 'vitest';
import { SELF, applyD1Migrations, env, runDurableObjectAlarm } from 'cloudflare:test';
import type { Conversation, WorkspaceSnapshot } from '@cockpit/shared';
import type { EnrichmentJob } from '../../../src/jobs/enrichment.js';
import { handleQueue } from '../../../src/jobs/index.js';
import {
  ACCOUNT_NAME,
  OTHER_USER_ID,
  WORKSPACE_ID,
  asUser,
  inTheStore,
  seedRegister,
  signInAs,
  startFromEmpty,
  storeNamed,
} from '../seed.js';
import { gmailAnswersWith, gmailCalls, gmailDrafts, gmailHolds, googleRefreshes, issuerIsForgotten, issuerIsReachable, issuerWillIdentify } from '../issuer.js';
import { historyRecord, labelsAnswer, message } from '../../../../../packages/connectors/gmail/tests/gmail-payloads.js';

/**
 * Integration level: *Email…* and *Reply…* through the real route and store,
 * Gmail faked at the network (`../issuer.ts`), then what a check finds of the
 * draft through the pulled host ("Email… makes a Gmail draft the Item then
 * follows", issue 1708). What is under test is the store's: the click logged
 * before Gmail is asked, the draft recorded after, a click resent, a draft not
 * made put back, and a draft sent or deleted moving the Item. How the draft is
 * written and how a check tells sent from deleted is the connector's
 * (packages/connectors/gmail/tests/unit/making-drafts.test.ts); what the
 * status rules are, apps/api/tests/unit/domain/conversations.test.ts.
 */

const ANNA = { email: 'anna@example.com', subject: 'google-anna' };

/** The store stamps its own changes on the real clock, which a case's changes must not be older than. */
const now = () => new Date(); // clock-ok: the store stamps the Items on the real clock

type GmailMessage = ReturnType<typeof message>;

/** The mailbox, changed the way a person changes one, writing the history Gmail would. */
class Mailbox {
  readonly threads: { id: string; labelled: boolean; answer: { id: string; historyId: string; messages: GmailMessage[] } }[] = [];
  readonly history: { id: string }[] = [];
  #position = 100;

  constructor() {
    this.#publish();
  }

  /** A conversation arriving with one email, then starred. */
  starred(threadId: string, subject: string): void {
    const first = message(threadId, { id: threadId, sentAt: '2026-10-01T08:01:00.000Z', subject, plain: `About ${subject}.`, labelled: false });
    this.threads.push({ id: threadId, labelled: false, answer: { id: threadId, historyId: '1', messages: [first] } });
    this.#record({ added: first.id, threadId, labelIds: first.labelIds });
    first.labelIds = [...first.labelIds, 'STARRED'];
    this.#record({ labelled: first.id, threadId, with: ['STARRED'], labelIds: first.labelIds });
  }

  /** The draft Email… made, sent from Gmail where it stands: the Draft label off, Sent on. */
  sends(draftId: string): void {
    const draft = this.#draftMessage(draftId);
    draft.labelIds = ['SENT'];
    draft.internalDate = String(Date.parse('2026-10-09T13:00:00.000Z'));
    this.#record({ unlabelled: draft.id, threadId: draft.threadId, with: ['DRAFT'], labelIds: draft.labelIds });
    this.#record({ labelled: draft.id, threadId: draft.threadId, with: ['SENT'], labelIds: draft.labelIds });
  }

  /** The draft Email… made, deleted from Gmail unsent; its conversation goes with it where it held nothing else. */
  deletes(draftId: string): void {
    const draft = this.#draftMessage(draftId);
    const thread = this.threads.find((one) => one.id === draft.threadId)!;
    thread.answer.messages = thread.answer.messages.filter((one) => one.id !== draft.id);
    if (thread.answer.messages.length === 0) this.threads.splice(this.threads.indexOf(thread), 1);
    this.#record({ deleted: draft.id, threadId: draft.threadId });
  }

  /** The email the draft Email… made became, starred in Gmail once sent. */
  stars(draftId: string): void {
    const sent = this.#draftMessage(draftId);
    sent.labelIds = [...sent.labelIds, 'STARRED'];
    this.#record({ labelled: sent.id, threadId: sent.threadId, with: ['STARRED'], labelIds: sent.labelIds });
  }

  #draftMessage(draftId: string): GmailMessage {
    const made = gmailDrafts.find((one) => one.id === draftId)!;
    return this.threads.flatMap((one) => one.answer.messages).find((one) => one.id === made.messageId)!;
  }

  #record(change: Parameters<typeof historyRecord>[1]): void {
    this.#position += 1;
    this.history.push(historyRecord(String(this.#position), change));
    this.#publish();
  }

  #publish(): void {
    gmailHolds({ labels: labelsAnswer(), historyId: String(this.#position), threads: this.threads, history: this.history, historyLapsed: false });
  }
}

let held: EnrichmentJob[] = [];
let realQueue: typeof env.ENRICHMENT;

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

/** The alarm firing, and each check it queued delivered. */
async function nextCheckRuns(): Promise<void> {
  for (let fired = 0; fired < 5; fired += 1) {
    await runDurableObjectAlarm(storeNamed(ACCOUNT_NAME));
    const checks = takeQueuedChecks();
    if (checks.length === 0) continue;
    for (const check of checks) await deliver(check);
    return;
  }
}

/** Connect on the Gmail card, picking `choice`, and its first check. */
async function connected(choice = 'star'): Promise<string> {
  const session = await signInAs();
  const started = await SELF.fetch(`http://cockpit.test/v1/workspaces/${WORKSPACE_ID}/connections/gmail/connect?choice=${choice}`, {
    redirect: 'manual',
    headers: { cookie: session },
  });
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
  await SELF.fetch(`http://cockpit.test/v1/connections/gmail/callback?code=a-code&state=${asked.searchParams.get('state')}`, {
    redirect: 'manual',
    headers: { cookie: `${session}; ${attempt}` },
  });
  for (let waited = 0; waited < 10_000; waited += 25) {
    const checks = takeQueuedChecks();
    if (checks.length > 0) {
      for (const check of checks) await deliver(check);
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const res = await asUser(`http://cockpit.test/v1/workspaces/${WORKSPACE_ID}/connections`);
  return ((await res.json()) as { sourceAccounts: { id: string }[] }).sourceAccounts[0]!.id;
}

async function opened(): Promise<WorkspaceSnapshot> {
  const res = await asUser(`http://cockpit.test/v1/workspaces/${WORKSPACE_ID}/snapshot`);
  expect(res.status).toBe(200);
  return (await res.json()) as WorkspaceSnapshot;
}

/** One Item as the Workspace opens it, with the conversation it follows. */
async function theItem(itemId: string) {
  const read = await opened();
  const item = read.items.find((one) => one.id === itemId)!;
  return { ...item, conversation: (read.conversations ?? []).find((one) => one.itemId === itemId) };
}

function statusOf(item: { completedAt: string | null; waitingSince: string | null; startedAt: string | null }): string {
  return item.completedAt ? 'done' : item.waitingSince ? 'waiting' : item.startedAt ? 'in progress' : 'to do';
}

async function captured(title: string): Promise<string> {
  const itemId = crypto.randomUUID();
  const res = await asUser('http://cockpit.test/v1/commands/capture_item', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ commandId: crypto.randomUUID(), issuedAt: now().toISOString(), workspaceId: WORKSPACE_ID, itemId, message: title }),
  });
  expect(res.status).toBe(200);
  return itemId;
}

async function waitingForReply(itemId: string): Promise<void> {
  const res = await asUser('http://cockpit.test/v1/commands/wait_for_reply', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ commandId: crypto.randomUUID(), issuedAt: now().toISOString(), workspaceId: WORKSPACE_ID, itemId, days: 3, timeZone: 'Europe/Brussels' }),
  });
  expect(res.status).toBe(200);
}

/** *Email…* or *Reply…* clicked on an Item, through the mailbox named, under the click's own id. */
function emailed(itemId: string, sourceAccountId: string, clickId: string = crypto.randomUUID(), userId?: string): Promise<Response> {
  return asUser(
    `http://cockpit.test/v1/workspaces/${WORKSPACE_ID}/items/${itemId}/draft`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ clickId, sourceAccountId }) },
    userId,
  );
}

let mailbox: Mailbox;

beforeEach(async () => {
  await applyD1Migrations(env.DB, inject('migrations'));
  await startFromEmpty();
  await seedRegister();
  held = [];
  realQueue = env.ENRICHMENT;
  env.ENRICHMENT = {
    send: async (body: EnrichmentJob) => void held.push(body),
    sendBatch: async () => {
      throw new Error('nothing here sends a batch');
    },
  } as unknown as typeof env.ENRICHMENT;
  await issuerIsReachable();
  mailbox = new Mailbox();
});

afterEach(() => {
  env.ENRICHMENT = realQueue;
  issuerIsForgotten();
});

describe('Triage', () => {
  describe('Email… makes one draft per click, and the Item follows the conversation it starts', () => {
    it('makes a new conversation’s draft titled with the Item, puts the Item In progress, and answers where the draft opens', async () => {
      const connection = await connected();
      const itemId = await captured('Plan a dinner with Steven Noels');

      const res = await emailed(itemId, connection);

      expect(res.status).toBe(200);
      expect((await opened()).mailboxes).toEqual([expect.objectContaining({ sourceAccountId: connection, connectorId: 'gmail' })]);
      expect(gmailDrafts).toHaveLength(1);
      expect(gmailDrafts[0]!.text).toMatch(/^Subject: Plan a dinner with Steven Noels\r$/m);
      expect(await res.json()).toEqual({ link: 'https://mail.google.com/mail/?authuser=anna%40example.com#drafts?compose=draft-m-1' });
      const item = await theItem(itemId);
      expect(statusOf(item)).toBe('in progress');
      expect(item.conversation).toEqual(
        expect.objectContaining<Partial<Conversation>>({ source: 'gmail', conversationId: 'draft-m-1', draftStarted: true, lastBy: 'you' }),
      );
    });

    it('makes a reply draft in the conversation a followed Item follows', async () => {
      const connection = await connected();
      mailbox.starred('t-1', 'Dinner one of these weeks?');
      await nextCheckRuns();
      const itemId = (await opened()).items.find((one) => one.sourceId === 't-1')!.id;

      const res = await emailed(itemId, connection);

      expect(res.status).toBe(200);
      expect(gmailDrafts.map((one) => one.threadId)).toEqual(['t-1']);
      expect(gmailDrafts[0]!.text).toMatch(/^Subject: Re: Dinner one of these weeks\?\r$/m);
      expect((await theItem(itemId)).conversation).toEqual(expect.objectContaining({ conversationId: 't-1', draftStarted: true }));
    });

    it('makes one draft for a click sent twice, answering the second with the first’s link', async () => {
      const connection = await connected();
      const itemId = await captured('Plan a dinner with Steven Noels');
      const clickId = crypto.randomUUID();

      const first = await (await emailed(itemId, connection, clickId)).json();
      const again = await emailed(itemId, connection, clickId);

      expect(again.status).toBe(200);
      expect(await again.json()).toEqual(first);
      expect(gmailDrafts).toHaveLength(1);
    });

    it('puts the Item back and follows nothing where Gmail will not make the draft, saying why', async () => {
      const connection = await connected();
      const itemId = await captured('Plan a dinner with Steven Noels');
      await waitingForReply(itemId);
      // The held token refused, and the refresh refused: the sign-in has lapsed.
      gmailAnswersWith(401, (call) => call === 'drafts');
      googleRefreshes('refuses');

      const res = await emailed(itemId, connection);

      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({ error: "Couldn't make the draft: Google no longer accepts the sign-in. Connect again." });
      const item = await theItem(itemId);
      expect(statusOf(item)).toBe('waiting');
      expect(item.conversation).toBeUndefined();
      expect(gmailDrafts).toEqual([]);
    });

    it('refuses an Item of another account, asking Gmail nothing', async () => {
      const connection = await connected();
      const itemId = await captured('Plan a dinner with Steven Noels');
      const asked = gmailCalls.length;

      const res = await emailed(itemId, connection, crypto.randomUUID(), OTHER_USER_ID);

      expect(res.status).toBe(404);
      expect(gmailCalls.length).toBe(asked);
      expect(statusOf(await theItem(itemId))).toBe('to do');
    });

    it('offers Email… only through a Gmail connection following the star', async () => {
      await connected('label');

      expect((await opened()).mailboxes).toEqual([]);
    });
  });

  describe('what happens to the draft in Gmail moves the Item', () => {
    /** An Item captured and emailed: its draft made, the Item In progress following its conversation. */
    async function aDraftStarted(): Promise<string> {
      const connection = await connected();
      const itemId = await captured('Plan a dinner with Steven Noels');
      expect((await emailed(itemId, connection)).status).toBe(200);
      return itemId;
    }

    it('makes the Item Waiting for reply once the draft is sent, the draft no longer waited on', async () => {
      const itemId = await aDraftStarted();

      mailbox.sends(gmailDrafts[0]!.id);
      await nextCheckRuns();

      const item = await theItem(itemId);
      expect(statusOf(item)).toBe('waiting');
      expect(item.conversation).toEqual(expect.objectContaining({ lastBy: 'you', messageCount: 1 }));
      expect(item.conversation?.draftStarted).toBeFalsy();
    });

    it('puts the status before back, following nothing, once the draft is deleted unsent', async () => {
      const itemId = await aDraftStarted();

      mailbox.deletes(gmailDrafts[0]!.id);
      await nextCheckRuns();

      const item = await theItem(itemId);
      expect(statusOf(item)).toBe('to do');
      expect(item.conversation).toBeUndefined();
    });

    it('refuses a second draft while the first is still unsent, the first still waited on', async () => {
      const connection = await connected();
      const itemId = await captured('Plan a dinner with Steven Noels');
      expect((await emailed(itemId, connection)).status).toBe(200);

      const again = await emailed(itemId, connection);

      expect(again.status).toBe(400);
      expect(await again.json()).toEqual({ error: 'A draft is already started in this conversation. Send or delete it first.' });
      expect(gmailDrafts).toHaveLength(1);
      expect((await theItem(itemId)).conversation).toEqual(expect.objectContaining({ draftStarted: true }));
      mailbox.deletes(gmailDrafts[0]!.id);
      await nextCheckRuns();
      expect(statusOf(await theItem(itemId))).toBe('to do');
    });

    it('adds a star on the conversation the draft started to its Item rather than making another', async () => {
      const itemId = await aDraftStarted();
      mailbox.sends(gmailDrafts[0]!.id);
      await nextCheckRuns();
      const before = (await opened()).items.length;

      mailbox.stars(gmailDrafts[0]!.id);
      await nextCheckRuns();

      const read = await opened();
      expect(read.items).toHaveLength(before);
      expect((read.conversations ?? []).filter((one) => one.conversationId === 'draft-m-1').map((one) => one.itemId)).toEqual([itemId]);
    });

    it('changes nothing while the draft is still unsent', async () => {
      const itemId = await aDraftStarted();
      const before = await theItem(itemId);

      await nextCheckRuns();

      expect(await theItem(itemId)).toEqual(before);
      expect(await inTheStore((sql) => sql.exec("SELECT count(*) AS n FROM commands WHERE name = 'drop_draft'").one().n)).toBe(0);
    });
  });
});
