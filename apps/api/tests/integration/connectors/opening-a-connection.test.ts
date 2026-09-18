import { afterEach, beforeEach, describe, expect, inject, it } from 'vitest';
import { SELF, applyD1Migrations, env } from 'cloudflare:test';
import { pushHostFor } from '../../../src/connectors/push-host.js';
import {
  USER_ID,
  WORKSPACE_ID,
  alsoWorkspaces,
  inTheStore,
  seedRegister,
  signInAs,
  startFromEmpty,
} from '../seed.js';
import { issuerIsForgotten, issuerIsReachable, issuerWillIdentify } from '../issuer.js';

/**
 * Integration level, and deliberately not through `SELF.fetch`: opening a
 * connection's credential is a capability the host offers a connector, and no
 * connector asks for one yet - a saved Teams message carries what it saves, so
 * nothing has to be unsealed to file it ("Save a Teams message to Cockpit",
 * issue 486). The HTTP layer cannot reach it by construction, which is the one
 * case the testing strategy allows entering below the interface
 * (tests/integration/db/constraints.test.ts is the other).
 *
 * What it holds is the promise the whole ordering exists for: a credential is
 * opened for the connection a push was matched to and for no other, and the
 * account's own store is what says a connection is still there.
 */

const TENANT = 'cockpit-test-tenant';
const PERSON = 'the-person-who-connected';

/** Connecting a Teams account to a Workspace, the whole walk a browser makes. */
async function connectTeams(workspaceId = WORKSPACE_ID): Promise<void> {
  await issuerIsReachable();
  const session = await signInAs(USER_ID);
  const started = await SELF.fetch(
    `http://cockpit.test/v1/workspaces/${workspaceId}/connections/teams/connect`,
    { redirect: 'manual', headers: { cookie: session } },
  );
  const asked = new URL(started.headers.get('location')!);
  const attempt = started.headers
    .getSetCookie()
    .map((cookie) => cookie.split(';')[0]!)
    .find((cookie) => cookie.startsWith('cockpit_connect='))!;
  issuerWillIdentify({
    email: 'michael@example.com',
    name: 'Michael',
    nonce: asked.searchParams.get('nonce')!,
    tenant: TENANT,
    object: PERSON,
  });
  const back = await SELF.fetch(
    `http://cockpit.test/v1/connections/teams/callback?${new URLSearchParams({
      code: 'a-code',
      state: asked.searchParams.get('state')!,
    })}`,
    { redirect: 'manual', headers: { cookie: `${session}; ${attempt}` } },
  );
  expect(back.headers.get('location')).toBe(`/w/${workspaceId}?connections=connected`);
}

const host = () => pushHostFor('teams', { env, waitUntil: () => {} });

const directoryRows = () =>
  env.DB.prepare('SELECT account_id FROM connector_directory').all().then((read) => read.results);

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
  describe('a connected account opens its own credential, and nothing opens anybody else’s', () => {
    it('hands back what this account was connected with, sealed and opened again', async () => {
      await connectTeams();

      const connection = await host().forAccount(`${TENANT}:${PERSON}`);

      expect(connection).not.toBeNull();
      // The whole round trip: what Microsoft answered, sealed by the callback,
      // stored, and opened here with this environment's key.
      const { credential } = await connection!.getCredentials();
      expect(JSON.parse(credential!)).toHaveProperty('id_token');
    });

    it.each([
      { situation: 'an account nobody connected', key: `${TENANT}:somebody-else` },
      { situation: 'a directory nobody connected from', key: `another-tenant:${PERSON}` },
      { situation: 'a name that is not a key at all', key: '' },
    ])('has nothing to open for $situation', async ({ key }) => {
      await connectTeams();

      expect(await host().forAccount(key)).toBeNull();
    });
  });

  describe('what the register says is believed only where the account still says it too', () => {
    it('opens nothing for a connection the account no longer holds, and forgets where it pointed', async () => {
      await connectTeams();
      // The row the register keeps is an index, not the connection: disconnect
      // the account's own row and the index is left pointing at nothing.
      await inTheStore((sql) => sql.exec('DELETE FROM connector_accounts'));
      expect(await directoryRows()).toHaveLength(1);

      expect(await host().forAccount(`${TENANT}:${PERSON}`)).toBeNull();

      expect(await directoryRows()).toEqual([]);
    });
  });
});
