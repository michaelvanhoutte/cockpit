import { afterEach, beforeEach, describe, expect, inject, it } from 'vitest';
import { applyD1Migrations, env, runDurableObjectAlarm } from 'cloudflare:test';
import type { Connector, ConnectorHost, SyncAnswer } from '@cockpit/connector-sdk';
import type { EnrichmentJob } from '../../../src/jobs/enrichment.js';
import { handleQueue } from '../../../src/jobs/index.js';
import { seal, sealingKey } from '../../../src/connectors/credential-crypto.js';
import {
  ACCOUNT_NAME,
  WORKSPACE_ID,
  alsoWorkspaces,
  asUser,
  inTheStore,
  seedRegister,
  startFromEmpty,
  storeNamed,
} from '../seed.js';

/**
 * Integration level, through the account's real store, its real alarm, the
 * Worker's real queue consumer and the routes: every rule here is about what
 * pressing *Check now* does to a pulled connection's next check ("Check a
 * pulled connection now, from its row or its history", issue 1143). Against a
 * fake pulled connector, as connection-history.test.ts is.
 */

const FAKE = 'fake-pull';
const OTHER_WORKSPACE_ID = 'ws-atlas';

const fake = { scripts: [] as (() => Promise<void | SyncAnswer>)[], runs: 0 };

const fakePulled: Connector = {
  manifest: {
    id: FAKE,
    displayName: 'A pulled source',
    cardText: 'A source Cockpit pulls from.',
    supportsPush: false,
    pulled: true,
    auth: { kind: 'none' },
  },
  async sync(_host: ConnectorHost) {
    fake.runs += 1;
    return fake.scripts[Math.min(fake.runs, fake.scripts.length) - 1]?.();
  },
};

let held: EnrichmentJob[] = [];
let realQueue: typeof env.ENRICHMENT;

const queuedChecks = () => held.filter((job) => job.kind === 'check-a-pulled-connection');

function takeQueuedChecks(): EnrichmentJob[] {
  const checks = queuedChecks();
  held = held.filter((job) => job.kind !== 'check-a-pulled-connection');
  return checks;
}

async function deliver(body: EnrichmentJob): Promise<void> {
  await handleQueue(
    {
      queue: 'cockpit-enrichment',
      messages: [
        { id: crypto.randomUUID(), timestamp: new Date(), body, attempts: 1, ack: () => {}, retry: () => {} },
      ],
      ackAll: () => {},
      retryAll: () => {},
    } as unknown as Parameters<typeof handleQueue>[0],
    env,
  );
}

async function connect(externalAccountKey = 'somebody', connectorId = FAKE): Promise<string> {
  const key = await sealingKey(env.CONNECTOR_CREDENTIAL_KEY);
  const sourceAccountId = crypto.randomUUID();
  const answer = await storeNamed(ACCOUNT_NAME).applyChange(ACCOUNT_NAME, 'connect_source_account', {
    commandId: crypto.randomUUID(),
    issuedAt: new Date().toISOString(),
    workspaceId: WORKSPACE_ID,
    sourceAccountId,
    connectorId,
    externalAccountKey,
    displayName: `${externalAccountKey} at the source`,
    ...(await seal('a-credential', key!)),
  });
  expect(answer.status).toBe('ok');
  return sourceAccountId;
}

/** Waits until `count` checks sit queued, without delivering them. */
async function waitForQueued(count: number): Promise<void> {
  for (let waited = 0; waited < 10_000; waited += 25) {
    if (queuedChecks().length >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`fewer than ${count} checks were ever queued`);
}

async function queuedChecksRun(): Promise<void> {
  for (const check of takeQueuedChecks()) await deliver(check);
}

/** The connection's first check, run: it leaves the connection idle and its next check five minutes on. */
async function connectedAndChecked(): Promise<string> {
  const id = await connect();
  await waitForQueued(1);
  await queuedChecksRun();
  return id;
}

async function checkNow(id: string, workspaceId = WORKSPACE_ID) {
  const res = await asUser(`http://cockpit.test/v1/workspaces/${workspaceId}/connections/${id}/check-now`, {
    method: 'POST',
  });
  return { status: res.status, body: res.status === 200 ? ((await res.json()) as { status: string }) : null };
}

async function historyOf(id: string): Promise<{ reason: string; count: number; outcome: string }[]> {
  const res = await asUser(`http://cockpit.test/v1/workspaces/${WORKSPACE_ID}/connections/${id}/history`);
  return ((await res.json()) as { lines: { reason: string; count: number; outcome: string }[] }).lines;
}

const pulledRow = (id: string) =>
  inTheStore(
    (sql) =>
      [
        ...sql.exec<{ due_at: string; check_reason: string | null; queued_at: string | null }>(
          'SELECT due_at, check_reason, queued_at FROM pulled_connections WHERE source_account_id = ?',
          id,
        ),
      ][0]!,
  );

beforeEach(async () => {
  await applyD1Migrations(env.DB, inject('migrations'));
  await startFromEmpty();
  await seedRegister();
  await alsoWorkspaces();
  held = [];
  realQueue = env.ENRICHMENT;
  env.ENRICHMENT = {
    send: async (body: EnrichmentJob) => {
      held.push(body);
    },
  } as unknown as typeof env.ENRICHMENT;
  fake.runs = 0;
  fake.scripts = [async () => {}];
  env.TEST_CONNECTORS = [fakePulled];
});

afterEach(() => {
  env.ENRICHMENT = realQueue;
  delete env.TEST_CONNECTORS;
});

describe('Connector management', () => {
  describe('Check now queues one check of a pulled connection at once, labelled Check now', () => {
    it('an idle connection is made due now and its line says Check now, beside the quiet line before it', async () => {
      const id = await connectedAndChecked();
      expect(Date.parse((await pulledRow(id)).due_at)).toBeGreaterThan(Date.now() + 3 * 60_000);

      expect(await checkNow(id)).toEqual({ status: 200, body: { status: 'queued' } });
      // Due now, and the alarm armed for it: a check is queued without the test firing anything.
      await waitForQueued(1);
      expect((await pulledRow(id)).check_reason).toBe('check-now');
      await queuedChecksRun();

      expect(await historyOf(id)).toEqual([
        expect.objectContaining({ reason: 'check-now', count: 1 }),
        expect.objectContaining({ reason: 'scheduled', count: 1 }),
      ]);
    });

    it('a connection with a check queued queues nothing more, and that check takes the label', async () => {
      const id = await connect();
      await waitForQueued(1);

      expect(await checkNow(id)).toEqual({ status: 200, body: { status: 'already queued' } });
      expect(queuedChecks()).toHaveLength(1);
      await queuedChecksRun();

      expect(await historyOf(id)).toEqual([expect.objectContaining({ reason: 'check-now', count: 1 })]);
    });

    it('a connection whose check is running queues nothing, and that check keeps its own label', async () => {
      let pressed: Awaited<ReturnType<typeof checkNow>> | undefined;
      const id = await connect();
      fake.scripts = [
        async () => {
          pressed = await checkNow(id);
        },
      ];
      await waitForQueued(1);
      await queuedChecksRun();

      expect(pressed).toEqual({ status: 200, body: { status: 'running' } });
      expect(await historyOf(id)).toEqual([expect.objectContaining({ reason: 'scheduled' })]);
      expect(queuedChecks()).toHaveLength(0);
      expect((await pulledRow(id)).check_reason).toBeNull();
    });

    it.each([
      { situation: 'of another Workspace', askedIn: OTHER_WORKSPACE_ID, connector: FAKE, disconnected: false },
      { situation: 'disconnected', askedIn: WORKSPACE_ID, connector: FAKE, disconnected: true },
      { situation: 'one the source is not pulled from', askedIn: WORKSPACE_ID, connector: 'teams', disconnected: false },
    ])('a connection $situation is refused as not found', async ({ askedIn, connector, disconnected }) => {
      const id = await connect('somebody', connector);
      if (disconnected) {
        const res = await asUser('http://cockpit.test/v1/commands/disconnect_source_account', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            commandId: crypto.randomUUID(),
            issuedAt: new Date().toISOString(),
            workspaceId: WORKSPACE_ID,
            sourceAccountId: id,
          }),
        });
        expect(res.status).toBe(200);
      }

      expect((await checkNow(id, askedIn)).status).toBe(404);
    });
  });

  describe('two presses of Check now at once make one check', () => {
    it('queues a single check and writes a single line', async () => {
      const id = await connectedAndChecked();

      const answers = await Promise.all([checkNow(id), checkNow(id)]);
      await waitForQueued(1);
      await queuedChecksRun();

      expect(answers.every((answer) => answer.status === 200)).toBe(true);
      expect(fake.runs).toBe(2);
      expect((await historyOf(id)).filter((line) => line.reason === 'check-now')).toHaveLength(1);
    });
  });

  describe('a Check now queued before the store was reopened still labels its check', () => {
    it('keeps the label in the connection row itself, which the run reads when it ends', async () => {
      const id = await connectedAndChecked();
      await checkNow(id);

      expect((await pulledRow(id)).check_reason).toBe('check-now');
      // The alarm firing starts the run: nothing in memory carries the label.
      await runDurableObjectAlarm(storeNamed(ACCOUNT_NAME));
      await waitForQueued(1);
      await queuedChecksRun();
      expect((await historyOf(id))[0]).toMatchObject({ reason: 'check-now' });
    });
  });

  describe('a check ending tells open tabs the connection history changed', () => {
    it('names the connection that was checked and no other', async () => {
      const id = await connectedAndChecked();
      await connect('somebody-else');
      await waitForQueued(1);
      // The other connection's first check stays queued, so it writes no line.
      held = [];
      const since = new Date().toISOString();
      await new Promise((resolve) => setTimeout(resolve, 5));
      await checkNow(id);
      await waitForQueued(1);
      await queuedChecksRun();

      const answer = await storeNamed(ACCOUNT_NAME).changesSince(ACCOUNT_NAME, since);
      if (answer.status !== 'ok') throw new Error('the store did not answer');

      expect(answer.value.events.filter((event) => event.type === 'connection_history_changed')).toEqual([
        { type: 'connection_history_changed', workspaceId: WORKSPACE_ID, sourceAccountId: id },
      ]);
    });
  });
});
