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
import {
  claudeAnswersWith,
  claudeAsked,
  claudeGoesSilent,
  claudeWrites,
  gmailAnswersWith,
  gmailCalls,
  gmailDraftEdited,
  gmailDrafts,
  gmailDraftsUpdated,
  gmailHolds,
  googleRefreshes,
  issuerIsForgotten,
  issuerIsReachable,
  issuerWillIdentify,
} from '../issuer.js';
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

/** Where Gmail opens the first draft made, and shows a message of the mailbox. */
const DRAFT_LINK = 'https://mail.google.com/mail/?authuser=anna%40example.com#drafts';
const MESSAGE_LINK = 'https://mail.google.com/mail/?authuser=anna%40example.com#all/';

/** The body of a draft's message as its raw text holds it, decoded as its encoding says. */
function bodyOfDraftText(text: string): string {
  const [headers, ...rest] = text.split('\r\n\r\n');
  const body = rest.join('\r\n\r\n');
  if (!/^Content-Transfer-Encoding: base64$/im.test(headers!)) return body;
  return new TextDecoder().decode(Uint8Array.from(atob(body.replace(/\s+/g, '')), (c) => c.charCodeAt(0)));
}

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

  /** A reply arriving in a conversation, from the other person unless said, sent at the instant given. */
  replies(threadId: string, { text, at, from }: { text: string; at: string; from?: string }): void {
    const thread = this.threads.find((one) => one.id === threadId)!;
    const reply = message(threadId, {
      id: `${threadId}-r${thread.answer.messages.length}`,
      sentAt: at,
      plain: text,
      labelled: false,
      ...(from ? { from } : {}),
    });
    thread.answer.messages.push(reply);
    this.#record({ added: reply.id, threadId, labelIds: reply.labelIds });
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

  /** The draft Email… made, moved to the bin unsent: Gmail keeps it, labelled Bin, until the bin is emptied. */
  bins(draftId: string): void {
    const draft = this.#draftMessage(draftId);
    draft.labelIds = [...draft.labelIds, 'TRASH'];
    this.#record({ labelled: draft.id, threadId: draft.threadId, with: ['TRASH'], labelIds: draft.labelIds });
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
function emailed(
  itemId: string,
  sourceAccountId: string,
  clickId: string = crypto.randomUUID(),
  userId?: string,
  more: { withClaude?: boolean; points?: string } = {},
): Promise<Response> {
  return asUser(
    `http://cockpit.test/v1/workspaces/${WORKSPACE_ID}/items/${itemId}/draft`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ clickId, sourceAccountId, ...more }) },
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
      expect(await res.json()).toEqual({ link: DRAFT_LINK });
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
      expect(await res.json()).toEqual({ error: "Couldn't make the draft: Google no longer accepts the sign-in. Connect again.", putBack: true });
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

    it('makes no second draft while the first is still unsent: the click opens the first, and nothing changes', async () => {
      const connection = await connected();
      const itemId = await captured('Plan a dinner with Steven Noels');
      expect((await emailed(itemId, connection)).status).toBe(200);
      const before = await theItem(itemId);

      const again = await emailed(itemId, connection);

      expect(again.status).toBe(200);
      expect(await again.json()).toEqual({ link: DRAFT_LINK });
      expect(gmailDrafts).toHaveLength(1);
      expect(await theItem(itemId)).toEqual(before);
      mailbox.deletes(gmailDrafts[0]!.id);
      await nextCheckRuns();
      expect(statusOf(await theItem(itemId))).toBe('to do');
    });

    it.each([
      { situation: 'deleted from Gmail', happens: (draftId: string) => mailbox.deletes(draftId) },
      { situation: 'in the bin', happens: (draftId: string) => mailbox.bins(draftId) },
    ])('makes a new draft where the first is $situation before any check saw it', async ({ happens }) => {
      const connection = await connected();
      const itemId = await captured('Plan a dinner with Steven Noels');
      await waitingForReply(itemId);
      expect((await emailed(itemId, connection)).status).toBe(200);
      happens(gmailDrafts[0]!.id);

      const again = await emailed(itemId, connection);

      expect(again.status).toBe(200);
      expect(await again.json()).toEqual({ link: DRAFT_LINK });
      expect(gmailDrafts).toHaveLength(2);
      const item = await theItem(itemId);
      expect(statusOf(item)).toBe('in progress');
      expect(item.conversation).toEqual(expect.objectContaining({ conversationId: 'draft-m-2', draftStarted: true }));
      // The first is dropped as deleted unsent, so the second deleted puts back the status from before either.
      mailbox.deletes(gmailDrafts[1]!.id);
      await nextCheckRuns();
      expect(statusOf(await theItem(itemId))).toBe('waiting');
    });

    it('makes no new draft where the first was sent before any check saw it: nothing changes, and a check is asked for', async () => {
      const connection = await connected();
      const itemId = await captured('Plan a dinner with Steven Noels');
      await waitingForReply(itemId);
      expect((await emailed(itemId, connection)).status).toBe(200);
      mailbox.sends(gmailDrafts[0]!.id);
      const before = await theItem(itemId);

      const again = await emailed(itemId, connection);

      // Dropped as deleted, the Item would forget the reply the next check reads (issue 1720).
      expect(again.status).toBe(409);
      expect(await again.json()).toEqual({ error: 'That draft was sent. Cockpit shows it in a moment; press Reply… again after that.' });
      expect(gmailDrafts).toHaveLength(1);
      expect(await theItem(itemId)).toEqual(before);
      expect(await inTheStore((sql) => sql.exec('SELECT check_reason FROM pulled_connections').one().check_reason)).toBe('check-now');
      await nextCheckRuns();
      const item = await theItem(itemId);
      expect(statusOf(item)).toBe('waiting');
      expect(item.conversation?.draftStarted).toBeFalsy();
    });

    it('makes one new draft for a click sent twice where the first draft is gone', async () => {
      const connection = await connected();
      const itemId = await captured('Plan a dinner with Steven Noels');
      expect((await emailed(itemId, connection)).status).toBe(200);
      mailbox.deletes(gmailDrafts[0]!.id);
      const clickId = crypto.randomUUID();

      const first = await (await emailed(itemId, connection, clickId)).json();
      const again = await emailed(itemId, connection, clickId);

      expect(await again.json()).toEqual(first);
      expect(gmailDrafts).toHaveLength(2);
    });

    it('changes nothing, and says nothing was put back, where Gmail does not answer whether the first is still there', async () => {
      const connection = await connected();
      const itemId = await captured('Plan a dinner with Steven Noels');
      expect((await emailed(itemId, connection)).status).toBe(200);
      const before = await theItem(itemId);
      gmailAnswersWith(503, (call) => call.startsWith('drafts/'), { once: false });

      const again = await emailed(itemId, connection);

      expect(again.status).toBe(502);
      expect(await again.json()).toEqual({ error: "Couldn't make the draft: Gmail did not answer. Try again in a moment.", putBack: false });
      expect(gmailDrafts).toHaveLength(1);
      expect(await theItem(itemId)).toEqual(before);
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
  describe('Open on an Item goes to its draft while the draft is unsent, and to the conversation’s latest email otherwise', () => {
    /** A conversation starred, brought in and followed, and Reply… pressed on its Item. */
    async function aReplyStarted(): Promise<string> {
      const connection = await connected();
      mailbox.starred('t-1', 'Dinner one of these weeks?');
      await nextCheckRuns();
      const itemId = (await opened()).items.find((one) => one.sourceId === 't-1')!.id;
      expect((await theItem(itemId)).conversation?.link).toBe(`${MESSAGE_LINK}t-1`);
      expect((await emailed(itemId, connection)).status).toBe(200);
      return itemId;
    }

    it('opens the draft once Email… or Reply… made it', async () => {
      const connection = await connected();
      const started = await captured('Plan a dinner with Steven Noels');
      expect((await emailed(started, connection)).status).toBe(200);
      const replying = await aReplyStarted();

      expect((await theItem(started)).conversation?.link).toBe(DRAFT_LINK);
      expect((await theItem(replying)).conversation?.link).toBe(DRAFT_LINK);
    });

    it('opens the email the draft became once it is sent', async () => {
      const itemId = await aReplyStarted();

      mailbox.sends(gmailDrafts[0]!.id);
      await nextCheckRuns();

      expect((await theItem(itemId)).conversation?.link).toBe(`${MESSAGE_LINK}draft-m-1`);
    });

    it('opens the conversation’s latest email again once the draft is deleted unsent', async () => {
      const itemId = await aReplyStarted();

      mailbox.deletes(gmailDrafts[0]!.id);
      await nextCheckRuns();

      expect((await theItem(itemId)).conversation?.link).toBe(`${MESSAGE_LINK}t-1`);
    });

    it('opens the conversation where the draft was recorded before its link was kept', async () => {
      const connection = await connected();
      const itemId = await captured('Plan a dinner with Steven Noels');
      expect((await emailed(itemId, connection)).status).toBe(200);
      await inTheStore((sql) => sql.exec('UPDATE item_conversations SET draft_link = NULL'));

      expect((await theItem(itemId)).conversation).toEqual(
        expect.objectContaining({ link: `${MESSAGE_LINK}draft-m-1`, draftStarted: true }),
      );
    });
  });

  /**
   * Draft with Claude ("Mail follow-up: Reply… in Gmail makes an empty draft: have
   * Claude write it from the Item, your points and the conversation", issue 1730):
   * the request reads the conversation, has Claude write the body through the
   * gateway, and has Gmail make the draft with it. Claude is faked at the network
   * beside Gmail (`../issuer.ts`); how the real model writes is the contract tier's
   * (tests/contract/draft-a-reply.v1.test.ts), and how the connector reads and
   * writes the mail the connector's own (packages/connectors/gmail/tests/unit/drafting-a-reply.test.ts).
   */
  describe('Draft with Claude makes one Gmail draft whose body is Claude’s answer', () => {
    let realKey: string | undefined;
    beforeEach(() => {
      realKey = env.ANTHROPIC_API_KEY;
      env.ANTHROPIC_API_KEY = 'sk-ant-api03-a-key-that-proves-nothing-WXYZ';
    });
    afterEach(() => {
      env.ANTHROPIC_API_KEY = realKey ?? '';
    });

    /** The body of the draft Gmail was asked to make, decoded as its encoding says. */
    function bodyOfDraft(text: string): string {
      const [headers, ...rest] = text.split('\r\n\r\n');
      const body = rest.join('\r\n\r\n');
      if (!/^Content-Transfer-Encoding: base64$/im.test(headers!)) return body;
      return new TextDecoder().decode(Uint8Array.from(atob(body.replace(/\s+/g, '')), (c) => c.charCodeAt(0)));
    }

    /** A conversation starred and brought in, its Item, and the mailbox it is followed in. */
    async function aFollowedConversation(): Promise<{ connection: string; itemId: string }> {
      const connection = await connected();
      mailbox.starred('t-1', 'Dinner one of these weeks?');
      return { connection, itemId: await broughtIn() };
    }

    async function broughtIn(): Promise<string> {
      await nextCheckRuns();
      return (await opened()).items.find((one) => one.sourceId === 't-1')!.id;
    }

    const at = (minute: number) => new Date(Date.UTC(2026, 9, 2, 8, minute)).toISOString();

    it('asks Claude with the title, the description, the points and the conversation without what it quotes, and makes the draft with its answer', async () => {
      const { connection, itemId } = await aFollowedConversation();
      mailbox.replies('t-1', {
        from: 'Steven Noels <steven@example.com>',
        text: 'Thursday evening?\n\nOn Fri, 2 Oct 2026 at 09:00, Anna Peeters <anna@example.com> wrote:\n> Shall we have dinner?',
        at: at(1),
      });
      await nextCheckRuns();
      claudeWrites('Hi Steven,\n\nOnly after 8pm works for me.\n\nAnna');

      const res = await emailed(itemId, connection, crypto.randomUUID(), undefined, { withClaude: true, points: 'only after 8pm' });

      expect(res.status).toBe(200);
      expect(claudeAsked).toHaveLength(1);
      expect(claudeAsked[0]).toMatchObject({ model: 'claude-sonnet-5-5', maxTokens: 1000 });
      const shown = claudeAsked[0]!.message;
      expect(shown).toContain('Item title: "Dinner one of these weeks?"');
      expect(shown).toContain('Points to make this time: "only after 8pm"');
      expect(shown).toContain('Thursday evening?');
      expect(shown).not.toContain('Shall we have dinner?');
      expect(gmailDrafts).toHaveLength(1);
      expect(gmailDrafts[0]!.threadId).toBe('t-1');
      expect(bodyOfDraft(gmailDrafts[0]!.text)).toBe('Hi Steven,\r\n\r\nOnly after 8pm works for me.\r\n\r\nAnna');
      const item = await theItem(itemId);
      expect(statusOf(item)).toBe('in progress');
      expect(item.conversation).toEqual(expect.objectContaining({ conversationId: 't-1', draftStarted: true }));
    });

    it('reads no conversation for an Item following nothing, and makes a new draft titled with the Item, with nobody to send it to', async () => {
      const connection = await connected();
      const itemId = await captured('Plan a dinner with Steven Noels');
      const asked = gmailCalls.length;
      claudeWrites('Hi Steven, which evening suits you? [which evening?]');

      const res = await emailed(itemId, connection, crypto.randomUUID(), undefined, { withClaude: true, points: '' });

      expect(res.status).toBe(200);
      expect(gmailCalls.slice(asked).filter((call) => call.startsWith('threads/'))).toEqual([]);
      expect(claudeAsked[0]!.message).toContain('Conversation so far: (none: this email starts it)');
      expect(claudeAsked[0]!.message).toContain('Points to make this time: (none)');
      const [draft] = gmailDrafts;
      expect(draft!.text).toMatch(/^Subject: Plan a dinner with Steven Noels\r$/m);
      expect(draft!.text).not.toMatch(/^To: /m);
      expect(bodyOfDraft(draft!.text)).toBe('Hi Steven, which evening suits you? [which evening?]');
    });

    it('shows Claude only the last 10 messages of a conversation of 30', async () => {
      const { connection, itemId } = await aFollowedConversation();
      for (let n = 1; n < 30; n += 1) mailbox.replies('t-1', { text: `Message ${n}`, at: at(n) });

      await emailed(itemId, connection, crypto.randomUUID(), undefined, { withClaude: true, points: 'yes' });

      const shown = claudeAsked[0]!.message;
      expect(shown.match(/ wrote, /g)).toHaveLength(10);
      expect(shown).toContain('Message 29');
      expect(shown).toContain('Message 20');
      expect(shown).not.toContain('Message 19');
    });

    it('cuts one message far over the cap before it reaches Claude', async () => {
      const { connection, itemId } = await aFollowedConversation();
      mailbox.replies('t-1', { text: 'x'.repeat(60_000), at: at(1) });

      await emailed(itemId, connection, crypto.randomUUID(), undefined, { withClaude: true, points: 'yes' });

      expect(claudeAsked[0]!.message.match(/x{100,}/)![0]).toHaveLength(4000);
    });

    it('brings a body with non-ASCII text and line breaks into the draft intact', async () => {
      const { connection, itemId } = await aFollowedConversation();
      claudeWrites('Dag Steven,\n\nDonderdag past mij prima ✓ — om [hoe laat?] in Gent?\n\nGroet,\nAnna', 'Dutch');

      await emailed(itemId, connection, crypto.randomUUID(), undefined, { withClaude: true, points: 'donderdag' });

      expect(bodyOfDraft(gmailDrafts[0]!.text)).toBe('Dag Steven,\r\n\r\nDonderdag past mij prima ✓ — om [hoe laat?] in Gent?\r\n\r\nGroet,\r\nAnna');
    });

    it('asks Claude once and makes one draft for a click sent twice, answering the second with the first’s link', async () => {
      const connection = await connected();
      const itemId = await captured('Plan a dinner with Steven Noels');
      const clickId = crypto.randomUUID();

      const first = await (await emailed(itemId, connection, clickId, undefined, { withClaude: true, points: 'yes' })).json();
      const again = await emailed(itemId, connection, clickId, undefined, { withClaude: true, points: 'yes' });

      expect(again.status).toBe(200);
      expect(await again.json()).toEqual(first);
      expect(claudeAsked).toHaveLength(1);
      expect(gmailDrafts).toHaveLength(1);
    });

    it('says the draft is Claude’s, where a draft of yours is not', async () => {
      const connection = await connected();
      const claudes = await captured('Plan a dinner with Steven Noels');
      const yours = await captured('Book the restaurant');

      expect((await emailed(claudes, connection, crypto.randomUUID(), undefined, { withClaude: true, points: 'yes' })).status).toBe(200);
      expect((await emailed(yours, connection)).status).toBe(200);

      expect((await theItem(claudes)).conversation).toEqual(expect.objectContaining({ draftStarted: true, claudeDrafted: true }));
      expect((await theItem(yours)).conversation).toEqual(expect.objectContaining({ draftStarted: true }));
      expect((await theItem(yours)).conversation).not.toHaveProperty('claudeDrafted');
    });
  });

  /**
   * Draft with Claude asked again ("Mail follow-up: a Claude draft looks like any
   * other and cannot be redone…", issue 1732): the draft recorded before is read
   * back with the look, compared with the fingerprint of what Claude wrote, and
   * rewritten in place only where it is unchanged; anything else is yours and is
   * opened. Gmail and Claude faked at the network; how the connector reads and
   * rewrites a draft is its own (packages/connectors/gmail/tests/unit/drafting-a-reply.test.ts).
   */
  describe('Draft with Claude asked again rewrites only Claude’s own unchanged draft', () => {
    let realKey: string | undefined;
    beforeEach(() => {
      realKey = env.ANTHROPIC_API_KEY;
      env.ANTHROPIC_API_KEY = 'sk-ant-api03-a-key-that-proves-nothing-WXYZ';
    });
    afterEach(() => {
      env.ANTHROPIC_API_KEY = realKey ?? '';
    });

    const withClaude = (points: string) => ({ withClaude: true, points });
    const digestOf = () => inTheStore((sql) => sql.exec('SELECT claude_draft_digest AS digest FROM item_conversations').one().digest as string | null);

    /** A conversation followed, and Claude's reply drafted in it. */
    async function claudeDrafted(): Promise<{ connection: string; itemId: string; link: string }> {
      const connection = await connected();
      mailbox.starred('t-1', 'Dinner one of these weeks?');
      await nextCheckRuns();
      const itemId = (await opened()).items.find((one) => one.sourceId === 't-1')!.id;
      claudeWrites('Hi Steven,\n\nThursday works.\n\nAnna');
      const res = await emailed(itemId, connection, crypto.randomUUID(), undefined, withClaude('thursday'));
      expect(res.status).toBe(200);
      return { connection, itemId, link: ((await res.json()) as { link: string }).link };
    }

    it('rewrites Claude’s unchanged draft in place with the new answer, the same draft and link, under a new fingerprint', async () => {
      const { connection, itemId, link } = await claudeDrafted();
      const before = await digestOf();
      claudeWrites('Hi Steven,\n\nFriday instead?\n\nAnna');

      const again = await emailed(itemId, connection, crypto.randomUUID(), undefined, withClaude('friday instead'));

      expect(again.status).toBe(200);
      expect(await again.json()).toEqual({ link });
      expect(claudeAsked).toHaveLength(2);
      expect(claudeAsked[1]!.message).toContain('Points to make this time: "friday instead"');
      expect(gmailDrafts).toHaveLength(1);
      expect(gmailDraftsUpdated).toEqual([expect.objectContaining({ id: 'r-1', threadId: 't-1' })]);
      expect(bodyOfDraftText(gmailDraftsUpdated[0]!.text)).toBe('Hi Steven,\r\n\r\nFriday instead?\r\n\r\nAnna');
      const after = await digestOf();
      expect(after).toMatch(/^[0-9a-f]{64}$/);
      expect(after).not.toBe(before);
      const item = await theItem(itemId);
      expect(statusOf(item)).toBe('in progress');
      expect(item.conversation).toEqual(expect.objectContaining({ draftStarted: true, claudeDrafted: true, link }));
    });

    it.each([
      { situation: 'edited in Gmail', happens: () => gmailDraftEdited('r-1', 'Hi Steven,\n\nThursday works, see you at 8.\n\nAnna') },
      { situation: 'one whose words cannot be read back, a file added to it', happens: () => gmailDraftEdited('r-1', 'Hi Steven,\n\nThursday works.\n\nAnna', { attaching: true }) },
      // A Claude draft recorded before fingerprints were kept reads as yours (rows that break the rule).
      { situation: 'one made before Claude’s drafts were told apart', happens: () => inTheStore((sql) => void sql.exec('UPDATE item_conversations SET claude_draft_digest = NULL')) },
    ])('opens the draft as yours, asking Claude nothing and writing nothing, where it is $situation', async ({ happens }) => {
      const { connection, itemId, link } = await claudeDrafted();
      await happens();

      const again = await emailed(itemId, connection, crypto.randomUUID(), undefined, withClaude('friday instead'));

      expect(again.status).toBe(200);
      expect(await again.json()).toEqual({ link });
      expect(claudeAsked).toHaveLength(1);
      expect(gmailDraftsUpdated).toEqual([]);
      expect(gmailDrafts).toHaveLength(1);
      // Yours from now on: the row no longer says Claude drafted it.
      expect(await digestOf()).toBeNull();
      expect((await theItem(itemId)).conversation).toEqual(expect.objectContaining({ draftStarted: true }));
      expect((await theItem(itemId)).conversation).not.toHaveProperty('claudeDrafted');
    });

    it('opens a draft of yours as before, asking Claude nothing and writing nothing', async () => {
      const connection = await connected();
      const itemId = await captured('Plan a dinner with Steven Noels');
      expect((await emailed(itemId, connection)).status).toBe(200);
      const before = await theItem(itemId);

      const again = await emailed(itemId, connection, crypto.randomUUID(), undefined, withClaude('something else'));

      expect(again.status).toBe(200);
      expect(await again.json()).toEqual({ link: DRAFT_LINK });
      expect(claudeAsked).toHaveLength(0);
      expect(gmailDraftsUpdated).toEqual([]);
      expect(gmailDrafts).toHaveLength(1);
      expect(await theItem(itemId)).toEqual(before);
    });

    it('opens Claude’s draft without rewriting it where Write it myself is pressed', async () => {
      const { connection, itemId, link } = await claudeDrafted();
      const before = await digestOf();

      const again = await emailed(itemId, connection);

      expect(await again.json()).toEqual({ link });
      expect(claudeAsked).toHaveLength(1);
      expect(gmailDraftsUpdated).toEqual([]);
      expect(await digestOf()).toBe(before);
    });

    it.each([
      { situation: 'Gmail will not take the rewrite', fails: () => gmailAnswersWith(503, (call) => call === 'drafts/r-1'), why: 'Gmail did not answer. Try again in a moment.' },
      { situation: 'Claude cannot write it', fails: () => claudeAnswersWith(529), why: 'Claude could not draft it.' },
    ])('keeps Claude’s draft and its fingerprint, saying why and that nothing was put back, where $situation', async ({ fails, why }) => {
      const { connection, itemId } = await claudeDrafted();
      const before = await digestOf();
      const item = await theItem(itemId);
      fails();

      const again = await emailed(itemId, connection, crypto.randomUUID(), undefined, withClaude('friday instead'));

      expect(again.status).toBe(502);
      expect(await again.json()).toEqual({ error: `Couldn't make the draft: ${why}`, putBack: false });
      expect(bodyOfDraftText(gmailDrafts[0]!.text)).toBe('Hi Steven,\r\n\r\nThursday works.\r\n\r\nAnna');
      expect(await digestOf()).toBe(before);
      expect(await theItem(itemId)).toEqual(item);
    });

    it('asks Claude once and rewrites once for the same click sent twice', async () => {
      const { connection, itemId, link } = await claudeDrafted();
      const clickId = crypto.randomUUID();

      const first = await emailed(itemId, connection, clickId, undefined, withClaude('friday instead'));
      const again = await emailed(itemId, connection, clickId, undefined, withClaude('friday instead'));

      expect(await first.json()).toEqual({ link });
      expect(await again.json()).toEqual({ link });
      expect(claudeAsked).toHaveLength(2);
      expect(gmailDraftsUpdated).toHaveLength(1);
    });

    it('rewrites it again where it is asked again, still unchanged', async () => {
      const { connection, itemId } = await claudeDrafted();

      await emailed(itemId, connection, crypto.randomUUID(), undefined, withClaude('friday'));
      claudeWrites('Hi Steven,\n\nSaturday then.\n\nAnna');
      await emailed(itemId, connection, crypto.randomUUID(), undefined, withClaude('saturday'));

      expect(claudeAsked).toHaveLength(3);
      expect(gmailDraftsUpdated).toHaveLength(2);
      expect(gmailDrafts).toHaveLength(1);
    });
  });

  /**
   * The fingerprint lives and ends with Claude's draft (issue 1732): a check
   * finding it sent or deleted clears it with the draft, through the pulled host.
   */
  describe('Claude’s fingerprint ends with its draft', () => {
    let realKey: string | undefined;
    beforeEach(() => {
      realKey = env.ANTHROPIC_API_KEY;
      env.ANTHROPIC_API_KEY = 'sk-ant-api03-a-key-that-proves-nothing-WXYZ';
    });
    afterEach(() => {
      env.ANTHROPIC_API_KEY = realKey ?? '';
    });

    /** A followed conversation's Item that was To do, and Claude's reply drafted in it. */
    async function claudeReplied(): Promise<string> {
      const connection = await connected();
      mailbox.starred('t-1', 'Dinner one of these weeks?');
      await nextCheckRuns();
      const itemId = (await opened()).items.find((one) => one.sourceId === 't-1')!.id;
      expect((await emailed(itemId, connection, crypto.randomUUID(), undefined, { withClaude: true, points: 'yes' })).status).toBe(200);
      expect((await theItem(itemId)).conversation?.claudeDrafted).toBe(true);
      return itemId;
    }

    const digests = () => inTheStore((sql) => sql.exec('SELECT claude_draft_digest AS digest FROM item_conversations').toArray().map((row) => row.digest));

    it('clears it once the draft is sent, the Item Waiting for reply', async () => {
      const itemId = await claudeReplied();

      mailbox.sends(gmailDrafts[0]!.id);
      await nextCheckRuns();

      const item = await theItem(itemId);
      expect(statusOf(item)).toBe('waiting');
      expect(item.conversation).not.toHaveProperty('claudeDrafted');
      expect(await digests()).toEqual([null]);
    });

    it('clears it once the draft is deleted unsent, the status before put back', async () => {
      const itemId = await claudeReplied();

      mailbox.deletes(gmailDrafts[0]!.id);
      await nextCheckRuns();

      const item = await theItem(itemId);
      expect(statusOf(item)).toBe('to do');
      expect(item.conversation).not.toHaveProperty('draftStarted');
      expect(await digests()).toEqual([null]);
    });
  });

  describe('when Claude cannot draft, nothing is drafted and the Item is put back', () => {
    let realKey: string | undefined;
    beforeEach(() => {
      realKey = env.ANTHROPIC_API_KEY;
      env.ANTHROPIC_API_KEY = 'sk-ant-api03-a-key-that-proves-nothing-WXYZ';
    });
    afterEach(() => {
      env.ANTHROPIC_API_KEY = realKey ?? '';
    });

    const COULD_NOT = { error: "Couldn't make the draft: Claude could not draft it.", putBack: true };

    /** An Item that was Waiting for reply, so putting it back is told from leaving it In progress. */
    async function aWaitingItem(): Promise<{ connection: string; itemId: string }> {
      const connection = await connected();
      const itemId = await captured('Plan a dinner with Steven Noels');
      await waitingForReply(itemId);
      return { connection, itemId };
    }

    async function nothingWasKept(itemId: string): Promise<void> {
      const item = await theItem(itemId);
      expect(statusOf(item)).toBe('waiting');
      expect(item.conversation).toBeUndefined();
      expect(gmailDrafts).toEqual([]);
    }

    it('makes no draft where Claude answers an error, asking it once and not again', async () => {
      const { connection, itemId } = await aWaitingItem();
      claudeAnswersWith(529);

      const res = await emailed(itemId, connection, crypto.randomUUID(), undefined, { withClaude: true, points: 'yes' });

      expect(res.status).toBe(502);
      expect(await res.json()).toEqual(COULD_NOT);
      expect(claudeAsked).toHaveLength(1);
      await nothingWasKept(itemId);
    });

    // The one case that waits the cut-off out: the SDK's timer is what ends the call, and it cannot be
    // faked under the runtime the Worker runs in (a held clock hangs the store's own requests).
    it('makes no draft where Claude has not answered in 20 seconds', { timeout: 40_000 }, async () => {
      const { connection, itemId } = await aWaitingItem();
      claudeGoesSilent();
      const started = performance.now();

      const res = await emailed(itemId, connection, crypto.randomUUID(), undefined, { withClaude: true, points: 'yes' });

      expect(performance.now() - started).toBeGreaterThanOrEqual(19_000);
      expect(performance.now() - started).toBeLessThan(30_000);
      expect(res.status).toBe(502);
      expect(await res.json()).toEqual(COULD_NOT);
      expect(claudeAsked).toHaveLength(1);
      expect((await env.DB.prepare("SELECT outcome FROM provider_calls WHERE operation = 'draft-a-reply'").all<{ outcome: string }>()).results).toEqual([
        { outcome: 'timed-out' },
      ]);
      await nothingWasKept(itemId);
    });

    it('puts the Item back where Gmail refuses the draft after Claude answered, the call recorded all the same', async () => {
      const { connection, itemId } = await aWaitingItem();
      gmailAnswersWith(401, (call) => call === 'drafts');
      googleRefreshes('refuses');

      const res = await emailed(itemId, connection, crypto.randomUUID(), undefined, { withClaude: true, points: 'yes' });

      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({ error: "Couldn't make the draft: Google no longer accepts the sign-in. Connect again.", putBack: true });
      expect(claudeAsked).toHaveLength(1);
      expect((await env.DB.prepare("SELECT outcome FROM provider_calls WHERE operation = 'draft-a-reply'").all<{ outcome: string }>()).results).toEqual([
        { outcome: 'ok' },
      ]);
      await nothingWasKept(itemId);
    });

    it('refuses points over the limit before anything is called', async () => {
      const { connection, itemId } = await aWaitingItem();
      const asked = gmailCalls.length;

      const res = await emailed(itemId, connection, crypto.randomUUID(), undefined, { withClaude: true, points: 'x'.repeat(2001) });

      expect(res.status).toBe(400);
      expect(claudeAsked).toHaveLength(0);
      expect(gmailCalls.length).toBe(asked);
      await nothingWasKept(itemId);
    });

    it('refuses an Item of another account, calling nothing', async () => {
      const connection = await connected();
      const itemId = await captured('Plan a dinner with Steven Noels');
      const asked = gmailCalls.length;

      const res = await emailed(itemId, connection, crypto.randomUUID(), OTHER_USER_ID, { withClaude: true, points: 'yes' });

      expect(res.status).toBe(404);
      expect(claudeAsked).toHaveLength(0);
      expect(gmailCalls.length).toBe(asked);
      expect(statusOf(await theItem(itemId))).toBe('to do');
    });
  });

  describe('every draft made with Claude is recorded like Cockpit’s other Claude calls', () => {
    let realKey: string | undefined;
    let realGuestSignIn: string | undefined;
    beforeEach(() => {
      realKey = env.ANTHROPIC_API_KEY;
      realGuestSignIn = env.GUEST_SIGN_IN;
      env.ANTHROPIC_API_KEY = 'sk-ant-api03-a-key-that-proves-nothing-WXYZ';
    });
    afterEach(() => {
      env.ANTHROPIC_API_KEY = realKey ?? '';
      if (realGuestSignIn === undefined) delete env.GUEST_SIGN_IN;
      else env.GUEST_SIGN_IN = realGuestSignIn;
    });

    it('records one call under the draft prompt’s name, with its cost and for whom it was made', async () => {
      const connection = await connected();
      const itemId = await captured('Plan a dinner with Steven Noels');

      expect((await emailed(itemId, connection, crypto.randomUUID(), undefined, { withClaude: true, points: 'yes' })).status).toBe(200);

      const rows = (await env.DB.prepare('SELECT * FROM provider_calls').all<Record<string, unknown>>()).results;
      expect(rows).toEqual([
        expect.objectContaining({
          operation: 'draft-a-reply',
          prompt_version: 'draft-a-reply.v1',
          triggered_by: 'draft-asked-in-app',
          model: 'claude-sonnet-5-5',
          outcome: 'ok',
          item_id: itemId,
          tokens_in: 1200,
          tokens_out: 150,
        }),
      ]);
      expect(rows[0]!.cost_usd).toBeGreaterThan(0);
    });

    it('refuses the guest account a draft with Claude, calling neither Claude nor Gmail', async () => {
      env.GUEST_SIGN_IN = 'true';
      const back = await SELF.fetch('http://cockpit.test/v1/sign-in/guest', { redirect: 'manual' });
      const guest = back.headers
        .getSetCookie()
        .map((cookie) => cookie.split(';')[0]!)
        .find((cookie) => cookie.startsWith('cockpit_session=') && !cookie.endsWith('='))!;
      const asked = gmailCalls.length;

      const res = await SELF.fetch(`http://cockpit.test/v1/workspaces/${WORKSPACE_ID}/items/${crypto.randomUUID()}/draft`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: guest },
        body: JSON.stringify({ clickId: crypto.randomUUID(), sourceAccountId: 'sa-1', withClaude: true, points: 'yes' }),
      });

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'Claude cannot draft here.' });
      expect(claudeAsked).toHaveLength(0);
      expect(gmailCalls.length).toBe(asked);
    });

    it('offers a draft with Claude only where the environment has a key it may spend', async () => {
      env.ANTHROPIC_API_KEY = '';
      const connection = await connected();

      expect((await opened()).mailboxes).toEqual([expect.not.objectContaining({ claudeDrafts: true })]);
      env.ANTHROPIC_API_KEY = 'sk-ant-api03-a-key-that-proves-nothing-WXYZ';
      expect((await opened()).mailboxes).toEqual([expect.objectContaining({ sourceAccountId: connection, claudeDrafts: true })]);
    });

    it('writes the local stacks’ stand-in reply into the draft, asking no model and recording no call, where the stack has no key', async () => {
      env.ANTHROPIC_API_KEY = '';
      env.DRAFT_STAND_IN = 'true';
      try {
        const connection = await connected();
        const itemId = await captured('Plan a dinner with Steven Noels');

        const res = await emailed(itemId, connection, crypto.randomUUID(), undefined, { withClaude: true, points: 'only after 8pm' });

        expect(res.status).toBe(200);
        expect(claudeAsked).toHaveLength(0);
        expect((await env.DB.prepare('SELECT count(*) AS n FROM provider_calls').first<{ n: number }>())!.n).toBe(0);
        expect(gmailDrafts[0]!.text).toContain('Content-Transfer-Encoding: base64');
        const body = new TextDecoder().decode(
          Uint8Array.from(atob(gmailDrafts[0]!.text.split('\r\n\r\n')[1]!.replace(/\s+/g, '')), (c) => c.charCodeAt(0)),
        );
        expect(body).toContain('Points: only after 8pm');
      } finally {
        env.DRAFT_STAND_IN = '';
      }
    });
  });
});