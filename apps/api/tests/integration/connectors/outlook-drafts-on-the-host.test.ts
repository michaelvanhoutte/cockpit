import { afterEach, beforeEach, describe, expect, inject, it } from 'vitest';
import { SELF, applyD1Migrations, env, runDurableObjectAlarm } from 'cloudflare:test';
import type { Conversation, WorkspaceSnapshot } from '@cockpit/shared';
import type { EnrichmentJob } from '../../../src/jobs/enrichment.js';
import { handleQueue } from '../../../src/jobs/index.js';
import { mailboxesOf } from '../../../src/connectors/drafts.js';
import { ACCOUNT_NAME, WORKSPACE_ID, asUser, inTheStore, seedRegister, signInAs, startFromEmpty, storeNamed } from '../seed.js';
import { issuerIsForgotten, issuerIsReachable, issuerWillIdentify } from '../issuer.js';
import { graphDeletes, graphDrafts, graphHolds, graphSends } from '../graph.js';
import type { MessageOptions } from '../../../../../packages/connectors/outlook/tests/graph-payloads.js';

/**
 * Integration level: *Email…* and *Reply…* through the real route and store
 * with an Outlook connection, Graph faked at the network (`../graph.ts`), then
 * what a check finds of the draft through the pulled host ("Email… makes an
 * Outlook draft the Item then follows", issue 1709). What is under test is that
 * the route, the click and the draft's states the Gmail unit built
 * (drafts-on-the-host.test.ts) hold with this connector. How a draft is written
 * and how a check tells sent from deleted is the connector's
 * (packages/connectors/outlook/tests/unit/making-drafts.test.ts).
 */

const ANNA = { email: 'anna@example.com', tenant: 'tenant-of-anna', object: 'object-of-anna' };

let held: EnrichmentJob[] = [];
let realQueue: typeof env.ENRICHMENT;

const now = () => new Date(); // clock-ok: a queue message and a person's change are stamped by the real clock

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

/** The alarm firing, and each check it queued delivered; fired again while it queues none. */
async function nextCheckRuns(): Promise<void> {
  for (let fired = 0; fired < 5; fired += 1) {
    await runDurableObjectAlarm(storeNamed(ACCOUNT_NAME));
    const checks = takeQueuedChecks();
    if (checks.length === 0) continue;
    for (const check of checks) await deliver(check);
    return;
  }
}

/** Connect on the Outlook card choosing `choice` - the whole trip through Microsoft - and its first check; answers the connection's id. */
async function connected(choice: 'flag' | 'category' = 'flag'): Promise<string> {
  const session = await signInAs();
  const started = await SELF.fetch(
    `http://cockpit.test/v1/workspaces/${WORKSPACE_ID}/connections/outlook/connect?choice=${choice}&filesByName=false`,
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
    scope: 'openid email profile offline_access Mail.ReadWrite',
  });
  const back = await SELF.fetch(
    `http://cockpit.test/v1/connections/outlook/callback?code=a-code&state=${asked.searchParams.get('state')}`,
    { redirect: 'manual', headers: { cookie: `${session}; ${attempt}` } },
  );
  expect(back.headers.get('location')).toBe(`/w/${WORKSPACE_ID}?connections=connected`);
  await firstCheckRuns();
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

/** *Email…* or *Reply…* clicked on an Item, through the mailbox named, under the click's own id. */
function emailed(itemId: string, sourceAccountId: string, clickId: string = crypto.randomUUID()): Promise<Response> {
  return asUser(`http://cockpit.test/v1/workspaces/${WORKSPACE_ID}/items/${itemId}/draft`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ clickId, sourceAccountId }),
  });
}

const DRAFT_LINK = (id: string) => `https://outlook.office365.com/owa/?ItemID=${id}&exvsurl=1&viewmodel=ReadMessageItem`;

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
});

afterEach(() => {
  env.ENRICHMENT = realQueue;
  issuerIsForgotten();
});

describe('Triage', () => {
  describe('Email… makes one draft per click through an Outlook connection, and the Item follows the conversation it starts', () => {
    it('makes a new conversation’s draft titled with the Item, puts the Item In progress, and answers where Outlook opens it', async () => {
      graphHolds([]);
      const connection = await connected();
      const itemId = await captured('Plan a dinner with Steven Noels');

      const res = await emailed(itemId, connection);

      expect(res.status).toBe(200);
      expect((await opened()).mailboxes).toEqual([expect.objectContaining({ sourceAccountId: connection, connectorId: 'outlook' })]);
      expect(graphDrafts).toEqual([{ id: 'draft-m-1', subject: 'Plan a dinner with Steven Noels', replyTo: null }]);
      expect(await res.json()).toEqual({ link: DRAFT_LINK('draft-m-1') });
      const item = await theItem(itemId);
      expect(statusOf(item)).toBe('in progress');
      expect(item.conversation).toEqual(
        expect.objectContaining<Partial<Conversation>>({ source: 'outlook', draftStarted: true, lastBy: 'you' }),
      );
    });

    it('makes a reply draft in the conversation a followed Item follows', async () => {
      const flagged: MessageOptions = { id: 'message-1', flag: 'flagged', conversation: 'c-1', subject: 'Dinner?', receivedAt: '2026-10-01T08:00:00Z' };
      graphHolds([flagged]);
      const connection = await connected();
      const itemId = (await opened()).items.find((one) => one.sourceId === 'conversation:c-1')!.id;

      const res = await emailed(itemId, connection);

      expect(res.status).toBe(200);
      expect(graphDrafts).toEqual([{ id: 'draft-m-1', subject: 'RE: Dinner?', replyTo: 'message-1' }]);
      expect((await theItem(itemId)).conversation).toEqual(expect.objectContaining({ conversationId: 'c-1', draftStarted: true }));
    });

    it('makes one draft for a click sent twice, answering the second with the first’s link', async () => {
      graphHolds([]);
      const connection = await connected();
      const itemId = await captured('Plan a dinner with Steven Noels');
      const clickId = crypto.randomUUID();

      const first = await (await emailed(itemId, connection, clickId)).json();
      const again = await emailed(itemId, connection, clickId);

      expect(again.status).toBe(200);
      expect(await again.json()).toEqual(first);
      expect(graphDrafts).toHaveLength(1);
    });

    it('offers Email… only through an Outlook connection following the flag', async () => {
      graphHolds([]);
      await connected('category');

      expect((await opened()).mailboxes).toEqual([]);
    });

    it('lists a Gmail connection and an Outlook one together, each by its own connector', () => {
      const mailboxes = mailboxesOf(env, [
        { id: 'a', connectorId: 'gmail', displayName: 'anna@gmail.example', follows: 'star' },
        { id: 'b', connectorId: 'outlook', displayName: 'anna@example.com', follows: 'flag' },
        { id: 'c', connectorId: 'outlook', displayName: 'other@example.com', follows: 'category' },
      ]);

      expect(mailboxes).toEqual([
        { sourceAccountId: 'a', connectorId: 'gmail', name: 'anna@gmail.example' },
        { sourceAccountId: 'b', connectorId: 'outlook', name: 'anna@example.com' },
      ]);
    });
  });

  describe('what happens to the draft in Outlook moves the Item', () => {
    /** An Item captured and emailed: its draft made, the Item In progress following its conversation. */
    async function aDraftStarted(): Promise<string> {
      graphHolds([]);
      const connection = await connected();
      const itemId = await captured('Plan a dinner with Steven Noels');
      expect((await emailed(itemId, connection)).status).toBe(200);
      return itemId;
    }

    it('makes the Item Waiting for reply once the draft is sent, the draft no longer waited on', async () => {
      const itemId = await aDraftStarted();

      graphSends('draft-m-1');
      await nextCheckRuns();

      const item = await theItem(itemId);
      expect(statusOf(item)).toBe('waiting');
      expect(item.conversation).toEqual(expect.objectContaining({ lastBy: 'you', messageCount: 1 }));
      expect(item.conversation?.draftStarted).toBeFalsy();
    });

    it('puts the status before back, following nothing, once the draft is deleted unsent', async () => {
      const itemId = await aDraftStarted();

      graphDeletes('draft-m-1');
      await nextCheckRuns();

      const item = await theItem(itemId);
      expect(statusOf(item)).toBe('to do');
      expect(item.conversation).toBeUndefined();
    });

    it('makes no second draft while the first is still unsent: the click opens the first, and nothing changes', async () => {
      graphHolds([]);
      const connection = await connected();
      const itemId = await captured('Plan a dinner with Steven Noels');
      expect((await emailed(itemId, connection)).status).toBe(200);
      const before = await theItem(itemId);

      const again = await emailed(itemId, connection);

      expect(await again.json()).toEqual({ link: DRAFT_LINK('draft-m-1') });
      expect(graphDrafts).toHaveLength(1);
      expect(await theItem(itemId)).toEqual(before);
    });

    it('makes a new draft where the first is in Deleted Items before any check saw it', async () => {
      graphHolds([]);
      const connection = await connected();
      const itemId = await captured('Plan a dinner with Steven Noels');
      expect((await emailed(itemId, connection)).status).toBe(200);
      graphDeletes('draft-m-1');

      const again = await emailed(itemId, connection);

      expect(await again.json()).toEqual({ link: DRAFT_LINK('draft-m-2') });
      expect(graphDrafts).toHaveLength(2);
      expect((await theItem(itemId)).conversation).toEqual(expect.objectContaining({ draftStarted: true, link: DRAFT_LINK('draft-m-2') }));
    });

    it('makes no new draft where the first was sent before any check saw it, and changes nothing', async () => {
      graphHolds([]);
      const connection = await connected();
      const itemId = await captured('Plan a dinner with Steven Noels');
      expect((await emailed(itemId, connection)).status).toBe(200);
      graphSends('draft-m-1');
      const before = await theItem(itemId);

      const again = await emailed(itemId, connection);

      expect(again.status).toBe(409);
      expect(graphDrafts).toHaveLength(1);
      expect(await theItem(itemId)).toEqual(before);
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
