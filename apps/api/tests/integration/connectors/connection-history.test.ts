import { afterEach, beforeEach, describe, expect, inject, it } from 'vitest';
import { applyD1Migrations, env, runDurableObjectAlarm } from 'cloudflare:test';
import { SourceError, type Connector, type ConnectorHost, type SyncAnswer } from '@cockpit/connector-sdk';
import type { EnrichmentJob } from '../../../src/jobs/enrichment.js';
import { handleQueue } from '../../../src/jobs/index.js';
import { HISTORY_MOST_LINES } from '../../../src/domain/connection-history.js';
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
 * Worker's real queue consumer and the history's real route: every rule here
 * is about what a check's end writes to its connection's history, in the
 * transaction that ends it, and who may read it back ("See when a pulled
 * connection was checked, and why it failed, from its row's History…", issue
 * 1140).
 *
 * **Against a fake pulled connector**, as pulled-checks.test.ts is, so each
 * case scripts how its checks end. Which line a check's end extends or
 * inserts is tests/unit/domain/connection-history.test.ts's; here only that
 * the stored line is extended rather than a second inserted. A store from
 * before the history, brought up to date, is accounts/aged-store.test.ts's.
 */

const FAKE = 'fake-pull';
const OTHER_WORKSPACE_ID = 'ws-atlas';

/** What the runs do, one script per run in order; the last repeats. */
const fake = {
  scripts: [] as (() => Promise<void | SyncAnswer>)[],
  runs: 0,
};

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

function runsIn(...scripts: (() => Promise<void | SyncAnswer>)[]): void {
  fake.scripts = scripts;
}

const fails = (message: string) => async () => {
  throw new Error(message);
};

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
      messages: [
        { id: crypto.randomUUID(), timestamp: new Date(), body, attempts: 1, ack: () => {}, retry: () => {} },
      ],
      ackAll: () => {},
      retryAll: () => {},
    } as unknown as Parameters<typeof handleQueue>[0],
    env,
  );
}

/** Connects an account at the fake source to a Workspace, as the connect route's own change does. */
async function connect(externalAccountKey = 'somebody', workspaceId = WORKSPACE_ID): Promise<string> {
  const key = await sealingKey(env.CONNECTOR_CREDENTIAL_KEY);
  const sourceAccountId = crypto.randomUUID();
  const answer = await storeNamed(ACCOUNT_NAME).applyChange(ACCOUNT_NAME, 'connect_source_account', {
    commandId: crypto.randomUUID(),
    issuedAt: new Date().toISOString(),
    workspaceId,
    sourceAccountId,
    connectorId: FAKE,
    externalAccountKey,
    displayName: `${externalAccountKey} at the source`,
    ...(await seal('a-credential', key!)),
  });
  expect(answer.status).toBe('ok');
  return sourceAccountId;
}

/** Waits for the check connecting queued at once, and delivers it. */
async function firstCheckRuns(count = 1): Promise<void> {
  for (let waited = 0; waited < 10_000; waited += 25) {
    if (held.filter((job) => job.kind === 'check-a-pulled-connection').length >= count) {
      for (const check of takeQueuedChecks()) await deliver(check);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`fewer than ${count} checks were ever queued`);
}

/** The next check of every pulled connection: the alarm fires, and each check it queued is delivered. */
async function nextChecksRun(): Promise<void> {
  await runDurableObjectAlarm(storeNamed(ACCOUNT_NAME));
  for (const check of takeQueuedChecks()) await deliver(check);
}

interface Line {
  outcome: string;
  reason: string;
  message: string | null;
  messageCut: boolean;
  status: number | null;
  count: number;
  firstAt: string;
  lastAt: string;
}

async function historyOf(sourceAccountId: string, workspaceId = WORKSPACE_ID): Promise<{ status: number; lines: Line[] }> {
  const res = await asUser(`http://cockpit.test/v1/workspaces/${workspaceId}/connections/${sourceAccountId}/history`);
  return { status: res.status, lines: res.status === 200 ? ((await res.json()) as { lines: Line[] }).lines : [] };
}

async function rowOf(sourceAccountId: string) {
  const res = await asUser(`http://cockpit.test/v1/workspaces/${WORKSPACE_ID}/connections`);
  const rows = ((await res.json()) as { sourceAccounts: { id: string; lastTestedAt: string | null; failingBecause: string | null; keepsHistory?: boolean }[] })
    .sourceAccounts;
  return rows.find((row) => row.id === sourceAccountId)!;
}

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
  runsIn(async () => {});
  env.TEST_CONNECTORS = [fakePulled];
});

afterEach(() => {
  env.ENRICHMENT = realQueue;
  delete env.TEST_CONNECTORS;
});

describe('Connector management', () => {
  describe('every check of a pulled connection that ends writes its line of the history with its end', () => {
    it('a check that worked writes a Worked line, and the row says when it was last checked', async () => {
      const id = await connect();
      const before = Date.now();
      await firstCheckRuns();

      const { lines } = await historyOf(id);
      expect(lines).toEqual([
        expect.objectContaining({ outcome: 'worked', reason: 'scheduled', message: null, count: 1 }),
      ]);
      const row = await rowOf(id);
      expect(Date.parse(row.lastTestedAt!)).toBeGreaterThanOrEqual(before);
      // Which is what offers History… on its row.
      expect(row.keepsHistory).toBe(true);
    });

    it('a check that failed writes a Failed line with its message, and the row says it is failing', async () => {
      runsIn(fails('the source stopped answering'));
      const id = await connect();
      await firstCheckRuns();

      expect((await historyOf(id)).lines).toEqual([
        expect.objectContaining({ outcome: 'failed', message: 'the source stopped answering', messageCut: false }),
      ]);
      expect((await rowOf(id)).failingBecause).toBe('the source stopped answering');
    });

    it.each([
      {
        situation: 'the status error a connector throws',
        thrown: () => new SourceError('Graph answered 503 to /messages', 503),
        line: { status: 503, message: 'Graph answered 503 to /messages' },
      },
      {
        situation: 'a plain error',
        thrown: () => new Error('the source stopped answering'),
        line: { status: null, message: 'the source stopped answering' },
      },
      {
        situation: 'something that is not an error',
        thrown: () => 'a bare string',
        line: { status: null, message: 'a bare string' },
      },
    ])('a failure thrown as $situation records the status where it carried one', async ({ thrown, line }) => {
      runsIn(async () => {
        throw thrown();
      });
      const id = await connect();
      await firstCheckRuns();

      expect((await historyOf(id)).lines).toEqual([expect.objectContaining({ outcome: 'failed', ...line })]);
    });

    it('failures with one message fold only while the status is the same', async () => {
      const unavailable = (status: number) => async () => {
        throw new SourceError('unavailable', status);
      };
      runsIn(unavailable(503), unavailable(503), unavailable(500));
      const id = await connect();
      await firstCheckRuns();
      await nextChecksRun();
      await nextChecksRun();

      expect((await historyOf(id)).lines.map(({ status, count }) => ({ status, count }))).toEqual([
        { status: 500, count: 1 },
        { status: 503, count: 2 },
      ]);
    });

    it('a check whose connection another run took writes no line and ends nothing', async () => {
      const marker = new Date(Date.now() + 3 * 3_600_000).toISOString();
      runsIn(async () => {
        await inTheStore((sql) => sql.exec('UPDATE pulled_connections SET run_id = ?, due_at = ?', 'another-run', marker));
      });
      const id = await connect();
      const connected = (await rowOf(id)).lastTestedAt;
      await firstCheckRuns();

      expect((await historyOf(id)).lines).toEqual([]);
      expect((await rowOf(id)).lastTestedAt).toBe(connected);
    });

    it('the check after one that said there was more to do says it was a follow-up', async () => {
      runsIn(async () => ({ moreToDo: true }), fails('the source stopped answering'));
      const id = await connect();
      await firstCheckRuns();
      await nextChecksRun();

      expect((await historyOf(id)).lines.map(({ outcome, reason }) => ({ outcome, reason }))).toEqual([
        { outcome: 'failed', reason: 'follow-up' },
        { outcome: 'worked', reason: 'scheduled' },
      ]);
    });

    it('a check whose end fails partway stores neither its end nor its line', async () => {
      const id = await connect();
      const connected = (await rowOf(id)).lastTestedAt;
      await inTheStore((sql) =>
        sql.exec(
          "CREATE TRIGGER refuse_a_line BEFORE INSERT ON connection_history BEGIN SELECT RAISE(ABORT, 'arranged to fail'); END",
        ),
      );
      await firstCheckRuns();
      await inTheStore((sql) => sql.exec('DROP TRIGGER refuse_a_line'));

      expect((await historyOf(id)).lines).toEqual([]);
      expect((await rowOf(id)).lastTestedAt).toBe(connected);
      const lease = await inTheStore((sql) =>
        [...sql.exec<{ run_id: string | null }>('SELECT run_id FROM pulled_connections WHERE source_account_id = ?', id)][0],
      );
      expect(lease?.run_id).not.toBeNull();
    });
  });

  describe('consecutive alike checks are stored as one line', () => {
    it('a check that worked after a quiet line extends it rather than adding a second', async () => {
      const id = await connect();
      await firstCheckRuns();
      const [first] = (await historyOf(id)).lines;
      await nextChecksRun();

      const { lines } = await historyOf(id);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({ outcome: 'worked', count: 2, firstAt: first!.firstAt });
      expect(Date.parse(lines[0]!.lastAt)).toBeGreaterThan(Date.parse(first!.lastAt));
    });
  });

  describe('a connection’s history is read only for a connection of the reader’s Workspace', () => {
    it('answers only the asked connection’s lines, newest first', async () => {
      runsIn(async () => {}, fails('the source stopped answering'));
      const asked = await connect('somebody');
      await firstCheckRuns();
      const other = await connect('somebody-else');
      await firstCheckRuns();
      await nextChecksRun();

      const { lines } = await historyOf(asked);
      expect(lines.map((line) => line.outcome)).toEqual(['failed', 'worked']);
      expect(Date.parse(lines[0]!.lastAt)).toBeGreaterThanOrEqual(Date.parse(lines[1]!.lastAt));
      expect((await historyOf(other)).lines.map((line) => line.outcome)).toEqual(['failed']);
    });

    it('answers an empty history for a connection never checked', async () => {
      const id = await connect();

      expect(await historyOf(id)).toEqual({ status: 200, lines: [] });
    });

    it.each([
      { situation: 'a connection of another Workspace', askedIn: OTHER_WORKSPACE_ID, disconnected: false },
      { situation: 'a disconnected connection', askedIn: WORKSPACE_ID, disconnected: true },
    ])('refuses $situation as not found', async ({ askedIn, disconnected }) => {
      const id = await connect();
      await firstCheckRuns();
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

      expect((await historyOf(id, askedIn)).status).toBe(404);
    });
  });

  describe('a connection’s history read carries its newest lines, up to a fixed most, and says where older ones remain', () => {
    it.each([
      { situation: 'one line more than the read carries', lines: HISTORY_MOST_LINES + 1, olderRemain: true },
      { situation: 'exactly as many lines as the read carries', lines: HISTORY_MOST_LINES, olderRemain: false },
    ])('answers the newest lines of $situation', async ({ lines: held, olderRemain }) => {
      const id = await connect();
      // A minute apart, each its own.
      await inTheStore((sql) =>
        sql.exec(
          `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
           INSERT INTO connection_history (id, tenant_id, source_account_id, outcome, reason, message, message_cut, count, first_at, last_at)
           SELECT 'line-' || i, ?, ?, 'failed', 'scheduled', 'failure ' || i, 0, 1,
                  strftime('%Y-%m-%dT%H:%M:%fZ', '2026-10-01T00:00:00.000Z', '+' || i || ' minutes'),
                  strftime('%Y-%m-%dT%H:%M:%fZ', '2026-10-01T00:00:00.000Z', '+' || i || ' minutes')
           FROM n`,
          held - 1,
          ACCOUNT_NAME,
          id,
        ),
      );

      const res = await asUser(`http://cockpit.test/v1/workspaces/${WORKSPACE_ID}/connections/${id}/history`);
      const read = (await res.json()) as { lines: Line[]; olderRemain: boolean };

      expect(read.lines).toHaveLength(HISTORY_MOST_LINES);
      expect(read.lines[0]!.message).toBe(`failure ${held - 1}`);
      expect(read.lines.at(-1)!.message).toBe(`failure ${held - HISTORY_MOST_LINES}`);
      expect(read.olderRemain).toBe(olderRemain);
    });
  });
});
