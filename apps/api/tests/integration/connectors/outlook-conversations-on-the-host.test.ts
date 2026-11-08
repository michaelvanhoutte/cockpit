import { afterEach, beforeEach, describe, expect, inject, it } from 'vitest';
import { SELF, applyD1Migrations, env, runDurableObjectAlarm } from 'cloudflare:test';
import type { WorkspaceSnapshot } from '@cockpit/shared';
import type { EnrichmentJob } from '../../../src/jobs/enrichment.js';
import { handleQueue } from '../../../src/jobs/index.js';
import { OUTLOOK_CALLS_PER_RUN } from '../../../src/connectors/registry.js';
import { ACCOUNT_NAME, WORKSPACE_ID, asUser, inTheStore, seedRegister, signInAs, startFromEmpty, storeNamed } from '../seed.js';
import { issuerIsForgotten, issuerIsReachable, issuerWillIdentify, refreshes } from '../issuer.js';
import { graphAdds, graphCalls, graphHolds, graphMessage } from '../graph.js';
import { SENT_ITEMS_ID, type MessageOptions } from '../../../../../packages/connectors/outlook/tests/graph-payloads.js';

/**
 * Integration level: an Outlook connection following the flag, run by the
 * generic host against the real store, with Graph faked at the network
 * (`../graph.ts`) - "Outlook follows the flagged conversation as Gmail does"
 * (issue 1707). What is under test is the store's: the key an Item's link is
 * filed under, the one logged change a turn is applied by, and the flag Done
 * completes. What Graph says and which message is a turn is the connector's
 * own, proved in its package (following-flagged-conversations.test.ts); what a
 * turn does to a status is apps/api/tests/unit/domain/conversations.test.ts.
 *
 * **The queue is held**, so each check is delivered through the real consumer
 * by the case.
 */

const ANNA = { email: 'anna@example.com', tenant: 'tenant-of-anna', object: 'object-of-anna' };

let held: EnrichmentJob[] = [];
let realQueue: typeof env.ENRICHMENT;
let clock = 0;

const now = () => new Date(); // clock-ok: a queue message and a person's change are stamped by the real clock

/** Each message arrives a minute after the one before, after the connection was made. */
function later(): string {
  clock += 1;
  return new Date(Date.now() + clock * 60_000).toISOString(); // clock-ok: the connector reads mail received since the real time it last ran
}

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

/** Connect on the Outlook card choosing the flag - the whole trip through Microsoft - and its first check. */
async function connectedByFlag(): Promise<void> {
  const session = await signInAs();
  const started = await SELF.fetch(
    `http://cockpit.test/v1/workspaces/${WORKSPACE_ID}/connections/outlook/connect?choice=flag&filesByName=false`,
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
}

async function opened(): Promise<WorkspaceSnapshot> {
  const res = await asUser(`http://cockpit.test/v1/workspaces/${WORKSPACE_ID}/snapshot`);
  expect(res.status).toBe(200);
  return (await res.json()) as WorkspaceSnapshot;
}

/** The Outlook Items a Workspace opens with, each with the conversation it follows. */
async function outlookItems() {
  const read = await opened();
  return read.items
    .filter((item) => item.source === 'outlook')
    .map((item) => ({ ...item, conversation: (read.conversations ?? []).find((one) => one.itemId === item.id) }));
}

async function theItem(sourceId: string) {
  const found = (await outlookItems()).find((item) => item.sourceId === sourceId);
  if (!found) throw new Error(`no Item from ${sourceId}`);
  return found;
}

function statusOf(item: { completedAt: string | null; waitingSince: string | null; startedAt: string | null }): string {
  return item.completedAt ? 'done' : item.waitingSince ? 'waiting' : item.startedAt ? 'in progress' : 'to do';
}

function turnsLogged(): Promise<unknown[]> {
  return inTheStore((sql) =>
    sql.exec("SELECT payload FROM commands WHERE name = 'record_conversation_turn' ORDER BY received_at").toArray(),
  );
}

async function markDone(itemId: string, done = true): Promise<void> {
  const res = await asUser('http://cockpit.test/v1/commands/set_done', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ commandId: crypto.randomUUID(), issuedAt: now().toISOString(), workspaceId: WORKSPACE_ID, itemId, done }),
  });
  expect(res.status).toBe(200);
}

const FLAGGED_IN_C1: MessageOptions = { id: 'message-1', flag: 'flagged', conversation: 'c-1', subject: 'Dinner?', receivedAt: '2026-10-01T08:00:00Z' };

/** An Item following a conversation with one flagged message, brought in by the first check. */
async function aFollowedConversation(): Promise<void> {
  graphHolds([FLAGGED_IN_C1]);
  await connectedByFlag();
}

function flagsOf(ids: string[]): (string | undefined)[] {
  return ids.map((id) => graphMessage(id)?.flag);
}

beforeEach(async () => {
  await applyD1Migrations(env.DB, inject('migrations'));
  await startFromEmpty();
  await seedRegister();
  held = [];
  clock = 0;
  holdTheQueue();
  await issuerIsReachable();
});

afterEach(() => {
  env.ENRICHMENT = realQueue;
  issuerIsForgotten();
});

describe('Capture', () => {
  describe('an Outlook connection following the flag makes one Item per conversation', () => {
    it('makes one Item, titled with the flagged message’s subject, following its conversation', async () => {
      graphHolds([
        { id: 'message-0', conversation: 'c-1', receivedAt: '2026-09-30T08:00:00Z', from: { name: 'Anna', address: ANNA.email }, folder: SENT_ITEMS_ID },
        FLAGGED_IN_C1,
      ]);
      await connectedByFlag();

      expect(await outlookItems()).toEqual([
        expect.objectContaining({
          title: 'Dinner?',
          sourceId: 'conversation:c-1',
          conversation: expect.objectContaining({
            source: 'outlook',
            conversationId: 'c-1',
            lastBy: 'them',
            lastFrom: 'Pieter Claes',
            messageCount: 2,
            withWhom: 'Pieter Claes',
          }),
        }),
      ]);
    });

    it('makes no new Item for a second message flagged in that conversation', async () => {
      await aFollowedConversation();
      graphAdds([{ id: 'message-2', flag: 'flagged', conversation: 'c-1', receivedAt: later() }]);

      await nextCheckRuns();

      expect((await outlookItems()).map((item) => item.sourceId)).toEqual(['conversation:c-1']);
    });

    it('leaves an Item made of one message before untouched, and makes one conversation Item beside it', async () => {
      graphHolds([{ id: 'message-old', flag: 'flagged', conversation: 'c-old', subject: 'Invoice 42', receivedAt: '2026-10-01T08:00:00Z' }]);
      await connectedByFlag();
      // As a release before filed it: under the message's own id, the connector remembering it as read.
      await inTheStore((sql) => {
        const links = sql.exec<{ source_id: string }>('SELECT source_id FROM pulled_links').toArray();
        expect(links.map((link) => link.source_id)).toEqual(['conversation:c-old']);
        sql.exec("UPDATE pulled_links SET source_id = 'message-old'");
        sql.exec("UPDATE items SET source_id = 'message-old' WHERE source_id = 'conversation:c-old'");
        sql.exec("DELETE FROM item_conversations");
        const state = JSON.parse(sql.exec<{ state: string }>('SELECT state FROM pulled_connections').one().state) as Record<string, unknown>;
        sql.exec('UPDATE pulled_connections SET state = ?', JSON.stringify({ ...state, seen: ['message-old'], read: [], names: {} }));
      });
      graphAdds([{ id: 'message-2', flag: 'flagged', conversation: 'c-2', subject: 'Dinner?', receivedAt: later() }]);

      await nextCheckRuns();

      const items = await outlookItems();
      expect(items.map((item) => item.sourceId).sort()).toEqual(['conversation:c-2', 'message-old']);
      expect(items.find((item) => item.sourceId === 'message-old')).toEqual(
        expect.objectContaining({ title: 'Invoice 42', completedAt: null, conversation: undefined }),
      );
      expect(items.find((item) => item.sourceId === 'conversation:c-2')!.conversation).toBeDefined();
    });
  });
});

describe('Triage', () => {
  describe('a reply in a followed conversation reaches the Item through one logged change', () => {
    it('makes the Item To do on a message from someone else, and Waiting for reply on one sent from the mailbox', async () => {
      await aFollowedConversation();
      expect(statusOf(await theItem('conversation:c-1'))).toBe('to do');

      graphAdds([{ id: 'message-2', conversation: 'c-1', receivedAt: later(), folder: SENT_ITEMS_ID, from: { name: 'Anna', address: ANNA.email }, text: 'How about Thursday?' }]);
      await nextCheckRuns();
      const waiting = await theItem('conversation:c-1');
      expect(statusOf(waiting)).toBe('waiting');
      expect(waiting.conversation).toEqual(expect.objectContaining({ lastBy: 'you', messageCount: 2 }));

      graphAdds([{ id: 'message-3', conversation: 'c-1', receivedAt: later(), text: 'Thursday is tricky.' }]);
      await nextCheckRuns();

      const after = await theItem('conversation:c-1');
      expect(statusOf(after)).toBe('to do');
      expect(after.conversation).toEqual(
        expect.objectContaining({ lastBy: 'them', lastFrom: 'Pieter Claes', messageCount: 3, lastExcerpt: 'Thursday is tricky.' }),
      );
      expect(await turnsLogged()).toHaveLength(2);
    });

    it('records nothing for a message in a conversation no open Item follows', async () => {
      await aFollowedConversation();
      graphAdds([{ id: 'message-9', conversation: 'c-elsewhere', receivedAt: later() }]);

      await nextCheckRuns();

      expect(await turnsLogged()).toEqual([]);
    });
  });

  describe('Done completes the flag on every message of the conversation, and flagging one again reopens the same Item', () => {
    it('completes each flagged message, and the Item stays done', async () => {
      await aFollowedConversation();
      graphAdds([
        { id: 'message-2', flag: 'flagged', conversation: 'c-1', receivedAt: later() },
        { id: 'message-3', flag: 'flagged', conversation: 'c-1', receivedAt: later() },
      ]);
      await nextCheckRuns();
      const item = await theItem('conversation:c-1');

      await markDone(item.id);
      await nextCheckRuns();

      expect(flagsOf(['message-1', 'message-2', 'message-3'])).toEqual(['complete', 'complete', 'complete']);
      expect(statusOf(await theItem('conversation:c-1'))).toBe('done');
    });

    it('leaves the rest of a conversation with more flagged messages than a run reaches to the next run, within the calls a run is allowed', async () => {
      await aFollowedConversation();
      const many = Array.from({ length: OUTLOOK_CALLS_PER_RUN + 5 }, (_, nth) => ({
        id: `extra-${String(nth).padStart(3, '0')}`,
        flag: 'flagged' as const,
        conversation: 'c-1',
        receivedAt: later(),
      }));
      graphAdds(many);
      await nextCheckRuns();
      const item = await theItem('conversation:c-1');
      const all = ['message-1', ...many.map((one) => one.id)];

      await markDone(item.id);
      graphCalls.length = 0;
      refreshes.length = 0;
      await nextCheckRuns();

      const stillFlagged = all.filter((id) => graphMessage(id)?.flag === 'flagged');
      expect(stillFlagged.length).toBeGreaterThan(0);
      expect(stillFlagged.length).toBeLessThan(all.length);
      expect(graphCalls.length + refreshes.length).toBeLessThanOrEqual(OUTLOOK_CALLS_PER_RUN);

      for (let more = 0; more < 5 && all.some((id) => graphMessage(id)?.flag === 'flagged'); more += 1) await nextCheckRuns();

      expect(all.filter((id) => graphMessage(id)?.flag === 'flagged')).toEqual([]);
      expect(statusOf(await theItem('conversation:c-1'))).toBe('done');
    });

    it('reopens the same Item once a message in the conversation is flagged again', async () => {
      await aFollowedConversation();
      const item = await theItem('conversation:c-1');
      await markDone(item.id);
      await nextCheckRuns();
      expect(statusOf(await theItem('conversation:c-1'))).toBe('done');

      graphAdds([{ id: 'message-2', flag: 'flagged', conversation: 'c-1', receivedAt: later() }]);
      await nextCheckRuns();

      const again = await theItem('conversation:c-1');
      expect(again.id).toBe(item.id);
      expect(statusOf(again)).toBe('to do');
      expect((await outlookItems()).length).toBe(1);
    });

    it('marks the Item done at the next check once every flag in Outlook is cleared', async () => {
      await aFollowedConversation();

      graphMessage('message-1')!.flag = 'complete';
      await nextCheckRuns();

      expect(statusOf(await theItem('conversation:c-1'))).toBe('done');
    });
  });
});
