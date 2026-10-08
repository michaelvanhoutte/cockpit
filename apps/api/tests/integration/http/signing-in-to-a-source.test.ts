import { afterEach, beforeEach, describe, expect, inject, it } from 'vitest';
import { SELF, applyD1Migrations, env } from 'cloudflare:test';
import type { Connector } from '@cockpit/connector-sdk';
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
import { ISSUER, issuerIsForgotten, issuerIsReachable, issuerWillIdentify } from '../issuer.js';

/**
 * Integration level, through the real Worker, for the reason connections.test.ts
 * gives: connecting is two navigations with a secret carried between them and
 * a real exchange in the middle. That file holds Teams' walk and what a stored
 * connection must look like; this one holds what is true of *any* registered
 * connector ("Connect and disconnect a source through one generic sign-in
 * flow", issue 892), against fakes registered in place of the registry's own
 * list, so adding a source is shown to need no route.
 */

const FIXED = 'fake-fixed-urls';
const NO_SIGN_IN = 'fake-no-sign-in';

const settings = env as unknown as Record<string, string | undefined>;

/** A source with fixed addresses and no identity token: the account is read off the token response. */
const fixedUrls: Connector = {
  manifest: {
    id: FIXED,
    displayName: 'A source with fixed addresses',
    cardText: 'A source reached at fixed addresses.',
    source: 'notion',
    supportsPush: false,
    auth: {
      kind: 'oauth2',
      endpoints: { authorizationUrl: `${ISSUER}/authorize`, tokenUrl: `${ISSUER}/token` },
      scopes: ['read', 'offline'],
      clientSettings: { id: 'FAKE_SOURCE_CLIENT_ID', secret: 'FAKE_SOURCE_CLIENT_SECRET' },
    },
  },
  async sync() {},
  accountFrom({ claims, tokenResponse }) {
    // Fixed addresses have no identity token to verify, so none is read.
    if (claims !== null || typeof tokenResponse.access_token !== 'string') return null;
    return { key: `account-of-${tokenResponse.access_token}`, displayName: `Source account ${tokenResponse.access_token}` };
  },
};

/** A source that is only ever pushed to, with nothing to sign in to. */
const noSignIn: Connector = {
  manifest: {
    id: NO_SIGN_IN,
    displayName: 'A source with no sign-in',
    cardText: 'A source with no sign-in.',
    source: 'notion',
    supportsPush: false,
    auth: { kind: 'none' },
  },
  async sync() {},
};

interface StoredRow extends Record<string, string> {
  connector_id: string;
  external_account_key: string;
  display_name: string;
}

function storedRows(): Promise<StoredRow[]> {
  return inTheStore((sql) => [
    ...sql.exec<StoredRow>(
      'SELECT connector_id, external_account_key, display_name FROM connector_accounts ORDER BY connected_at',
    ),
  ]);
}

/** Pressing Connect for a source: what the browser is sent to, and what it is left holding. */
async function startConnecting(connectorId: string, session: string, workspaceId = WORKSPACE_ID) {
  const res = await SELF.fetch(
    `http://cockpit.test/v1/workspaces/${workspaceId}/connections/${connectorId}/connect`,
    { redirect: 'manual', headers: { cookie: session } },
  );
  const attempt = res.headers
    .getSetCookie()
    .map((cookie) => cookie.split(';')[0]!)
    .find((cookie) => cookie.startsWith('cockpit_connect='));
  return { res, attempt, asked: res.status === 302 ? new URL(res.headers.get('location')!) : null };
}

beforeEach(async () => {
  await applyD1Migrations(env.DB, inject('migrations'));
  await startFromEmpty();
  await seedRegister();
  await alsoWorkspaces();
  env.TEST_CONNECTORS = [fixedUrls, noSignIn];
  settings.FAKE_SOURCE_CLIENT_ID = 'the-fake-source-client';
  settings.FAKE_SOURCE_CLIENT_SECRET = 'the-fake-source-secret';
});

afterEach(() => {
  delete env.TEST_CONNECTORS;
  delete settings.FAKE_SOURCE_CLIENT_ID;
  delete settings.FAKE_SOURCE_CLIENT_SECRET;
  issuerIsForgotten();
});

describe('Connector management', () => {
  describe('connecting a source runs the sign-in its connector describes', () => {
    /**
     * What the issuer is asked is what a registered redirect URI, a consent
     * screen and a client all depend on, so it is held to exactly what it was
     * when the route was Teams' alone.
     */
    it('asks Microsoft’s way for a Teams account: its client, its address back, an identity and nothing else', async () => {
      await issuerIsReachable();
      const { asked } = await startConnecting('teams', await signInAs(USER_ID));

      expect(asked!.origin + asked!.pathname).toBe(`${ISSUER}/authorize`);
      expect(Object.fromEntries(asked!.searchParams)).toMatchObject({
        client_id: 'cockpit-test',
        redirect_uri: 'https://cockpit.test/v1/connections/teams/callback',
        response_type: 'code',
        scope: 'openid email profile',
        code_challenge_method: 'S256',
        prompt: 'select_account',
      });
      expect(asked!.searchParams.get('state')).toBeTruthy();
      expect(asked!.searchParams.get('nonce')).toBeTruthy();
      expect(asked!.searchParams.get('code_challenge')).toBeTruthy();
    });

    it('connects a source with fixed addresses under the name its own account step gave, in the Workspace it was started from', async () => {
      await issuerIsReachable();
      const session = await signInAs(USER_ID);
      const { asked, attempt } = await startConnecting(FIXED, session, 'ws-atlas');

      expect(asked!.origin + asked!.pathname).toBe(`${ISSUER}/authorize`);
      expect(Object.fromEntries(asked!.searchParams)).toMatchObject({
        client_id: 'the-fake-source-client',
        redirect_uri: `https://cockpit.test/v1/connections/${FIXED}/callback`,
        scope: 'read offline',
      });

      issuerWillIdentify(
        { email: 'nobody@example.com', nonce: asked!.searchParams.get('nonce')! },
        'a-code',
        { access_token: 'ada' },
      );
      const back = await SELF.fetch(
        `http://cockpit.test/v1/connections/${FIXED}/callback?${new URLSearchParams({
          code: 'a-code',
          state: asked!.searchParams.get('state')!,
        })}`,
        { redirect: 'manual', headers: { cookie: `${session}; ${attempt}` } },
      );

      expect(back.headers.get('location')).toBe('/w/ws-atlas?connections=connected');
      expect(await storedRows()).toEqual([
        { connector_id: FIXED, external_account_key: 'account-of-ada', display_name: 'Source account ada' },
      ]);
      const listed = async (workspaceId: string) =>
        (
          (await (await asUser(`http://cockpit.test/v1/workspaces/${workspaceId}/connections`)).json()) as {
            sourceAccounts: { displayName: string }[];
          }
        ).sourceAccounts.map((one) => one.displayName);
      expect(await listed('ws-atlas')).toEqual(['Source account ada']);
      expect(await listed(WORKSPACE_ID)).toEqual([]);
    });

    it('connects nothing where the account step names nobody', async () => {
      await issuerIsReachable();
      const session = await signInAs(USER_ID);
      const { asked, attempt } = await startConnecting(FIXED, session);
      // No `access_token` in the answer: nothing for the step to name.
      issuerWillIdentify({ email: 'nobody@example.com', nonce: asked!.searchParams.get('nonce')! });

      const back = await SELF.fetch(
        `http://cockpit.test/v1/connections/${FIXED}/callback?${new URLSearchParams({
          code: 'a-code',
          state: asked!.searchParams.get('state')!,
        })}`,
        { redirect: 'manual', headers: { cookie: `${session}; ${attempt}` } },
      );

      expect(back.headers.get('location')).toBe(`/w/${WORKSPACE_ID}?connections=refused`);
      expect(await storedRows()).toEqual([]);
    });

    it('refuses a reply to an attempt started for another source, and connects nothing', async () => {
      await issuerIsReachable();
      const session = await signInAs(USER_ID);
      const { asked, attempt } = await startConnecting('teams', session);

      const back = await SELF.fetch(
        `http://cockpit.test/v1/connections/${FIXED}/callback?${new URLSearchParams({
          code: 'a-code',
          state: asked!.searchParams.get('state')!,
        })}`,
        { redirect: 'manual', headers: { cookie: `${session}; ${attempt}` } },
      );

      expect(back.headers.get('location')).toBe('/');
      expect(await storedRows()).toEqual([]);
    });
  });

  describe('a source that is not there, or has no sign-in, cannot be connected', () => {
    it.each([
      { situation: 'one nothing is registered under', connectorId: 'not-a-source' },
      { situation: 'one whose connector has no sign-in', connectorId: NO_SIGN_IN },
    ])('is not found for $situation, starting or coming back', async ({ connectorId }) => {
      const session = await signInAs(USER_ID);

      const started = await startConnecting(connectorId, session);
      const returned = await SELF.fetch(
        `http://cockpit.test/v1/connections/${connectorId}/callback?code=a-code&state=a-state`,
        { redirect: 'manual', headers: { cookie: session } },
      );

      expect({ started: started.res.status, returned: returned.status }).toEqual({
        started: 404,
        returned: 404,
      });
      expect(await storedRows()).toEqual([]);
    });
  });

  describe('the Connections window lists the connectors the registry holds that a person can sign in to', () => {
    const listed = async () =>
      (
        (await (await asUser('http://cockpit.test/v1/connectors')).json()) as {
          connectors: { id: string; displayName: string; cardText: string; asksFirst: boolean }[];
        }
      ).connectors;

    it('lists Teams with the name and text its manifest gives, and a source registered nowhere else', async () => {
      expect(await listed()).toEqual([
        {
          id: 'teams',
          displayName: 'Microsoft Teams',
          cardText: 'Sign in with Microsoft. Cockpit reads who you are and nothing else.',
          asksFirst: false,
        },
        {
          id: FIXED,
          displayName: 'A source with fixed addresses',
          cardText: 'A source reached at fixed addresses.',
          asksFirst: false,
        },
      ]);
    });

    it('lists no Teams where its bot is not configured', async () => {
      const bot = settings.MS_BOT_APP_ID;
      delete settings.MS_BOT_APP_ID;
      try {
        expect((await listed()).map((one) => one.id)).toEqual([FIXED]);
      } finally {
        settings.MS_BOT_APP_ID = bot;
      }
    });

    it('lists no source whose client is not configured', async () => {
      const id = settings.FAKE_SOURCE_CLIENT_ID;
      delete settings.FAKE_SOURCE_CLIENT_ID;
      try {
        expect((await listed()).map((one) => one.id)).not.toContain(FIXED);
      } finally {
        settings.FAKE_SOURCE_CLIENT_ID = id;
      }
    });

    it('lists nothing where the environment has no key to seal a credential with', async () => {
      const key = settings.CONNECTOR_CREDENTIAL_KEY;
      delete settings.CONNECTOR_CREDENTIAL_KEY;
      try {
        expect(await listed()).toEqual([]);
      } finally {
        settings.CONNECTOR_CREDENTIAL_KEY = key;
      }
    });

    it('lists no source that has no sign-in', async () => {
      expect((await listed()).map((one) => one.id)).not.toContain(NO_SIGN_IN);
    });
  });
});
