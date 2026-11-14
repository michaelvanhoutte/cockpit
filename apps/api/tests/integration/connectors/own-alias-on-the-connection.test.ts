import { afterEach, beforeEach, describe, expect, inject, it } from 'vitest';
import { SELF, applyD1Migrations, env, runDurableObjectAlarm } from 'cloudflare:test';
import type { Connector, ConnectorHost } from '@cockpit/connector-sdk';
import type { EnrichmentJob } from '../../../src/jobs/enrichment.js';
import { handleQueue } from '../../../src/jobs/index.js';
import { seal, sealingKey } from '../../../src/connectors/credential-crypto.js';
import {
  ACCOUNT_NAME,
  USER_ID,
  WORKSPACE_ID,
  alsoWorkspaces,
  asUser,
  inTheStore,
  seedRegister,
  signInAs,
  startFromEmpty,
  storeNamed,
} from '../seed.js';
import { ISSUER, issuerIsForgotten, issuerIsReachable, issuerWillIdentify } from '../issuer.js';
import { batchOf } from '../http/note-cleanup.support.js';

/**
 * Integration level, through the account's real store, its real alarm, the
 * Worker's real queue consumer and the app's own routes: an Outlook connection
 * holds your Cockpit alias, asked when connecting and from *Change…*, and its
 * check is handed it ("Outlook capture: a mail you Cc to your Cockpit alias
 * arrives To do…", issue 1760). What the connector does with the alias is its
 * package's (counting-your-own-mail.test.ts); what a turn does to a status is
 * outlook-conversations-on-the-host.test.ts's.
 *
 * **Against fake pulled connectors**, registered in place of the registry's
 * list: one that asks for an alias, as Outlook does, and one that does not, as
 * Gmail does not. Each check records the alias it was handed.
 */

const ASKS = 'fake-asks-alias';
const ASKS_NONE = 'fake-asks-none';
const OTHER_WORKSPACE = 'ws-atlas';
const ALIAS = 'cockpit@conselit.be';

const settings = env as unknown as Record<string, string | undefined>;

/** The alias each check was handed, in order. */
let handed: (string | null | undefined)[] = [];

function connectorNamed(id: string, asksOwnAlias: boolean): Connector {
  return {
    manifest: {
      id,
      displayName: asksOwnAlias ? 'A mailbox with an alias' : 'A mailbox without one',
      cardText: 'A source.',
      supportsPush: false,
      pulled: true,
      ...(asksOwnAlias ? { asksOwnAlias: true } : {}),
      auth: {
        kind: 'oauth2',
        endpoints: { authorizationUrl: `${ISSUER}/authorize`, tokenUrl: `${ISSUER}/token` },
        scopes: ['read'],
        clientSettings: { id: 'FAKE_SOURCE_CLIENT_ID', secret: 'FAKE_SOURCE_CLIENT_SECRET' },
      },
    },
    async sync(host: ConnectorHost) {
      handed.push(host.ownAlias);
    },
    accountFrom({ tokenResponse }) {
      if (typeof tokenResponse.access_token !== 'string') return null;
      return { key: `account-of-${tokenResponse.access_token}`, displayName: `Source account ${tokenResponse.access_token}` };
    },
  };
}

let held: EnrichmentJob[] = [];
let realQueue: typeof env.ENRICHMENT;

beforeEach(async () => {
  await applyD1Migrations(env.DB, inject('migrations'));
  await startFromEmpty();
  await seedRegister();
  await alsoWorkspaces();
  held = [];
  handed = [];
  realQueue = env.ENRICHMENT;
  env.ENRICHMENT = {
    send: async (body: EnrichmentJob) => {
      held.push(body);
    },
    sendBatch: async () => {
      throw new Error('nothing here sends a batch');
    },
  } as unknown as typeof env.ENRICHMENT;
  env.TEST_CONNECTORS = [connectorNamed(ASKS, true), connectorNamed(ASKS_NONE, false)];
  settings.FAKE_SOURCE_CLIENT_ID = 'the-fake-source-client';
  settings.FAKE_SOURCE_CLIENT_SECRET = 'the-fake-source-secret';
});

afterEach(() => {
  env.ENRICHMENT = realQueue;
  delete env.TEST_CONNECTORS;
  delete settings.FAKE_SOURCE_CLIENT_ID;
  delete settings.FAKE_SOURCE_CLIENT_SECRET;
  issuerIsForgotten();
});

async function deliver(body: EnrichmentJob): Promise<void> {
  await handleQueue(batchOf(body), env);
}

async function theQueuedCheck(): Promise<EnrichmentJob> {
  for (let waited = 0; waited < 10_000; waited += 25) {
    const at = held.findIndex((job) => job.kind === 'check-a-pulled-connection');
    if (at >= 0) return held.splice(at, 1)[0]!;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('no check was ever queued');
}

/** Connects one account of a source to a Workspace, with an alias or none, and runs the check connecting queues. */
async function connect(ownAlias: string | null | undefined, workspaceId = WORKSPACE_ID, connectorId = ASKS): Promise<string> {
  const key = await sealingKey(env.CONNECTOR_CREDENTIAL_KEY);
  const sealed = await seal('a-credential', key!);
  const sourceAccountId = crypto.randomUUID();
  const answer = await storeNamed(ACCOUNT_NAME).applyChange(ACCOUNT_NAME, 'connect_source_account', {
    commandId: crypto.randomUUID(),
    issuedAt: new Date().toISOString(), // clock-ok: a connection is stamped by the real clock, which nothing here reads back
    workspaceId,
    sourceAccountId,
    connectorId,
    // The same mailbox whichever Workspace connects it.
    externalAccountKey: `anna-at-${connectorId}`,
    displayName: 'Anna',
    ...sealed,
    ...(ownAlias === undefined ? {} : { ownAlias }),
  });
  expect(answer.status).toBe('ok');
  await deliver(await theQueuedCheck());
  return sourceAccountId;
}

/** The alarm firing and the check it queues delivered. */
async function nextCheck(): Promise<void> {
  await inTheStore((sql) => sql.exec(`UPDATE pulled_connections SET due_at = '2000-01-01T00:00:00.000Z'`));
  await runDurableObjectAlarm(storeNamed(ACCOUNT_NAME));
  for (;;) {
    const at = held.findIndex((job) => job.kind === 'check-a-pulled-connection');
    if (at < 0) return;
    await deliver(held.splice(at, 1)[0]!);
  }
}

async function send(name: string, body: Record<string, unknown>, commandId: string = crypto.randomUUID()): Promise<Response> {
  return asUser(`http://cockpit.test/v1/commands/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ commandId, issuedAt: new Date().toISOString(), ...body }), // clock-ok: a change is stamped by the real clock, which nothing here reads back
  });
}

const setsAlias = (sourceAccountId: string, ownAlias: unknown, workspaceId = WORKSPACE_ID, commandId?: string) =>
  send('set_connection_own_alias', { workspaceId, sourceAccountId, ownAlias }, commandId);

const storedAliases = () =>
  inTheStore((sql) =>
    [...sql.exec<{ own_alias: string | null }>('SELECT own_alias FROM connector_accounts ORDER BY connected_at, id')].map((row) => row.own_alias),
  );

/** What the Connections window lists of one Workspace's connection. */
async function listed(sourceAccountId: string, workspaceId = WORKSPACE_ID) {
  const answer = (await (await asUser(`http://cockpit.test/v1/workspaces/${workspaceId}/connections`)).json()) as {
    sourceAccounts: { id: string; ownAlias: string | null }[];
  };
  return answer.sourceAccounts.find((one) => one.id === sourceAccountId);
}

describe('Connector management', () => {
  describe('an Outlook connection holds an optional Cockpit alias, set when connecting and from Change…, and its check reads it', () => {
    it('stores the alias it was connected with, lists it, and hands it to the next check', async () => {
      const connection = await connect(ALIAS);

      expect(await storedAliases()).toEqual([ALIAS]);
      expect((await listed(connection))?.ownAlias).toBe(ALIAS);
      expect(handed).toEqual([ALIAS]);
    });

    it('hands the next check the alias as Change… sets, changes and clears it', async () => {
      const connection = await connect(undefined);

      for (const alias of ['first@conselit.be', ALIAS, null]) {
        expect((await setsAlias(connection, alias)).status).toBe(200);
        expect((await listed(connection))?.ownAlias).toBe(alias);
        await nextCheck();
      }

      expect(handed).toEqual([null, 'first@conselit.be', ALIAS, null]);
    });

    it.each([
      { situation: 'words', alias: 'my alias' },
      { situation: 'an address with no domain', alias: 'cockpit@' },
      { situation: 'nothing at all', alias: '' },
      { situation: 'no answer', alias: undefined },
    ])('refuses $situation from Change…, and stores nothing', async ({ alias }) => {
      const connection = await connect(ALIAS);

      const res = await setsAlias(connection, alias);

      expect(res.status).toBe(400);
      expect(await storedAliases()).toEqual([ALIAS]);
    });

    it('applies the same change sent twice once', async () => {
      const connection = await connect(undefined);
      const commandId = crypto.randomUUID();

      const first = await setsAlias(connection, ALIAS, WORKSPACE_ID, commandId);
      const again = await setsAlias(connection, ALIAS, WORKSPACE_ID, commandId);

      expect(await first.json()).toMatchObject({ applied: true });
      expect(await again.json()).toMatchObject({ applied: false });
      expect(await storedAliases()).toEqual([ALIAS]);
      const logged = await inTheStore((sql) =>
        sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM commands WHERE name = 'set_connection_own_alias'").one(),
      );
      expect(logged.n).toBe(1);
    });

    it('keeps each Workspace’s own alias for the same mailbox connected to two Workspaces', async () => {
      const here = await connect(ALIAS);
      const there = await connect(undefined, OTHER_WORKSPACE);

      expect((await setsAlias(there, 'atlas@conselit.be', OTHER_WORKSPACE)).status).toBe(200);
      // Naming the other Workspace's connection from here is refused.
      expect((await setsAlias(there, 'wrong@conselit.be')).status).toBe(404);

      expect((await listed(here))?.ownAlias).toBe(ALIAS);
      expect((await listed(there, OTHER_WORKSPACE))?.ownAlias).toBe('atlas@conselit.be');
    });

    it('asks no alias of a mailbox whose connector asks none, as Gmail’s does not, and refuses one from Change…', async () => {
      const connection = await connect(undefined, WORKSPACE_ID, ASKS_NONE);
      const registry = ((await (await asUser('http://cockpit.test/v1/connectors')).json()) as {
        connectors: { id: string; asksOwnAlias?: boolean }[];
      }).connectors;

      expect(registry.find((one) => one.id === ASKS)?.asksOwnAlias).toBe(true);
      expect(registry.find((one) => one.id === ASKS_NONE)?.asksOwnAlias).toBeUndefined();
      expect((await setsAlias(connection, ALIAS)).status).toBe(400);
      expect(await storedAliases()).toEqual([null]);
    });
  });

  describe('the alias is asked before Connect leaves and refused there when it is not an email address', () => {
    /** Pressing Connect once the window has asked: what the browser is sent to, and what it is left holding. */
    async function startConnecting(session: string, ownAlias?: string) {
      const query = ownAlias === undefined ? '' : `?${new URLSearchParams({ ownAlias })}`;
      const res = await SELF.fetch(`http://cockpit.test/v1/workspaces/${WORKSPACE_ID}/connections/${ASKS}/connect${query}`, {
        redirect: 'manual',
        headers: { cookie: session },
      });
      const attempt = res.headers
        .getSetCookie()
        .map((cookie) => cookie.split(';')[0]!)
        .find((cookie) => cookie.startsWith('cockpit_connect='));
      return { res, attempt, asked: res.status === 302 && attempt ? new URL(res.headers.get('location')!) : null };
    }

    async function comeBack(session: string, started: Awaited<ReturnType<typeof startConnecting>>) {
      await issuerIsReachable();
      issuerWillIdentify({ email: 'nobody@example.com', nonce: started.asked!.searchParams.get('nonce')! }, 'a-code', { access_token: 'ada' });
      return SELF.fetch(
        `http://cockpit.test/v1/connections/${ASKS}/callback?${new URLSearchParams({ code: 'a-code', state: started.asked!.searchParams.get('state')! })}`,
        { redirect: 'manual', headers: { cookie: `${session}; ${started.attempt}` } },
      );
    }

    it.each([
      { situation: 'with an alias, stores it', asked: ` ${ALIAS} `, stored: [ALIAS] },
      { situation: 'with none, stores none', asked: 'none', stored: [null] },
      { situation: 'with no answer, stores none', asked: undefined, stored: [null] },
    ])('Connect $situation', async ({ asked, stored }) => {
      const session = await signInAs(USER_ID);

      const back = await comeBack(session, await startConnecting(session, asked));

      expect(back.headers.get('location')).toBe(`/w/${WORKSPACE_ID}?connections=connected`);
      expect(await storedAliases()).toEqual(stored);
    });

    it('starts nothing for an alias that is not an email address', async () => {
      const started = await startConnecting(await signInAs(USER_ID), 'my alias');

      expect(started.res.headers.get('location')).toBe(`/w/${WORKSPACE_ID}?connections=refused`);
      expect(started.attempt).toBeUndefined();
      expect(await storedAliases()).toEqual([]);
    });
  });
});
