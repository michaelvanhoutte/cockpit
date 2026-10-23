import { beforeAll, describe, expect, inject, it } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';

/**
 * Integration level, and its own file: what it arranges is a usage record in
 * the state a deployed one is in - rows written before there was an
 * environment or a cost to give them - and applying an update can only happen
 * once. Only the real migration against real D1 shows what such a row becomes;
 * every other file starts from an empty table with every migration applied.
 */

/**
 * Everything before the migration that adds the environment and the cost, and
 * then that one and anything after it - split by where a migration sorts, for
 * the reason google-account-migration.test.ts gives.
 */
const FIRST_WITH_AN_ENVIRONMENT = '0017';

const AS_STORED = {
  at: '2026-10-08T10:00:00.000Z',
  operation: 'clean-up-a-note',
  prompt_version: 'clean-up-a-note.v17',
  triggered_by: 'captured-in-app',
  account_name: 'tenant-default',
  user_id: 'user-michael',
  item_id: 'item-1',
  provider: 'anthropic',
  model: 'claude-sonnet-5-5',
  paid_by: 'cockpit-anthropic-key',
  paid_by_account: 'wrkspc_01',
  paid_by_key_ending: 'WXYZ',
  outcome: 'ok',
  status: null,
  duration_ms: 4210,
  tokens_in: 1200,
  cache_read: 3400,
  cache_write: 560,
  tokens_out: 78,
};

let afterTheUpdate: Record<string, unknown>[];

beforeAll(async () => {
  await applyD1Migrations(
    env.DB,
    inject('migrations').filter((m) => m.name < FIRST_WITH_AN_ENVIRONMENT),
  );
  const columns = Object.keys(AS_STORED);
  await env.DB.prepare(
    `INSERT INTO provider_calls (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
  )
    .bind(...Object.values(AS_STORED))
    .run();

  await applyD1Migrations(
    env.DB,
    inject('migrations').filter((m) => m.name >= FIRST_WITH_AN_ENVIRONMENT),
  );
  afterTheUpdate = (await env.DB.prepare('SELECT * FROM provider_calls').all<Record<string, unknown>>()).results;
});

describe('AI usage', () => {
  describe('a record written before it had an environment reads as production with no cost, and is otherwise unchanged', () => {
    it('keeps a stored record as it was, as production’s, with no cost, pull request, run or branch', () => {
      expect(afterTheUpdate).toEqual([
        {
          id: 1,
          ...AS_STORED,
          environment: 'production',
          cost_usd: null,
          pull_request: null,
          run_id: null,
          branch: null,
        },
      ]);
    });
  });
});
