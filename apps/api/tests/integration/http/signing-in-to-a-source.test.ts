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
const EXTRAS = 'fake-extras';

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

/** What the fake source below was asked to revoke, and whether it is to refuse. */
const revoked: { credential: string }[] = [];
let revokeFails = false;

const REASON = 'The source did not let Cockpit stay signed in.';

/**
 * A source that wants more of its sign-in: offline access asked for and a
 * consent screen forced (and an attempt to also move the redirect address,
 * which is not its to move), a grant without a refresh token refused with a
 * reason the window can say, and the grant ended at the source on disconnect.
 */
const withExtras: Connector = {
  manifest: {
    ...fixedUrls.manifest,
    id: EXTRAS,
    displayName: 'A source that asks for more',
    cardText: 'A source that asks for more.',
    auth: {
      kind: 'oauth2',
      endpoints: { authorizationUrl: `${ISSUER}/authorize`, tokenUrl: `${ISSUER}/token` },
      scopes: ['read'],
      clientSettings: { id: 'FAKE_SOURCE_CLIENT_ID', secret: 'FAKE_SOURCE_CLIENT_SECRET' },
      authorizationParams: {
        access_type: 'offline',
        prompt: 'select_account consent',
        redirect_uri: 'https://elsewhere.test/steal',
      },
      refusals: { 'no-refresh-token': REASON },
    },
  },
  async sync() {},
  accountFrom({ tokenResponse }) {
    if (typeof tokenResponse.access_token !== 'string') return null;
    if (typeof tokenResponse.refresh_token !== 'string') return { refused: 'no-refresh-token' };
    if (tokenResponse.refresh_token === 'unlisted') return { refused: 'a-code-nobody-listed' };
    return { key: `account-of-${tokenResponse.access_token}`, displayName: `Source account ${tokenResponse.access_token}` };
  },
  async revoke(credentials) {
    revoked.push({ credential: credentials.credential! });
    if (revokeFails) throw new Error('the source could not be reached');
  },
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
  env.TEST_CONNECTORS = [fixedUrls, noSignIn, withExtras];
  revoked.length = 0;
  revokeFails = false;
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
          connectors: {
            id: string;
            displayName: string;
            cardText: string;
            asksFirst: boolean;
            refusals: Record<string, string>;
          }[];
        }
      ).connectors;

    it('lists Teams with the name and text its manifest gives, and a source registered nowhere else', async () => {
      expect(await listed()).toEqual([
        {
          id: 'teams',
          displayName: 'Microsoft Teams',
          cardText: 'Sign in with Microsoft. Cockpit reads who you are and nothing else.',
          asksFirst: false,
          refusals: {},
        },
        {
          id: FIXED,
          displayName: 'A source with fixed addresses',
          cardText: 'A source reached at fixed addresses.',
          asksFirst: false,
          refusals: {},
        },
        {
          id: EXTRAS,
          displayName: 'A source that asks for more',
          cardText: 'A source that asks for more.',
          asksFirst: false,
          refusals: { 'no-refresh-token': REASON },
        },
      ]);
    });

    it('lists no Teams where its bot is not configured', async () => {
      const bot = settings.MS_BOT_APP_ID;
      delete settings.MS_BOT_APP_ID;
      try {
        expect((await listed()).map((one) => one.id)).toEqual([FIXED, EXTRAS]);
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

  describe('a source can ask more of its sign-in than the plain request', () => {
    it('adds the parameters its description declares to the redirect, and none where it declares none', async () => {
      await issuerIsReachable();
      const session = await signInAs(USER_ID);

      const extras = (await startConnecting(EXTRAS, session)).asked!;
      const plain = (await startConnecting(FIXED, session)).asked!;
      const teams = (await startConnecting('teams', session)).asked!;

      expect(Object.fromEntries(extras.searchParams)).toMatchObject({
        access_type: 'offline',
        prompt: 'select_account consent',
        // Asking for more does not move where the answer goes.
        redirect_uri: `https://cockpit.test/v1/connections/${EXTRAS}/callback`,
      });
      for (const asked of [plain, teams]) {
        expect(asked.searchParams.has('access_type')).toBe(false);
        expect(asked.searchParams.get('prompt')).toBe('select_account');
      }
    });
  });

  describe('a grant the source’s account step refuses stores nothing and says why', () => {
    async function comeBack(grant: Record<string, unknown>) {
      await issuerIsReachable();
      const session = await signInAs(USER_ID);
      const { asked, attempt } = await startConnecting(EXTRAS, session);
      issuerWillIdentify({ email: 'nobody@example.com', nonce: asked!.searchParams.get('nonce')! }, 'a-code', grant);
      return SELF.fetch(
        `http://cockpit.test/v1/connections/${EXTRAS}/callback?${new URLSearchParams({
          code: 'a-code',
          state: asked!.searchParams.get('state')!,
        })}`,
        { redirect: 'manual', headers: { cookie: `${session}; ${attempt}` } },
      );
    }

    it.each([
      {
        situation: 'a reason the description lists',
        grant: { access_token: 'ada' },
        goes: `/w/${WORKSPACE_ID}?connections=refused&by=${EXTRAS}&because=no-refresh-token`,
      },
      {
        situation: 'a reason nobody listed',
        grant: { access_token: 'ada', refresh_token: 'unlisted' },
        goes: `/w/${WORKSPACE_ID}?connections=refused`,
      },
    ])('connects nothing for $situation', async ({ grant, goes }) => {
      const back = await comeBack(grant);

      expect(back.headers.get('location')).toBe(goes);
      expect(await storedRows()).toEqual([]);
    });

    it('connects the account when the step accepts the grant', async () => {
      const back = await comeBack({ access_token: 'ada', refresh_token: 'r1' });

      expect(back.headers.get('location')).toBe(`/w/${WORKSPACE_ID}?connections=connected`);
      expect((await storedRows()).map((row) => row.external_account_key)).toEqual(['account-of-ada']);
    });
  });

  describe('disconnecting ends the source’s sign-in unless another workspace holds the same account', () => {
    async function connectAs(connectorId: string, workspaceId: string, grant: Record<string, unknown>) {
      await issuerIsReachable();
      const session = await signInAs(USER_ID);
      const { asked, attempt } = await startConnecting(connectorId, session, workspaceId);
      issuerWillIdentify({ email: 'nobody@example.com', nonce: asked!.searchParams.get('nonce')! }, 'a-code', grant);
      await SELF.fetch(
        `http://cockpit.test/v1/connections/${connectorId}/callback?${new URLSearchParams({
          code: 'a-code',
          state: asked!.searchParams.get('state')!,
        })}`,
        { redirect: 'manual', headers: { cookie: `${session}; ${attempt}` } },
      );
    }

    async function disconnect(workspaceId: string, connectorId: string): Promise<Response> {
      const rows = (
        (await (await asUser(`http://cockpit.test/v1/workspaces/${workspaceId}/connections`)).json()) as {
          sourceAccounts: { id: string; connectorId: string }[];
        }
      ).sourceAccounts;
      return asUser('http://cockpit.test/v1/commands/disconnect_source_account', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          commandId: crypto.randomUUID(),
          issuedAt: '2026-09-18T10:00:00.000Z',
          workspaceId,
          sourceAccountId: rows.find((one) => one.connectorId === connectorId)!.id,
        }),
      });
    }

    const GRANT = { access_token: 'ada', refresh_token: 'the-refresh-token' };

    it('revokes with the opened credential when this workspace is the only holder', async () => {
      await connectAs(EXTRAS, WORKSPACE_ID, GRANT);

      const res = await disconnect(WORKSPACE_ID, EXTRAS);

      expect(res.status).toBe(200);
      expect(await storedRows()).toEqual([]);
      expect(revoked.map((one) => JSON.parse(one.credential).refresh_token)).toEqual(['the-refresh-token']);
    });

    it('does not revoke while another workspace holds the same account, and does once the last lets go', async () => {
      await connectAs(EXTRAS, WORKSPACE_ID, GRANT);
      await connectAs(EXTRAS, 'ws-atlas', GRANT);

      await disconnect(WORKSPACE_ID, EXTRAS);
      expect(revoked).toEqual([]);
      expect(await storedRows()).toHaveLength(1);

      await disconnect('ws-atlas', EXTRAS);
      expect(revoked).toHaveLength(1);
    });

    it('still disconnects when the revoke fails', async () => {
      await connectAs(EXTRAS, WORKSPACE_ID, GRANT);
      revokeFails = true;

      const res = await disconnect(WORKSPACE_ID, EXTRAS);

      expect(res.status).toBe(200);
      expect(await storedRows()).toEqual([]);
      expect(revoked).toHaveLength(1);
    });

    it('disconnects as it always did for a source that supplies no revoke', async () => {
      await connectAs(FIXED, WORKSPACE_ID, { access_token: 'ada' });

      const res = await disconnect(WORKSPACE_ID, FIXED);

      expect(res.status).toBe(200);
      expect(await storedRows()).toEqual([]);
      expect(revoked).toEqual([]);
    });
  });
});
