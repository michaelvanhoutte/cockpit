import { afterEach, beforeEach, describe, expect, inject, it } from 'vitest';
import { SELF, applyD1Migrations, env } from 'cloudflare:test';
import { SourceError, type Connector, type PushHost } from '@cockpit/connector-sdk';
import type { ConnectionHistoryLine } from '@cockpit/shared';
import { DELIVERY_FAILED, handlePush } from '../../../src/connectors/push-host.js';
import {
  USER_ID,
  WORKSPACE_ID,
  alsoWorkspaces,
  asUser,
  inTheStore,
  seedRegister,
  signInAs,
  startFromEmpty,
} from '../seed.js';
import { issuerIsForgotten, issuerIsReachable, issuerWillIdentify } from '../issuer.js';
import {
  TEAMS_PERSON,
  TEAMS_TENANT,
  botFrameworkIsReachable,
  channelToken,
  saveToCockpitCall,
} from '../bot-framework.js';

/**
 * Integration level, through the real Worker, register and account store: the
 * line a Teams delivery writes to its connection's history, in the same
 * transaction as the capture that makes its Item, and the *Failed* line of one
 * that fails once it is attributed ("See what each Teams save became, in its
 * connection's history", issue 1144). What Teams' connector does with a call
 * is its own L1 suite's; which line a delivery folds into is
 * tests/unit/domain/connection-history.test.ts's.
 */

/** Connecting a Teams account to a Workspace, the whole walk a browser makes. */
async function connectTeams(): Promise<string> {
  await issuerIsReachable();
  const session = await signInAs(USER_ID);
  const started = await SELF.fetch(
    `http://cockpit.test/v1/workspaces/${WORKSPACE_ID}/connections/teams/connect`,
    { redirect: 'manual', headers: { cookie: session } },
  );
  const asked = new URL(started.headers.get('location')!);
  const attempt = started.headers
    .getSetCookie()
    .map((cookie) => cookie.split(';')[0]!)
    .find((cookie) => cookie.startsWith('cockpit_connect='))!;
  issuerWillIdentify({
    email: 'ada@example.com',
    name: 'Ada Lovelace',
    nonce: asked.searchParams.get('nonce')!,
    tenant: TEAMS_TENANT,
    object: TEAMS_PERSON,
  });
  await SELF.fetch(
    `http://cockpit.test/v1/connections/teams/callback?${new URLSearchParams({
      code: 'a-code',
      state: asked.searchParams.get('state')!,
    })}`,
    { redirect: 'manual', headers: { cookie: `${session}; ${attempt}` } },
  );
  await botFrameworkIsReachable();
  const connections = await asUser(`http://cockpit.test/v1/workspaces/${WORKSPACE_ID}/connections`);
  const [connected] = ((await connections.json()) as { sourceAccounts: { id: string }[] }).sourceAccounts;
  return connected!.id;
}

async function saveFromTeams(press: Parameters<typeof saveToCockpitCall>[0] = {}): Promise<Response> {
  return SELF.fetch('http://cockpit.test/ingress/teams/messages', {
    method: 'POST',
    headers: { authorization: `Bearer ${await channelToken()}`, 'content-type': 'application/json' },
    body: JSON.stringify(saveToCockpitCall(press)),
  });
}

async function historyOf(sourceAccountId: string): Promise<ConnectionHistoryLine[]> {
  const res = await asUser(
    `http://cockpit.test/v1/workspaces/${WORKSPACE_ID}/connections/${sourceAccountId}/history`,
  );
  expect(res.status).toBe(200);
  return ((await res.json()) as { lines: ConnectionHistoryLine[] }).lines;
}

const countIn = (table: string) =>
  inTheStore((sql) => sql.exec(`SELECT COUNT(*) AS n FROM ${table}`).one().n as number);

/** The Items a delivery made - the account arrives with a guide of its own besides. */
const teamsItems = () =>
  inTheStore((sql) => sql.exec("SELECT COUNT(*) AS n FROM items WHERE source_id IS NOT NULL").one().n as number);

beforeEach(async () => {
  await applyD1Migrations(env.DB, inject('migrations'));
  await startFromEmpty();
  await seedRegister();
  await alsoWorkspaces();
});

afterEach(() => {
  issuerIsForgotten();
});

describe('Connector management', () => {
  describe('a delivery attributed to a connection writes one line naming the Item it became, with its capture', () => {
    it('writes one line naming the new Item for a new save', async () => {
      const connection = await connectTeams();

      expect((await saveFromTeams()).status).toBe(200);

      const [line, ...others] = await historyOf(connection);
      expect(others).toEqual([]);
      expect(line).toMatchObject({ outcome: 'worked', reason: 'delivery', count: 1, status: null, message: null });
      expect(line!.did.broughtIn.count).toBe(1);
      expect(line!.did.broughtIn.items).toEqual([
        { id: expect.any(String), title: 'Can you review the Q3 plan before Friday?', dismissed: false },
      ]);
    });

    it('writes one Item and one line for the same click delivered twice', async () => {
      const connection = await connectTeams();

      await saveFromTeams();
      await saveFromTeams();

      expect(await historyOf(connection)).toHaveLength(1);
      expect(await teamsItems()).toBe(1);
    });

    it('writes two lines, unfolded, for two saves in a row', async () => {
      const connection = await connectTeams();

      await saveFromTeams();
      await saveFromTeams({ activityId: 'f:7194316379999999999' });

      const lines = await historyOf(connection);
      expect(lines.map((line) => [line.count, line.did.broughtIn.count])).toEqual([
        [1, 1],
        [1, 1],
      ]);
    });

    it('writes neither the Item nor a saved line for a capture that fails, and a Failed line instead', async () => {
      const connection = await connectTeams();
      await inTheStore((sql) =>
        sql.exec(
          "CREATE TRIGGER nothing_may_be_filed BEFORE INSERT ON items BEGIN SELECT RAISE(ABORT, 'refused'); END",
        ),
      );

      const answer = await saveFromTeams();

      // Left to fail, which is what makes Teams deliver the click again.
      expect(answer.status).toBe(500);
      expect(await teamsItems()).toBe(0);
      const [line, ...others] = await historyOf(connection);
      expect(others).toEqual([]);
      expect(line).toMatchObject({ outcome: 'failed', reason: 'delivery', status: null, message: DELIVERY_FAILED });
      expect(line!.did.broughtIn.count).toBe(0);
    });
  });

  describe('a failure is written only once the delivery is attributed', () => {
    const pushing = (handle: (host: PushHost) => Promise<Response>): Connector => ({
      manifest: {
        id: 'teams',
        displayName: 'Microsoft Teams',
        cardText: '',
        supportsPush: true,
        auth: { kind: 'none' },
      },
      async sync() {},
      handleWebhook: async (_request, host) => handle(host),
    });
    const delivery = () => new Request('https://cockpit.test/ingress/teams/messages', { method: 'POST' });
    const bad = () => new SourceError('The Bot Framework answered 502', 502);

    it('writes a Failed line with the status when Teams throws the status error after attribution', async () => {
      const connection = await connectTeams();
      const connector = pushing(async (host) => {
        await host.forAccount(`${TEAMS_TENANT}:${TEAMS_PERSON}`);
        throw bad();
      });

      await expect(handlePush(connector, delivery(), { env, filed: () => {} })).rejects.toThrow('502');

      const [line, ...others] = await historyOf(connection);
      expect(others).toEqual([]);
      expect(line).toMatchObject({
        outcome: 'failed',
        reason: 'delivery',
        status: 502,
        message: 'The Bot Framework answered 502',
      });
    });

    it('writes no line anywhere for a delivery attributed to no connection', async () => {
      await connectTeams();
      const connector = pushing(async (host) => {
        expect(await host.forAccount(`${TEAMS_TENANT}:somebody-else-entirely`)).toBeNull();
        throw bad();
      });

      await expect(handlePush(connector, delivery(), { env, filed: () => {} })).rejects.toThrow('502');

      expect(await countIn('connection_history')).toBe(0);
    });

    it('writes no line for a call that was refused before attribution', async () => {
      await connectTeams();

      const answer = await SELF.fetch('http://cockpit.test/ingress/teams/messages', {
        method: 'POST',
        headers: { authorization: `Bearer ${await channelToken({ forged: true })}` },
        body: JSON.stringify(saveToCockpitCall()),
      });

      expect(answer.status).toBe(401);
      expect(await countIn('connection_history')).toBe(0);
    });

    it('says only that it could not be filed for an error that is not the connector’s own words', async () => {
      const connection = await connectTeams();
      const connector = pushing(async (host) => {
        await host.forAccount(`${TEAMS_TENANT}:${TEAMS_PERSON}`);
        throw new Error('SQLITE_ERROR: something with the delivered message in it');
      });

      await expect(handlePush(connector, delivery(), { env, filed: () => {} })).rejects.toThrow();

      const [line] = await historyOf(connection);
      expect(line).toMatchObject({ outcome: 'failed', status: null, message: DELIVERY_FAILED });
    });
  });
});
