import { afterEach, beforeEach, describe, expect, inject, it } from 'vitest';
import { SELF, applyD1Migrations, env } from 'cloudflare:test';
import {
  CLAUDE_CALLS_FEED_PAGE,
  claudeCallsPageSchema,
  type ClaudeCallsPage,
} from '@cockpit/shared/claude-calls-feed';
import { USER_ID, seedRegister, startFromEmpty } from '../seed.js';

/**
 * Integration level, through `SELF.fetch`: what the Harness Monitor reads is a
 * query over the register's real D1 behind a token, so the columns, the paging
 * and the refusals only hold against the real Worker.
 */

const FEED = 'http://cockpit.test/v1/usage-records';
const READ_TOKEN = 'test-usage-read-token';
const BACKUP_TOKEN = 'test-operator-secret';
const RECORDING_TOKEN = 'test-staging-usage-token';

interface Call {
  at?: string;
  environment?: string;
  operation?: string;
  paidBy?: string;
  model?: string;
  userId?: string | null;
  itemId?: string | null;
  costUsd?: number | null;
  pullRequest?: number | null;
  runId?: number | null;
  branch?: string | null;
}

/** One row written straight into the register, the way each environment's call lands there. */
async function aCallWasRecorded(call: Call = {}, copies = 1): Promise<void> {
  await env.DB.prepare(
    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
     INSERT INTO provider_calls
       (at, operation, prompt_version, triggered_by, account_name, user_id, item_id, provider, model,
        paid_by, paid_by_account, paid_by_key_ending, outcome, duration_ms,
        tokens_in, cache_read, cache_write, tokens_out, environment, cost_usd, pull_request, run_id, branch)
     SELECT ?, ?, 'clean-up-a-note.v17', 'captured-in-app', 'tenant-default', ?, ?, 'anthropic', ?,
            ?, 'wrkspc_secret', 'WXYZ', 'ok', 812,
            1200, 3400, 560, 78, ?, ?, ?, ?, ? FROM n`,
  )
    .bind(
      copies,
      call.at ?? '2026-10-08T10:00:00.000Z',
      call.operation ?? 'clean-up-a-note',
      call.userId === undefined ? USER_ID : call.userId,
      call.itemId === undefined ? 'item-secret' : call.itemId,
      call.model ?? 'claude-sonnet-5-5',
      call.paidBy ?? 'cockpit-anthropic-key',
      call.environment ?? 'production',
      call.costUsd === undefined ? 0.00526 : call.costUsd,
      call.pullRequest ?? null,
      call.runId ?? null,
      call.branch ?? null,
    )
    .run();
}

function read(query = '', token: string | null = READ_TOKEN): Promise<Response> {
  return SELF.fetch(`${FEED}${query}`, {
    headers: token === null ? {} : { authorization: `Bearer ${token}` },
  });
}

async function page(after = 0): Promise<ClaudeCallsPage> {
  const res = await read(`?after=${after}`);
  expect(res.status).toBe(200);
  return claudeCallsPageSchema.parse(await res.json());
}

beforeEach(async () => {
  await applyD1Migrations(env.DB, inject('migrations'));
  await startFromEmpty();
  await seedRegister();
});

describe('AI usage', () => {
  describe('a call reaches the Monitor carrying the page’s columns and nothing that names a person, an item or a key', () => {
    it('gives a production call every column of the page and no user, account, item, workspace or key field', async () => {
      await aCallWasRecorded();

      const res = await read();
      const text = await res.text();
      const { calls } = claudeCallsPageSchema.parse(JSON.parse(text));

      expect(calls).toHaveLength(1);
      expect(Object.keys(calls[0]!).sort()).toEqual(
        [
          'at', 'branch', 'cacheRead', 'cacheWrite', 'costUsd', 'environment', 'feature', 'id', 'model',
          'outcome', 'promptVersion', 'pullRequest', 'runId', 'startedBy', 'tokensIn', 'tokensOut',
        ].sort(),
      );
      expect(calls[0]).toMatchObject({
        at: '2026-10-08T10:00:00.000Z',
        environment: 'production',
        feature: 'clean-up-a-note',
        promptVersion: 'clean-up-a-note.v17',
        startedBy: 'captured-in-app',
        model: 'claude-sonnet-5-5',
        outcome: 'ok',
        tokensIn: 1200,
        cacheRead: 3400,
        cacheWrite: 560,
        tokensOut: 78,
        costUsd: 0.00526,
      });
      for (const secret of [USER_ID, 'item-secret', 'tenant-default', 'wrkspc_secret', 'WXYZ']) {
        expect(text).not.toContain(secret);
      }
    });

    it.each([
      {
        situation: 'a CI call with its pull request and run',
        call: { environment: 'ci', pullRequest: 1481, runId: 99001 },
        expected: { environment: 'ci', pullRequest: 1481, runId: 99001, branch: null },
      },
      {
        situation: 'a local call with its branch',
        call: { environment: 'local', branch: 'claude/1481-monitor-read-route' },
        expected: { environment: 'local', pullRequest: null, branch: 'claude/1481-monitor-read-route' },
      },
      {
        situation: 'a call with no price',
        call: { costUsd: null },
        expected: { costUsd: null },
      },
    ])('gives $situation its own place and price', async ({ call, expected }) => {
      await aCallWasRecorded(call);

      const [read] = (await page()).calls;

      expect(read).toMatchObject(expected);
    });
  });

  describe('only calls paid by Cockpit’s Anthropic key are read', () => {
    it.each([
      { situation: 'a Workers AI call', paidBy: 'cloudflare-workers-ai' },
      { situation: 'a Claude Code routine call', paidBy: 'claude-plan' },
    ])('leaves out $situation, between two Claude calls', async ({ paidBy }) => {
      await aCallWasRecorded({ itemId: 'before' });
      await aCallWasRecorded({ paidBy });
      await aCallWasRecorded({ itemId: 'after' });

      const { calls } = await page();

      expect(calls).toHaveLength(2);
      expect(calls.map((call) => call.id)).toEqual([1, 3]);
    });
  });

  describe('rows come oldest first after the number asked for, a page at a time, and none is skipped', () => {
    it('is empty, with nothing more, where there are no rows', async () => {
      expect(await page()).toEqual({ calls: [], more: false });
    });

    it('holds only the rows numbered after the one asked for, oldest first', async () => {
      await aCallWasRecorded({}, 4);

      const { calls, more } = await page(2);

      expect(calls.map((call) => call.id)).toEqual([3, 4]);
      expect(more).toBe(false);
    });

    it('holds a full page saying there is more, then the last row and no more', async () => {
      await aCallWasRecorded({}, CLAUDE_CALLS_FEED_PAGE + 1);

      const first = await page();
      expect(first.calls).toHaveLength(CLAUDE_CALLS_FEED_PAGE);
      expect(first.more).toBe(true);

      const second = await page(first.calls.at(-1)!.id);
      expect(second.calls.map((call) => call.id)).toEqual([CLAUDE_CALLS_FEED_PAGE + 1]);
      expect(second.more).toBe(false);
    });

    it('holds exactly one page of rows without saying there is more', async () => {
      await aCallWasRecorded({}, CLAUDE_CALLS_FEED_PAGE);

      const only = await page();

      expect(only.calls).toHaveLength(CLAUDE_CALLS_FEED_PAGE);
      expect(only.more).toBe(false);
    });

    it('puts a row written after a page was read on the next page, though it happened earlier', async () => {
      await aCallWasRecorded({ itemId: 'first' }, 2);
      const read = await page();
      // Staging’s call, sent late: it is dated before both rows already read.
      const late = await SELF.fetch('http://cockpit.test/v1/usage-records', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${RECORDING_TOKEN}` },
        body: JSON.stringify({
          operation: 'clean-up-a-note',
          promptVersion: null,
          triggeredBy: null,
          accountName: 'tenant-elsewhere',
          itemId: null,
          provider: 'anthropic',
          model: 'claude-sonnet-5-5',
          paidBy: { kind: 'cockpit-anthropic-key', account: null, keyEnding: 'WXYZ' },
          outcome: 'ok',
          status: null,
          tokensIn: 10,
          cacheRead: 0,
          cacheWrite: 0,
          tokensOut: 5,
          at: '2026-09-01T00:00:00.000Z',
          durationMs: 100,
          userId: null,
          branch: null,
        }),
      });
      expect(late.status).toBe(201);

      const next = await page(read.calls.at(-1)!.id);

      expect(next.calls).toHaveLength(1);
      expect(next.calls[0]).toMatchObject({ environment: 'staging', at: '2026-09-01T00:00:00.000Z' });
    });
  });

  describe('only the read token reads this route, and it reads nothing else', () => {
    afterEach(() => {
      env.USAGE_READ_TOKEN = READ_TOKEN;
    });

    beforeEach(async () => {
      await aCallWasRecorded();
    });

    it.each([
      { situation: 'no token', token: null },
      { situation: 'a wrong token', token: 'not-the-token' },
      { situation: 'the backup token', token: BACKUP_TOKEN },
      { situation: 'a recording token', token: RECORDING_TOKEN },
    ])('refuses $situation', async ({ token }) => {
      const res = await read('', token);

      expect(res.status).toBe(401);
      expect(await res.text()).not.toContain('clean-up-a-note');
    });

    it.each([
      { situation: 'the usage export', path: '/v1/operator/usage/records?since=2026-01-01T00:00:00Z' },
      { situation: 'the register backup', path: '/v1/operator/backup/register' },
      { situation: 'an account’s backup', path: '/v1/operator/backup/accounts/tenant-default' },
    ])('refuses the read token on $situation', async ({ path }) => {
      const res = await SELF.fetch(`http://cockpit.test${path}`, {
        headers: { authorization: `Bearer ${READ_TOKEN}` },
      });

      expect(res.status).toBe(401);
    });

    it('refuses the read token as a recording token', async () => {
      const res = await SELF.fetch(FEED, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${READ_TOKEN}` },
        body: '{}',
      });

      expect(res.status).toBe(401);
    });

    it.each([
      { situation: 'the read token', token: READ_TOKEN },
      { situation: 'the backup token', token: BACKUP_TOKEN },
      { situation: 'no token', token: null },
    ])('refuses $situation, saying reading is not set up, where the token is not set', async ({ token }) => {
      delete env.USAGE_READ_TOKEN;

      const res = await read('', token);

      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'reading is not set up here' });
    });
  });

  describe('a malformed request is refused, not guessed at', () => {
    it.each([
      { situation: 'a row number that is not a number', after: 'next' },
      { situation: 'a row number with a fraction', after: '1.5' },
      { situation: 'a negative row number', after: '-1' },
      { situation: 'an empty row number', after: '' },
    ])('refuses $situation', async ({ after }) => {
      expect((await read(`?after=${after}`)).status).toBe(400);
    });
  });
});
