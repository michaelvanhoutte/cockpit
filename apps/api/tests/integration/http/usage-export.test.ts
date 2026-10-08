import { beforeEach, describe, expect, inject, it } from 'vitest';
import { SELF, applyD1Migrations, env } from 'cloudflare:test';
import { USAGE_EXPORT_PAGE, usageExportPageSchema, type UsageExportPage } from '@cockpit/shared';
import { OTHER_USER_ID, USER_ID, asUser, seedRegister, signInAs, startFromEmpty } from '../seed.js';

/**
 * Integration level: the period and the paging are queries against the
 * register's real D1, and the name is a join that has to keep a row whose user
 * is gone. Everything enters through the operator's route, which is also where
 * the secret is asked for.
 */

const SECRET = 'test-operator-secret';
const DAY = 24 * 60 * 60 * 1000;

const daysAgo = (days: number) => new Date(Date.now() - days * DAY).toISOString();

/** Records written straight into the table, which nothing but a direct write can date. */
async function recordsMadeAt(at: string, count: number, userId: string | null, itemId = 'item'): Promise<void> {
  await env.DB.prepare(
    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
     INSERT INTO provider_calls (at, operation, item_id, user_id, provider, model, paid_by, outcome, duration_ms, tokens_in)
     SELECT ?, 'clean-up-a-note', ?, ?, 'anthropic', 'claude-opus-5', 'cockpit-anthropic-key', 'ok', 1, NULL FROM n`,
  )
    .bind(count, at, itemId, userId)
    .run();
}

function asOperator(query: string, secret: string | null = SECRET): Promise<Response> {
  return SELF.fetch(`http://cockpit.test/v1/operator/usage/records?${query}`, {
    headers: secret === null ? {} : { authorization: `Bearer ${secret}` },
  });
}

async function page(since: string, after = 0): Promise<UsageExportPage> {
  const res = await asOperator(`since=${encodeURIComponent(since)}&after=${after}`);
  expect(res.status).toBe(200);
  return usageExportPageSchema.parse(await res.json());
}

/** Every page of the period, the way the command reads them. */
async function everyRecord(since: string) {
  const read = [];
  let after = 0;
  for (;;) {
    const next = await page(since, after);
    read.push(...next.records);
    if (next.next === null) return read;
    after = next.next;
  }
}

beforeEach(async () => {
  await applyD1Migrations(env.DB, inject('migrations'));
  await startFromEmpty();
  await seedRegister();
});

describe('AI usage', () => {
  describe('the export holds every record in the period, exactly once', () => {
    it('holds only the records inside the last days asked for', async () => {
      await recordsMadeAt(daysAgo(10), 1, USER_ID, 'too-old');
      await recordsMadeAt(daysAgo(2), 1, USER_ID, 'inside');

      const read = await everyRecord(daysAgo(7));

      expect(read.map((record) => record.itemId)).toEqual(['inside']);
    });

    it('holds every record across pages, none twice', async () => {
      const total = USAGE_EXPORT_PAGE * 2 + 3;
      await recordsMadeAt(daysAgo(1), total, USER_ID);

      const first = await page(daysAgo(7));
      expect(first.records).toHaveLength(USAGE_EXPORT_PAGE);
      expect(first.next).not.toBeNull();

      const read = await everyRecord(daysAgo(7));
      expect(read).toHaveLength(total);
      expect(new Set(read.map((record) => record.id)).size).toBe(total);
    });

    it('holds exactly one page of records without a further page', async () => {
      await recordsMadeAt(daysAgo(1), USAGE_EXPORT_PAGE, USER_ID);

      const only = await page(daysAgo(7));

      expect(only.records).toHaveLength(USAGE_EXPORT_PAGE);
      expect(only.next).toBeNull();
    });

    it('holds nothing where there are no records in the period', async () => {
      await recordsMadeAt(daysAgo(30), 2, USER_ID);

      expect(await page(daysAgo(7))).toEqual({ records: [], next: null });
    });

    it.each([
      { situation: 'no start of the period', query: 'after=0' },
      { situation: 'a start that is not a time', query: 'since=lately' },
      { situation: 'a start that is only a number', query: 'since=20261001' },
      { situation: 'a page position that is not a number', query: `since=${daysAgo(1)}&after=next` },
      { situation: 'a negative page position', query: `since=${daysAgo(1)}&after=-1` },
    ])('refuses $situation', async ({ query }) => {
      expect((await asOperator(query)).status).toBe(400);
    });
  });

  describe('only that environment’s backup token can read the records', () => {
    beforeEach(async () => {
      await recordsMadeAt(daysAgo(1), 1, USER_ID);
    });

    it.each([
      { situation: 'no token', ask: () => asOperator(`since=${daysAgo(7)}`, null) },
      { situation: 'a wrong token', ask: () => asOperator(`since=${daysAgo(7)}`, 'not-the-secret') },
      {
        situation: 'a signed-in admin’s session without the token',
        ask: async () => {
          await signInAs();
          return asUser(`http://cockpit.test/v1/operator/usage/records?since=${daysAgo(7)}`, {}, USER_ID);
        },
      },
    ])('refuses $situation', async ({ ask }) => {
      const res = await ask();

      expect(res.status).toBe(401);
      expect(await res.text()).not.toContain('clean-up-a-note');
    });
  });

  describe('a deleted user’s records export with their id and an empty name', () => {
    it('names a user who is there, and keeps the id of one who is not', async () => {
      await recordsMadeAt(daysAgo(1), 1, USER_ID, 'mine');
      await recordsMadeAt(daysAgo(1), 1, OTHER_USER_ID, 'theirs');
      await signInAs();
      const removed = await asUser(`http://cockpit.test/v1/admin/users/${OTHER_USER_ID}`, { method: 'DELETE' });
      expect(removed.status).toBe(200);

      const read = await everyRecord(daysAgo(7));

      expect(read.map(({ itemId, userId, userName }) => ({ itemId, userId, userName }))).toEqual([
        { itemId: 'mine', userId: USER_ID, userName: 'Michael' },
        { itemId: 'theirs', userId: OTHER_USER_ID, userName: '' },
      ]);
    });

    it('exports a record that never had a user as an empty name too', async () => {
      await recordsMadeAt(daysAgo(1), 1, null);

      const [record] = await everyRecord(daysAgo(7));

      expect(record).toMatchObject({ userId: null, userName: '' });
    });
  });
});
