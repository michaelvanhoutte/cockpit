import { afterEach, beforeEach, describe, expect, inject, it, vi } from 'vitest';
import { SELF, applyD1Migrations, env } from 'cloudflare:test';
import { ACCOUNT_WIDE, AGENT_COLORS } from '@cockpit/shared';
import type { CommandName, CommandPayload } from '@cockpit/shared';
import {
  ACCOUNT_NAME,
  DASHBOARD_ID,
  OTHER_USER_ID,
  TASK_TYPE_ID,
  USER_ID,
  WORKSPACE_ID,
  asUser,
  inStoreAsItIs,
  seedRegister,
  signInAs,
  startFromEmpty,
} from '../seed.js';
import { handleQueue } from '../../../src/jobs/index.js';
import type { EnrichmentJob } from '../../../src/jobs/enrichment.js';

/**
 * Integration level: each record is a row of the register's own D1, written
 * from a route or a queue job, so it only holds against the real database and
 * the real Worker ("Record every paid provider call through one gateway, and
 * export the records as CSV", issue 902). Workers AI is faked at its binding
 * and the Claude Code routine at the network, as the files that prove the work
 * around them do (duplicate-notes.test.ts, agent-runs.test.ts). Claude's own
 * calls are ai-usage.test.ts's; that a record which cannot be written never
 * costs the call is the gateway's decision, proved at
 * tests/unit/gateway/attempts.test.ts.
 */

const NOTE = 'part 11 audit trail question for novy';
const ROUTINE_URL = 'https://api.anthropic.com/v1/claude_code/routines/rt-workspace-1/fire';
const SESSION_URL = 'https://claude.ai/code/session_01EXAMPLE';
const OPERATOR = { authorization: 'Bearer test-operator-secret' };

let seq = 0;
const nextId = () => {
  seq += 1;
  return `018f0000-0000-7000-8000-${String(seq).padStart(12, '0')}`;
};

interface Row {
  operation: string;
  prompt_version: string | null;
  triggered_by: string | null;
  account_name: string | null;
  user_id: string | null;
  item_id: string | null;
  provider: string;
  model: string;
  paid_by: string;
  paid_by_account: string | null;
  paid_by_key_ending: string | null;
  outcome: string;
  status: number | null;
  tokens_in: number | null;
  cache_read: number | null;
  cache_write: number | null;
  tokens_out: number | null;
}

async function records(): Promise<Row[]> {
  return (await env.DB.prepare('SELECT * FROM provider_calls ORDER BY id').all<Row>()).results;
}

async function untilThereAre(count: number): Promise<Row[]> {
  await vi.waitFor(async () => expect(await records()).toHaveLength(count), { timeout: 15_000, interval: 50 });
  return records();
}

async function postChange<N extends CommandName>(name: N, payload: Omit<CommandPayload<N>, 'commandId' | 'issuedAt'>) {
  const response = await asUser(`http://cockpit.test/v1/commands/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ commandId: nextId(), issuedAt: '2026-10-08T10:00:00.000Z', ...payload }),
  });
  expect(response.status, await response.clone().text()).toBe(200);
}

async function captureANote(): Promise<string> {
  const itemId = nextId();
  await postChange('capture_item', { workspaceId: WORKSPACE_ID, itemId, message: NOTE, typeId: TASK_TYPE_ID });
  return itemId;
}

describe('AI usage', () => {
  beforeEach(async () => {
    await applyD1Migrations(env.DB, inject('migrations'));
    await startFromEmpty();
    await seedRegister();
    env.ANTHROPIC_API_KEY = '';
    env.EMBEDDINGS_STAND_IN = '';
    // Signed in first: signing in puts an issuer on the network, which a case replaces.
    await signInAs();
    await signInAs(OTHER_USER_ID);
  });

  afterEach(() => {
    Reflect.deleteProperty(env as unknown as Record<string, unknown>, 'AI');
    env.EMBEDDINGS_STAND_IN = '';
    vi.unstubAllGlobals();
  });

  describe('every Workers AI reading leaves one record per call, with no token counts', () => {
    let readings: 'work' | 'fail';
    let asked: number;

    function workersAiCanRead(): void {
      readings = 'work';
      asked = 0;
      (env as unknown as { AI: unknown }).AI = {
        run: async (_model: string, input: { text: string[] }) => {
          asked += 1;
          if (readings === 'fail') throw new Error('the reader could not be reached');
          return { data: input.text.map(() => [1, 0]) };
        },
      };
    }

    function aReadingJob(itemId: string): EnrichmentJob {
      return { kind: 'read-what-a-note-means', accountName: ACCOUNT_NAME, itemId, triggeredBy: 'captured-in-app' };
    }

    function delivered(job: EnrichmentJob) {
      const message = { id: 'message-1', timestamp: new Date(), body: job as unknown, attempts: 1, ack: vi.fn(), retry: vi.fn() };
      const batch = { queue: 'cockpit-enrichment', messages: [message], ackAll: () => {}, retryAll: () => {} };
      return { batch: batch as unknown as Parameters<typeof handleQueue>[0], message };
    }

    it('records a captured note being read, for its owner, paid by Workers AI', async () => {
      workersAiCanRead();
      const itemId = await captureANote();

      const [record, ...rest] = await untilThereAre(1);

      expect(rest).toEqual([]);
      expect(record).toEqual({
        ...record,
        operation: 'read-what-a-note-means',
        prompt_version: null,
        triggered_by: 'captured-in-app',
        account_name: ACCOUNT_NAME,
        user_id: USER_ID,
        item_id: itemId,
        provider: 'cloudflare',
        model: '@cf/baai/bge-m3',
        paid_by: 'cloudflare-workers-ai',
        paid_by_account: null,
        paid_by_key_ending: null,
        outcome: 'ok',
        status: null,
        tokens_in: null,
        cache_read: null,
        cache_write: null,
        tokens_out: null,
      });
    });

    it('records the operator backfill reading a batch as one call, triggered by the backfill, naming no item', async () => {
      await captureANote();
      workersAiCanRead();

      const response = await SELF.fetch(
        `http://cockpit.test/v1/operator/duplicates/accounts/${encodeURIComponent(ACCOUNT_NAME)}`,
        { method: 'POST', headers: OPERATOR },
      );
      expect(response.status, await response.clone().text()).toBe(200);

      const found = await records();
      expect(asked).toBe(1);
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({
        operation: 'read-what-a-note-means',
        triggered_by: 'backfill',
        user_id: USER_ID,
        item_id: null,
        paid_by: 'cloudflare-workers-ai',
        outcome: 'ok',
        tokens_in: null,
        tokens_out: null,
      });
    });

    it('records a reading that fails as an error, and the queue’s redelivery of it as another', async () => {
      const itemId = await captureANote();
      workersAiCanRead();
      readings = 'fail';

      const { batch, message } = delivered(aReadingJob(itemId));
      await handleQueue(batch, env);
      const again = delivered(aReadingJob(itemId));
      await handleQueue(again.batch, env);

      expect(message.retry).toHaveBeenCalled();
      expect(await records()).toMatchObject([
        { outcome: 'error', status: null, item_id: itemId, paid_by: 'cloudflare-workers-ai', tokens_in: null },
        { outcome: 'error', status: null, item_id: itemId },
      ]);
    });
  });

  describe('every Claude Code routine call leaves a record paid by the person’s own plan, naming the routine', () => {
    const claude = { answer: { status: 200 } as { status: number } | 'times out', fired: 0 };

    function claudeOnTheNetwork(): void {
      vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (!url.startsWith('https://api.anthropic.com/')) throw new Error(`nothing in a test may reach ${url}`);
        claude.fired += 1;
        if (claude.answer === 'times out') throw new DOMException('The operation timed out.', 'TimeoutError');
        return new Response(JSON.stringify({ claude_code_session_url: SESSION_URL }), {
          status: claude.answer.status,
          headers: { 'content-type': 'application/json' },
        });
      });
    }

    function connect() {
      return asUser(`http://cockpit.test/v1/workspaces/${WORKSPACE_ID}/connections/claude-code/connect`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ routineUrl: ROUTINE_URL, token: 'a-routine-token' }),
      });
    }

    beforeEach(() => {
      claude.answer = { status: 200 };
      claude.fired = 0;
      claudeOnTheNetwork();
    });

    it('records a connection being tested, with no item', async () => {
      expect(await (await connect()).json()).toEqual({ accepted: true });

      expect(await records()).toMatchObject([
        {
          operation: 'test-a-connection',
          prompt_version: null,
          triggered_by: 'connection-test',
          account_name: ACCOUNT_NAME,
          user_id: USER_ID,
          item_id: null,
          provider: 'anthropic',
          model: 'claude-code-routine',
          paid_by: 'claude-plan',
          paid_by_account: 'rt-workspace-1',
          paid_by_key_ending: null,
          outcome: 'ok',
          status: null,
          tokens_in: null,
          cache_read: null,
          cache_write: null,
          tokens_out: null,
        },
      ]);
    });

    it('records the routine’s refusal with its status, and a call that never answered as timed out', async () => {
      claude.answer = { status: 401 };
      expect((await (await connect()).json()) as { accepted: boolean }).toMatchObject({ accepted: false });
      claude.answer = 'times out';
      expect((await (await connect()).json()) as { accepted: boolean }).toMatchObject({ accepted: false });

      expect(await records()).toMatchObject([
        { operation: 'test-a-connection', outcome: 'error', status: 401, paid_by: 'claude-plan' },
        { operation: 'test-a-connection', outcome: 'timed-out', status: null, paid_by: 'claude-plan' },
      ]);
    });

    it('records an agent being started on an item, naming the item', async () => {
      expect(await (await connect()).json()).toEqual({ accepted: true });
      const agentId = nextId();
      await postChange('create_agent', {
        workspaceId: ACCOUNT_WIDE,
        agentId,
        name: 'Scope it',
        color: AGENT_COLORS[0]!,
        engine: 'claude-code',
        message: '/scoping {title} - {link}',
        asksForPrompt: false,
        startsInProgress: true,
      });
      const panelId = nextId();
      await postChange('add_panel', { workspaceId: WORKSPACE_ID, dashboardId: DASHBOARD_ID, panelId, name: 'Now', kind: 'items' });
      const itemId = nextId();
      await postChange('capture_item', { workspaceId: WORKSPACE_ID, itemId, message: 'Chase the invoice', typeId: TASK_TYPE_ID });
      await postChange('move_item_to_panel', { workspaceId: WORKSPACE_ID, itemId, panelId, order: [itemId] });

      const started = await asUser(`http://cockpit.test/v1/workspaces/${WORKSPACE_ID}/items/${itemId}/agent-runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          commandId: nextId(),
          issuedAt: '2026-10-08T10:00:00.000Z',
          runId: nextId(),
          agentId,
          dashboardId: DASHBOARD_ID,
        }),
      });
      expect(await started.json()).toEqual({ alreadyStarted: false, status: 'working' });

      expect((await records()).slice(1)).toMatchObject([
        {
          operation: 'start-an-agent',
          triggered_by: 'agent-started',
          user_id: USER_ID,
          item_id: itemId,
          paid_by: 'claude-plan',
          paid_by_account: 'rt-workspace-1',
          outcome: 'ok',
          tokens_in: null,
        },
      ]);
    });
  });

  describe('a stand-in is not a paid call and records nothing', () => {
    it('records nothing for a note read by the stand-in embeddings', async () => {
      env.EMBEDDINGS_STAND_IN = 'true';
      const itemId = await captureANote();

      await vi.waitFor(
        async () => {
          const read = await inStoreAsItIs(ACCOUNT_NAME, (sql) =>
            sql.exec<{ item_id: string }>('SELECT item_id FROM item_meanings WHERE item_id = ?', itemId).toArray(),
          );
          expect(read).toHaveLength(1);
        },
        { timeout: 15_000, interval: 50 },
      );

      expect(await records()).toEqual([]);
    });

    it('records nothing for a routine fired at a stand-in origin', async () => {
      const origin = 'http://stand-in.localhost:9999';
      env.CLAUDE_CODE_ROUTINES_ORIGIN = origin;
      vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (!url.startsWith(origin)) throw new Error(`nothing in a test may reach ${url}`);
        return new Response(JSON.stringify({ claude_code_session_url: SESSION_URL }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      });
      try {
        const connected = await asUser(`http://cockpit.test/v1/workspaces/${WORKSPACE_ID}/connections/claude-code/connect`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ routineUrl: `${origin}/v1/claude_code/routines/rt-workspace-1/fire`, token: 'a-routine-token' }),
        });
        expect(await connected.json()).toEqual({ accepted: true });
        expect(await records()).toEqual([]);
      } finally {
        delete env.CLAUDE_CODE_ROUTINES_ORIGIN;
      }
    });
  });
});
