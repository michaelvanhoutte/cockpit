import { afterEach, beforeEach, describe, expect, inject, it, vi } from 'vitest';
import { applyD1Migrations, env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import type { Connector, ConnectorHost, SourceItem } from '@cockpit/connector-sdk';
import type { WorkspaceSnapshot } from '@cockpit/shared';
import type { EnrichmentJob } from '../../../src/jobs/enrichment.js';
import { handleQueue } from '../../../src/jobs/index.js';
import { createAccountDb } from '../../../src/accounts/client.js';
import { conversationsInWorkspace } from '../../../src/accounts/repo.js';
import { seal, sealingKey } from '../../../src/connectors/credential-crypto.js';
import { finishedKeptAfter } from '../../../src/domain/workspace-read.js';
import { ACCOUNT_NAME, WORKSPACE_ID, asUser, inTheStore, seedRegister, startFromEmpty, storeNamed } from '../seed.js';

/**
 * Integration level, through the real Worker and store: opening a Workspace
 * reads conversations only for the Items it brings ("A Gmail starred
 * conversation is one Item whose status follows who wrote last", issue 1705).
 * The bound is the query's and the plan is the store's, so neither exists below
 * a real store. Which Items the read brings is workspace-read-finished.test.ts's.
 *
 * **Against a fake pulled connector**, registered in place of the registry's
 * list as pulled-open-state.test.ts does, which brings each Item in following a
 * conversation and then closes all but one - far more than a real mailbox's
 * check would in one run, which is the point.
 */

const FAKE = 'fake-mail';
const FINISHED = 200;
const HOUR = 60 * 60 * 1000;

/** The real time, fixed, so the sign-in the requests carry is still good; moved on a day and more to leave the finished ones out. */
const NOW = Date.now(); // clock-ok: fixed once as the store's clock, since a sign-in is checked against it

const scripts: ((host: ConnectorHost) => Promise<void>)[] = [];
let runs = 0;

const connector: Connector = {
  manifest: { id: FAKE, displayName: 'Mail', cardText: 'Mail.', supportsPush: false, pulled: true, auth: { kind: 'none' } },
  async sync(host) {
    runs += 1;
    await scripts[runs - 1]?.(host);
  },
};

function aConversation(n: number): SourceItem {
  const at = new Date(NOW - 3 * HOUR).toISOString();
  return {
    sourceId: `thread-${n}`,
    sourceLink: null,
    sender: 'Steven Noels',
    sourceTimestamp: at,
    title: `Conversation ${n}`,
    capturedMessage: `About ${n}`,
    conversation: {
      id: `thread-${n}`,
      link: `https://mail.example.com/thread-${n}`,
      latest: { by: 'them', from: 'Steven Noels', at, excerpt: `About ${n}` },
      messageCount: 1,
      startedAt: at,
      withWhom: 'Steven Noels',
    },
  };
}

let held: EnrichmentJob[] = [];
let realQueue: typeof env.ENRICHMENT;

async function deliverEveryCheck(): Promise<void> {
  const checks = held.filter((job) => job.kind === 'check-a-pulled-connection');
  held = held.filter((job) => job.kind !== 'check-a-pulled-connection');
  for (const body of checks) {
    await handleQueue(
      {
        queue: 'cockpit-enrichment',
        messages: [{ id: crypto.randomUUID(), timestamp: new Date(NOW), body, attempts: 1, ack: () => {}, retry: () => {} }],
        ackAll: () => {},
        retryAll: () => {},
      } as unknown as Parameters<typeof handleQueue>[0],
      env,
    );
  }
}

async function connectedAndChecked(): Promise<void> {
  const sealed = await seal('a-credential', (await sealingKey(env.CONNECTOR_CREDENTIAL_KEY))!);
  const answer = await storeNamed(ACCOUNT_NAME).applyChange(ACCOUNT_NAME, 'connect_source_account', {
    commandId: crypto.randomUUID(),
    issuedAt: new Date(NOW).toISOString(),
    workspaceId: WORKSPACE_ID,
    sourceAccountId: crypto.randomUUID(),
    connectorId: FAKE,
    externalAccountKey: 'somebody',
    displayName: 'somebody',
    ...sealed,
  });
  expect(answer.status).toBe('ok');
  await runDurableObjectAlarm(storeNamed(ACCOUNT_NAME));
  await deliverEveryCheck();
}

async function opened(): Promise<WorkspaceSnapshot> {
  const response = await asUser(`http://cockpit.test/v1/workspaces/${WORKSPACE_ID}/snapshot`);
  expect(response.status).toBe(200);
  return (await response.json()) as WorkspaceSnapshot;
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'], now: NOW });
  await applyD1Migrations(env.DB, inject('migrations'));
  await startFromEmpty();
  await seedRegister();
  realQueue = env.ENRICHMENT;
  held = [];
  env.ENRICHMENT = {
    send: async (body: EnrichmentJob) => void held.push(body),
    sendBatch: async () => {
      throw new Error('nothing here sends a batch');
    },
  } as unknown as typeof env.ENRICHMENT;
  env.TEST_CONNECTORS = [connector];
  runs = 0;
  scripts.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
  env.ENRICHMENT = realQueue;
  delete env.TEST_CONNECTORS;
});

describe('Dashboards', () => {
  describe('opening a Workspace reads conversations only for the Items it brings', () => {
    it(`carries none of ${FINISHED} followed Items finished before the last day, and the open one’s`, async () => {
      scripts.push(async (host) => {
        for (let n = 0; n <= FINISHED; n += 1) await host.emitItem(aConversation(n));
      });
      scripts.push(async (host) => {
        const observedAt = new Date(NOW + 10 * 60_000).toISOString();
        for (let n = 1; n <= FINISHED; n += 1) await host.emitSourceStateChange({ sourceId: `thread-${n}`, change: 'resolved', observedAt });
      });
      await connectedAndChecked();
      // The next check, five minutes on: the alarm fired until it has run, since a
      // first run this long can end after the alarm it set has already been read.
      for (let tries = 1; runs < 2 && tries <= 5; tries += 1) {
        vi.setSystemTime(NOW + tries * 10 * 60_000);
        await runDurableObjectAlarm(storeNamed(ACCOUNT_NAME));
        await deliverEveryCheck();
      }
      expect(runs).toBe(2);
      expect(
        await inTheStore((sql) => sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM item_conversations').one().n),
      ).toBe(FINISHED + 1);

      vi.setSystemTime(NOW + 30 * HOUR);
      const read = await opened();

      expect((read.conversations ?? []).map((one) => one.conversationId)).toEqual(['thread-0']);
      // Filing and closing 200 Items through the host takes most of the default
      // 20 seconds alone, and more under the whole suite's load; the case is
      // about what the read carries, not how fast they are made.
    }, 60_000);

    it('joins the conversations by the Item, the leading column of their primary key', async () => {
      await inTheStore(() => undefined);
      const plan = await runInDurableObject(storeNamed(ACCOUNT_NAME), (_instance, state) => {
        const { sql, params } = conversationsInWorkspace(createAccountDb(state.storage), ACCOUNT_NAME, WORKSPACE_ID, {
          finishedAfter: finishedKeptAfter(new Date(NOW)),
        }).toSQL();
        return state.storage.sql
          .exec<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, ...params)
          .toArray()
          .map((row) => row.detail);
      });

      expect(plan).toContainEqual(expect.stringMatching(/item_conversations USING INDEX sqlite_autoindex_item_conversations_1 \(item_id=\?\)/));
    });
  });
});
