import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { ACCOUNT_NAME, USER_ID, asUser, inStoreAsItIs, signInAs } from '../seed.js';
import {
  NOTE,
  A_READING,
  aModelThatReads,
  asked,
  captureANote,
  textsOf,
  untilTheNoteHasBeenRead,
} from './note-cleanup.support.js';

/**
 * Integration level, through `SELF.fetch`: production taking a record sent to
 * it is a route, three secrets and an insert into the register's own D1, so it
 * only holds against the real Worker. Another environment sending one is the
 * real gateway behind a real capture, with production faked at the network
 * boundary - replacing `fetch`, as the model and the issuer are - since
 * production is the one horizontal dependency. The sender's timeout and its
 * single attempt are the unit tier's (tests/unit/gateway/send.test.ts).
 */

const RECORDS = 'http://cockpit.test/v1/usage-records';
const TOKENS = {
  staging: 'test-staging-usage-token',
  ci: 'test-ci-usage-token',
  local: 'test-local-usage-token',
} as const;
const PRODUCTION = 'https://production.test';

const SONNET = { model: 'claude-sonnet-5-5', tokensIn: 1200, cacheRead: 3400, cacheWrite: 560, tokensOut: 78 };

/** A settled attempt as another environment sends it. */
function aRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    operation: 'clean-up-a-note',
    promptVersion: 'clean-up-a-note.v17',
    triggeredBy: 'captured-in-app',
    accountName: 'tenant-elsewhere',
    itemId: 'item-elsewhere',
    provider: 'anthropic',
    paidBy: { kind: 'cockpit-anthropic-key', account: null, keyEnding: 'WXYZ' },
    outcome: 'ok',
    at: '2026-10-08T10:00:00.000Z',
    durationMs: 812,
    userId: 'user-elsewhere',
    branch: null,
    ...SONNET,
    ...overrides,
  };
}

function send(record: unknown, authorization: string | null): Promise<Response> {
  return SELF.fetch(RECORDS, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(authorization === null ? {} : { authorization }) },
    body: JSON.stringify(record),
  });
}

interface Row {
  environment: string;
  branch: string | null;
  user_id: string | null;
  account_name: string | null;
  cost_usd: number | null;
  operation: string;
  model: string;
  tokens_in: number | null;
  at: string;
}

async function rows(): Promise<Row[]> {
  return (
    await env.DB.prepare(
      'SELECT environment, branch, user_id, account_name, cost_usd, operation, model, tokens_in, at FROM provider_calls ORDER BY id',
    ).all<Row>()
  ).results;
}

/**
 * The note read and its history written, so a case ending here leaves no job
 * still writing to a store the next case empties.
 */
async function untilTheCleanUpHasSettled(itemId: string): Promise<void> {
  await untilTheNoteHasBeenRead(itemId);
  await vi.waitFor(
    async () => {
      const history = await inStoreAsItIs(ACCOUNT_NAME, (sql) =>
        sql.exec<{ status: string }>('SELECT status FROM rewrite_history WHERE item_id = ?', itemId).toArray(),
      );
      expect(history.map((row) => row.status)).not.toContain('pending');
      expect(history).not.toEqual([]);
    },
    { timeout: 15_000, interval: 50 },
  );
}

aModelThatReads();

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM provider_calls').run();
});

afterEach(() => {
  env.ENVIRONMENT = 'production';
  env.USAGE_RECORDING_TOKEN = '';
  env.USAGE_RECORDING_URL = '';
  env.ANTHROPIC_API_KEY = '';
  delete env.CHECKOUT_BRANCH;
});

describe('AI usage', () => {
  describe('production records a call sent to it only with a sending environment’s own token, under that environment', () => {
    it.each([
      { situation: 'staging’s token', token: TOKENS.staging, record: {}, recorded: { environment: 'staging', branch: null } },
      {
        situation: 'the local token, with the branch it carried',
        token: TOKENS.local,
        record: { branch: 'claude/1458-send-usage' },
        recorded: { environment: 'local', branch: 'claude/1458-send-usage' },
      },
      { situation: 'CI’s token', token: TOKENS.ci, record: {}, recorded: { environment: 'ci', branch: null } },
      { situation: 'a time on a leap day', token: TOKENS.staging, record: { at: '2024-02-29T12:00:00Z' }, recorded: { at: '2024-02-29T12:00:00Z' } },
      { situation: 'a time on the last second of a year, to the nanosecond', token: TOKENS.staging, record: { at: '2026-12-31T23:59:59.123456789Z' }, recorded: { at: '2026-12-31T23:59:59.123456789Z' } },
    ])('records a call sent with $situation', async ({ token, record, recorded }) => {
      const answered = await send(aRecord(record), `Bearer ${token}`);

      expect(answered.status).toBe(201);
      expect(await rows()).toMatchObject([recorded]);
    });

    it.each([
      { situation: 'no token', authorization: () => null, record: {}, status: 401 },
      { situation: 'a token of none of the three', authorization: () => 'Bearer not-one-of-them', record: {}, status: 401 },
      { situation: 'the backup token', authorization: () => 'Bearer test-operator-secret', record: {}, status: 401 },
      { situation: 'staging’s token claiming production', authorization: () => `Bearer ${TOKENS.staging}`, record: { environment: 'production' }, status: 403 },
      { situation: 'the local token claiming production', authorization: () => `Bearer ${TOKENS.local}`, record: { environment: 'production' }, status: 403 },
      { situation: 'CI’s token claiming production', authorization: () => `Bearer ${TOKENS.ci}`, record: { environment: 'production' }, status: 403 },
      { situation: 'staging’s token claiming to be local', authorization: () => `Bearer ${TOKENS.staging}`, record: { environment: 'local' }, status: 400 },
      { situation: 'a record missing its feature', authorization: () => `Bearer ${TOKENS.staging}`, record: { operation: undefined }, status: 400 },
      { situation: 'a record missing its model', authorization: () => `Bearer ${TOKENS.staging}`, record: { model: undefined }, status: 400 },
      { situation: 'a record missing its time', authorization: () => `Bearer ${TOKENS.staging}`, record: { at: undefined }, status: 400 },
      { situation: 'a record whose time is not one', authorization: () => `Bearer ${TOKENS.staging}`, record: { at: 'yesterday' }, status: 400 },
      { situation: 'a record whose time is a day that does not exist', authorization: () => `Bearer ${TOKENS.staging}`, record: { at: '2026-02-31T00:00:00Z' }, status: 400 },
      { situation: 'a record whose time is the end of a day written as the next one', authorization: () => `Bearer ${TOKENS.staging}`, record: { at: '2026-10-08T24:00:00Z' }, status: 400 },
    ])('refuses a call sent with $situation, and records nothing', async ({ authorization, record, status }) => {
      const answered = await send(aRecord(record), authorization());

      expect(answered.status).toBe(status);
      expect(await rows()).toEqual([]);
    });

    it('refuses a call sent by a signed-in person’s session, and records nothing', async () => {
      await signInAs();

      const answered = await asUser(
        RECORDS,
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(aRecord()) },
        USER_ID,
      );

      expect(answered.status).toBe(401);
      expect(await rows()).toEqual([]);
    });

    it('refuses a body that is not a record at all, and records nothing', async () => {
      const answered = await SELF.fetch(RECORDS, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKENS.staging}`, 'content-type': 'application/json' },
        body: 'not json',
      });

      expect(answered.status).toBe(400);
      expect(await rows()).toEqual([]);
    });

    it('refuses a token that was configured for no environment, as it refuses none', async () => {
      env.USAGE_TOKEN_CI = '';

      const answered = await send(aRecord(), 'Bearer ');

      expect(answered.status).toBe(401);
      env.USAGE_TOKEN_CI = TOKENS.ci;
    });
  });

  describe('a record sent to production is priced by production and keeps the user it was sent with', () => {
    it.each([
      { situation: 'a Sonnet record with its four counts', record: {}, cost: 0.00526 },
      { situation: 'a model production has no price for', record: { model: 'claude-future-9' }, cost: null },
      { situation: 'a failed attempt, which reported no counts', record: { outcome: 'error', status: 529, tokensIn: null, cacheRead: null, cacheWrite: null, tokensOut: null }, cost: null },
    ])('records $situation with cost $cost', async ({ record, cost }) => {
      await send(aRecord(record), `Bearer ${TOKENS.staging}`);

      expect(await rows()).toMatchObject([{ cost_usd: cost }]);
    });

    it.each([
      { situation: 'a user id production also has', userId: USER_ID },
      { situation: 'a user id production does not have', userId: 'user-nobody-here' },
      { situation: 'no user', userId: null },
    ])('keeps $situation as it was sent', async ({ userId }) => {
      await send(aRecord({ userId, accountName: ACCOUNT_NAME }), `Bearer ${TOKENS.local}`);

      expect(await rows()).toMatchObject([{ user_id: userId, account_name: ACCOUNT_NAME, environment: 'local' }]);
    });
  });

  describe('outside production, each call’s record goes to production and none stays behind', () => {
    interface Delivery {
      url: string;
      authorization: string | null;
      body: Record<string, unknown>;
    }
    const delivered: Delivery[] = [];
    /** What production does when a record reaches it. */
    let production: 'accepts' | 'answers with an error' | 'refuses the token' | 'never answers' = 'accepts';

    beforeEach(() => {
      delivered.length = 0;
      production = 'accepts';
      // The model is already on the network (`aModelThatReads`); production joins it.
      const model = globalThis.fetch;
      vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
        if (url.origin !== PRODUCTION) return model(input, init);
        delivered.push({
          url: url.href,
          authorization: new Headers(init?.headers).get('authorization'),
          body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        });
        if (production === 'answers with an error') return new Response('boom', { status: 500 });
        if (production === 'refuses the token') return Response.json({ error: 'not allowed' }, { status: 401 });
        if (production === 'never answers') {
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
          });
        }
        return new Response(null, { status: 201 });
      });
    });

    function recordedAs(environment: 'production' | 'staging' | undefined, token: string): void {
      env.ENVIRONMENT = environment;
      env.USAGE_RECORDING_TOKEN = token;
      env.USAGE_RECORDING_URL = PRODUCTION;
    }

    const cleanUps = () => delivered.filter((delivery) => delivery.body.operation === 'clean-up-a-note');

    it('sends a note cleaned up in staging with staging’s token and keeps nothing', async () => {
      recordedAs('staging', 'staging-sends-with-this');
      const itemId = await captureANote();
      await untilTheCleanUpHasSettled(itemId);

      expect(cleanUps()).toHaveLength(1);
      expect(cleanUps()[0]).toMatchObject({
        url: `${PRODUCTION}/v1/usage-records`,
        authorization: 'Bearer staging-sends-with-this',
        body: { accountName: ACCOUNT_NAME, userId: USER_ID, branch: null, itemId },
      });
      expect(await rows()).toEqual([]);
    });

    it('sends a note cleaned up in local development with the local token and the branch, and keeps nothing', async () => {
      recordedAs(undefined, 'local-sends-with-this');
      env.CHECKOUT_BRANCH = 'claude/1458-send-usage';
      const itemId = await captureANote();
      await untilTheCleanUpHasSettled(itemId);

      expect(cleanUps()).toHaveLength(1);
      expect(cleanUps()[0]).toMatchObject({
        authorization: 'Bearer local-sends-with-this',
        body: { userId: USER_ID, branch: 'claude/1458-send-usage' },
      });
      expect(await rows()).toEqual([]);
    });

    it('writes a note cleaned up in production to its own table and sends nothing', async () => {
      recordedAs('production', 'a-token-production-never-uses');
      const itemId = await captureANote();
      await untilTheCleanUpHasSettled(itemId);

      await vi.waitFor(async () => expect((await rows()).filter((row) => row.operation === 'clean-up-a-note')).toHaveLength(1));
      expect(await rows()).toMatchObject([{ environment: 'production', user_id: USER_ID, branch: null }]);
      expect(delivered).toEqual([]);
    });

    it.each([
      { situation: 'production answers with an error', production: 'answers with an error' as const },
      { situation: 'production refuses the token', production: 'refuses the token' as const },
      { situation: 'production does not answer within about two seconds', production: 'never answers' as const },
    ])('still cleans up a captured note when $situation', async (situation) => {
      const complained = vi.spyOn(console, 'error').mockImplementation(() => {});
      recordedAs('staging', 'staging-sends-with-this');
      production = situation.production;

      const itemId = await captureANote();
      await untilTheCleanUpHasSettled(itemId);

      expect((await textsOf(itemId))?.title).toBe(A_READING.title);
      expect(cleanUps()).toHaveLength(1);
      expect(complained.mock.calls.map((call) => String(call[0])).filter((line) => line.includes('not sent to production'))).toHaveLength(1);
      expect(complained.mock.calls.map((call) => String(call[0])).join('\n')).not.toContain('staging-sends-with-this');
      expect(await rows()).toEqual([]);
      complained.mockRestore();
    });
  });

  describe('outside production, a key with no recording token counts as no key', () => {
    async function theNoteWasLeftAsTyped(itemId: string): Promise<string> {
      let said = '';
      await vi.waitFor(
        async () => {
          const history = await inStoreAsItIs(ACCOUNT_NAME, (sql) =>
            sql
              .exec<{ status: string; message: string }>('SELECT status, message FROM rewrite_history WHERE item_id = ?', itemId)
              .toArray(),
          );
          expect(history.map((row) => row.status)).toEqual(['left-as-is']);
          said = history[0]!.message;
        },
        { timeout: 15_000, interval: 50 },
      );
      return said;
    }
    const healthSaysThereIsAKey = async () =>
      ((await (await SELF.fetch('http://cockpit.test/health')).json()) as { ai: boolean }).ai;

    it('leaves a note as typed, says there is no key, and calls nothing, in local development', async () => {
      env.ENVIRONMENT = undefined;
      env.USAGE_RECORDING_TOKEN = '';

      const itemId = await captureANote();
      const said = await theNoteWasLeftAsTyped(itemId);

      expect(said).toContain('USAGE_RECORDING_TOKEN');
      expect((await textsOf(itemId))?.title).toBe(NOTE);
      expect(asked).toEqual([]);
      expect(await healthSaysThereIsAKey()).toBe(false);
      expect(await rows()).toEqual([]);
    });

    it('counts a key in staging with no token as no key too', async () => {
      env.ENVIRONMENT = 'staging';
      env.USAGE_RECORDING_TOKEN = '';

      expect(await healthSaysThereIsAKey()).toBe(false);
    });

    it('cleans a note up and records it in production, which records itself', async () => {
      env.ENVIRONMENT = 'production';
      env.USAGE_RECORDING_TOKEN = '';

      const itemId = await captureANote();
      await untilTheCleanUpHasSettled(itemId);

      expect(await healthSaysThereIsAKey()).toBe(true);
      await vi.waitFor(async () => expect(await rows()).toMatchObject([{ environment: 'production', operation: 'clean-up-a-note' }]));
    });
  });
});
