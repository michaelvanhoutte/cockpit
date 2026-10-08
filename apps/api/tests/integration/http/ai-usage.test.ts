import { afterEach, beforeEach, describe, expect, inject, it, vi } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import type { CommandName, CommandPayload } from '@cockpit/shared';
import {
  ACCOUNT_NAME,
  DASHBOARD_ID,
  OTHER_ACCOUNT_NAME,
  OTHER_USER_ID,
  TASK_TYPE_ID,
  USER_ID,
  WORKSPACE_ID,
  asUser,
  inStoreAsItIs,
  seedRegister,
  signInAs,
  startFromEmpty,
  taskTypeIn,
} from '../seed.js';
import { handleQueue, handleScheduled } from '../../../src/jobs/index.js';
import type { EnrichmentJob } from '../../../src/jobs/enrichment.js';
import { PURGE_BATCH } from '../../../src/gateway/record.js';

/**
 * Integration level: each record is a row of the register's own D1, written
 * by the queue job a capture or a filing sets off, so it only holds against
 * the real database and the real consumer. The capture and the filing arrive
 * through the real Worker; the model is faked at the network boundary, as in
 * `note-cleanup.test.ts`. That a record which cannot be written never costs
 * the call is the gateway's own decision, proved at
 * tests/unit/gateway/attempts.test.ts.
 *
 * Where a case needs to hold a delivery - the queue's own redelivery after a
 * failure - it hands the message to `handleQueue`, the entry point the
 * runtime calls.
 */

const KEY = 'sk-ant-api03-a-key-that-proves-nothing-WXYZ';
const NOTE = 'part 11 audit trail q for validation protocol, who signs off eod';
const A_READING = {
  language: 'English',
  title: 'Part 11 audit trail question for the validation protocol',
  message: 'A question about the Part 11 audit trail, for the validation protocol.',
  readings: [] as unknown[],
};
const SPENT = { input_tokens: 1200, cache_read_input_tokens: 3400, cache_creation_input_tokens: 560, output_tokens: 78 };

/** What the model does on one attempt: answer, answer overloaded, or never answer in time. */
type Attempt = 'answers' | 'is overloaded' | 'times out';

/** What the model does next, attempt by attempt; once the script runs out it answers. */
let script: Attempt[] = [];
let calls = 0;

function theModelIsOnTheNetwork(): void {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname !== 'api.anthropic.com') throw new Error(`the suite tried to reach ${url.origin}`);
    calls += 1;
    const sent = JSON.parse(input instanceof Request ? await input.clone().text() : String(init?.body ?? '{}')) as {
      model: string;
      output_config: { format: { schema: { properties: Record<string, unknown> } } };
    };
    const attempt = script.shift() ?? 'answers';
    if (attempt === 'times out') {
      // What the SDK's own timer does to the request once its minute is up.
      throw new DOMException('The operation was aborted.', 'AbortError');
    }
    if (attempt === 'is overloaded') {
      return Response.json(
        { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } },
        { status: 529, headers: { 'x-should-retry': 'true' } },
      );
    }
    const panelOnly = 'panelId' in sent.output_config.format.schema.properties;
    return Response.json({
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: sent.model,
      content: [{ type: 'text', text: JSON.stringify(panelOnly ? { panelId: '', reason: '' } : A_READING) }],
      stop_reason: 'end_turn',
      usage: SPENT,
    });
  });
}

interface Row {
  at: string;
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
  duration_ms: number;
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

let seq = 0;
function nextId(): string {
  seq += 1;
  return `018f0000-0000-7000-8917-${String(seq).padStart(12, '0')}`;
}

async function postChange<N extends CommandName>(name: N, payload: CommandPayload<N>, userId?: string) {
  const response = await asUser(
    `http://cockpit.test/v1/commands/${name}`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) },
    userId,
  );
  expect(response.status).toBe(200);
}

async function captureANote(userId: string = USER_ID, typeId: string = TASK_TYPE_ID): Promise<string> {
  const itemId = nextId();
  await postChange(
    'capture_item',
    { commandId: nextId(), issuedAt: '2026-10-08T10:00:00.000Z', workspaceId: WORKSPACE_ID, itemId, message: NOTE, typeId },
    userId,
  );
  return itemId;
}

/**
 * An unfiled note written straight into the store, with no capture behind it,
 * so no clean-up is ever asked about it and whatever is recorded is the
 * refresh's alone.
 */
async function anUnfiledNote(note: string): Promise<string> {
  const itemId = nextId();
  await inStoreAsItIs(ACCOUNT_NAME, (sql) =>
    sql.exec(
      `INSERT INTO items
         (id, tenant_id, workspace_id, source, captured_message, title, description, status, unseen, created_at, updated_at)
       VALUES (?, ?, ?, 'internal', ?, ?, NULL, 'to_process', 0, ?, ?)`,
      itemId,
      ACCOUNT_NAME,
      WORKSPACE_ID,
      note,
      note,
      `2026-10-08T10:00:0${seq % 10}.000Z`,
      `2026-10-08T10:00:0${seq % 10}.000Z`,
    ),
  );
  return itemId;
}

/** One message, delivered as the runtime delivers it, with whether it was handed back to be tried again. */
function delivered(job: EnrichmentJob) {
  const message = { id: 'message-1', timestamp: new Date(), body: job as unknown, attempts: 1, ack: vi.fn(), retry: vi.fn() };
  const batch = { queue: 'cockpit-enrichment', messages: [message], ackAll: () => {}, retryAll: () => {} };
  return { batch: batch as unknown as Parameters<typeof handleQueue>[0], message };
}

/**
 * A note captured with no key configured, so nothing is queued for it and the
 * one clean-up a case then delivers by hand is the only call made about it.
 */
async function aNoteNobodyHasAskedAbout(): Promise<string> {
  env.ANTHROPIC_API_KEY = '';
  const itemId = await captureANote();
  // The capture's own clean-up settles without asking, under waitUntil.
  await vi.waitFor(
    async () => {
      const rows = await inStoreAsItIs(ACCOUNT_NAME, (sql) =>
        sql.exec<{ status: string }>('SELECT status FROM rewrite_history WHERE item_id = ?', itemId).toArray(),
      );
      expect(rows.map((row) => row.status)).toEqual(['left-as-is']);
    },
    { timeout: 15_000, interval: 50 },
  );
  env.ANTHROPIC_API_KEY = KEY;
  return itemId;
}

beforeEach(async () => {
  await applyD1Migrations(env.DB, inject('migrations'));
  await startFromEmpty();
  await seedRegister();
  script = [];
  calls = 0;
  env.ANTHROPIC_API_KEY = KEY;
  // Signed in first: signing in puts an issuer on the network, which the model below replaces.
  await signInAs();
  await signInAs(OTHER_USER_ID);
  theModelIsOnTheNetwork();
});

afterEach(() => {
  env.ANTHROPIC_API_KEY = '';
  delete env.ANTHROPIC_WORKSPACE_ID;
  vi.unstubAllGlobals();
});

describe('AI usage', () => {
  describe('every Claude call made for a note leaves one record of what asked, for whom, with which model and what it spent', () => {
    it('records a note captured in the app being cleaned up', async () => {
      env.ANTHROPIC_WORKSPACE_ID = 'wrkspc_01TestWorkspace';
      const itemId = await captureANote();

      const [record] = await untilThereAre(1);

      expect(record).toMatchObject({
        operation: 'clean-up-a-note',
        prompt_version: 'clean-up-a-note.v11',
        triggered_by: 'captured-in-app',
        account_name: ACCOUNT_NAME,
        user_id: USER_ID,
        item_id: itemId,
        provider: 'anthropic',
        model: 'claude-sonnet-5-5',
        paid_by: 'cockpit-anthropic-key',
        paid_by_account: 'wrkspc_01TestWorkspace',
        paid_by_key_ending: 'WXYZ',
        outcome: 'ok',
        status: null,
        tokens_in: 1200,
        cache_read: 3400,
        cache_write: 560,
        tokens_out: 78,
      });
      expect(Date.parse(record!.at)).not.toBeNaN();
      expect(record!.duration_ms).toBeGreaterThanOrEqual(0);
    });

    it('records each of three unfiled notes a settled filing asks about again, on the cheaper model', async () => {
      const panelId = nextId();
      await postChange('add_panel', {
        commandId: nextId(),
        issuedAt: '2026-10-08T10:00:00.000Z',
        workspaceId: WORKSPACE_ID,
        dashboardId: DASHBOARD_ID,
        panelId,
        name: 'Compliance questions',
        kind: 'items',
      });
      const waiting = [await anUnfiledNote('ring the auditor'), await anUnfiledNote('book the CAPA room'), await anUnfiledNote('sign the SOP')];
      const settling = await anUnfiledNote('the validation protocol');

      await postChange('move_item_to_panel', {
        commandId: nextId(),
        issuedAt: '2026-10-08T10:00:01.000Z',
        workspaceId: WORKSPACE_ID,
        itemId: settling,
        panelId,
        order: [settling],
      });

      const found = await untilThereAre(3);
      expect(found.map((record) => record.item_id).sort()).toEqual([...waiting].sort());
      for (const record of found) {
        expect(record).toMatchObject({
          operation: 'choose-a-panel',
          prompt_version: 'choose-a-panel.v2',
          triggered_by: 'panel-settled',
          user_id: USER_ID,
          model: 'claude-haiku-4-5',
          outcome: 'ok',
          tokens_out: 78,
        });
      }
    });

    it('records nothing, and calls nothing, where no key is configured', async () => {
      await aNoteNobodyHasAskedAbout();

      expect(calls).toBe(0);
      expect(await records()).toEqual([]);
    });
  });

  describe('every attempt is its own record, failed ones included, and a call is retried as often as before', () => {
    it.each([
      {
        situation: 'the model is overloaded, then answers',
        script: ['is overloaded'] as Attempt[],
        expected: [
          { outcome: 'error', status: 529, tokens_in: null },
          { outcome: 'ok', status: null, tokens_in: 1200 },
        ],
      },
      {
        situation: 'the model does not answer in time, then answers',
        script: ['times out'] as Attempt[],
        expected: [
          { outcome: 'timed-out', status: null, tokens_in: null },
          { outcome: 'ok', status: null, tokens_in: 1200 },
        ],
      },
    ])('records two attempts when $situation', async ({ script: attempts, expected }) => {
      const itemId = await aNoteNobodyHasAskedAbout();
      script = [...attempts];
      const { batch, message } = delivered({
        kind: 'clean-up-a-note',
        accountName: ACCOUNT_NAME,
        itemId,
        attemptId: nextId(),
        triggeredBy: 'captured-in-app',
      });

      await handleQueue(batch, env);

      expect(message.ack).toHaveBeenCalled();
      expect(calls).toBe(2);
      expect(await records()).toMatchObject(expected.map((row) => ({ ...row, item_id: itemId })));
    });

    it('records both failed attempts, and the redelivery’s own, when the model fails twice', async () => {
      const itemId = await aNoteNobodyHasAskedAbout();
      script = ['is overloaded', 'is overloaded'];
      const job: EnrichmentJob = {
        kind: 'clean-up-a-note',
        accountName: ACCOUNT_NAME,
        itemId,
        attemptId: nextId(),
        triggeredBy: 'captured-in-app',
      };

      const first = delivered(job);
      await handleQueue(first.batch, env);
      expect(first.message.retry).toHaveBeenCalled();
      expect((await records()).map((row) => row.outcome)).toEqual(['error', 'error']);

      const redelivery = delivered(job);
      await handleQueue(redelivery.batch, env);
      expect(redelivery.message.ack).toHaveBeenCalled();
      expect(calls).toBe(3);
      expect((await records()).map((row) => row.outcome)).toEqual(['error', 'error', 'ok']);
    });
  });

  describe('a record never holds the note, the answer, or the key', () => {
    it('keeps nothing of them but the key’s last 4 characters', async () => {
      await captureANote();

      const [record] = await untilThereAre(1);

      const kept = Object.values(record!).map(String).join('\n');
      expect(kept).not.toContain(NOTE);
      expect(kept).not.toContain(A_READING.title);
      expect(kept).not.toContain(A_READING.message);
      expect(kept).not.toContain(KEY.slice(0, -4));
      expect(kept).toContain('WXYZ');
    });
  });

  describe('the nightly run removes records older than 12 months and nothing younger', () => {
    const runTheNight = () => handleScheduled({} as never, env);
    const monthsAgo = (months: number, extraDays: number) => {
      const when = new Date();
      when.setUTCMonth(when.getUTCMonth() - months);
      when.setUTCDate(when.getUTCDate() - extraDays);
      return when.toISOString();
    };
    /** Records made long ago, which nothing but a direct write can date. */
    async function recordsMadeAt(at: string, count: number, itemId: string): Promise<void> {
      await env.DB.prepare(
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
         INSERT INTO provider_calls (at, operation, item_id, provider, model, paid_by, outcome, duration_ms)
         SELECT ?, 'clean-up-a-note', ?, 'anthropic', 'claude-opus-5', 'cockpit-anthropic-key', 'ok', 1 FROM n`,
      )
        .bind(count, at, itemId)
        .run();
    }
    const left = async () => (await records()).map((row) => row.item_id);

    it.each([
      { situation: 'one record a day past 12 months, beside one a day short', expired: 1 },
      { situation: 'more expired records than one batch removes', expired: PURGE_BATCH * 2 + 1 },
    ])('removes the expired and keeps the rest, however often it runs, with $situation', async ({ expired }) => {
      await recordsMadeAt(monthsAgo(12, 1), expired, 'expired');
      await recordsMadeAt(monthsAgo(12, -1), 1, 'kept');

      await runTheNight();
      expect(await left()).toEqual(['kept']);

      await runTheNight();
      expect(await left()).toEqual(['kept']);
    });
  });

  describe('a user’s records stay when the user is deleted', () => {
    it('keeps what they spent, naming them by id alone', async () => {
      const theirs = await captureANote(OTHER_USER_ID, taskTypeIn(OTHER_ACCOUNT_NAME));
      await untilThereAre(1);

      const removed = await asUser(`http://cockpit.test/v1/admin/users/${OTHER_USER_ID}`, { method: 'DELETE' });
      expect(removed.status).toBe(200);

      expect(await records()).toMatchObject([{ user_id: OTHER_USER_ID, account_name: OTHER_ACCOUNT_NAME, item_id: theirs }]);
    });
  });
});
