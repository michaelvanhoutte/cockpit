import { afterEach, beforeEach, describe, expect, inject, it } from 'vitest';
import { SELF, applyD1Migrations, env } from 'cloudflare:test';
import { pushHostFor } from '../../../src/connectors/push-host.js';
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

/**
 * Integration level, through the real Worker and the account's real store:
 * connecting Teams asks Microsoft for permission to read chats and channel
 * posts, steps down one tier each time Microsoft says an administrator must
 * approve, and keeps what it got ("Read pasted Teams links: connecting Teams
 * asks for no read permission", issue 1754). The step-down is the generic
 * sign-in's, driven by the tiers the Teams connector describes.
 */

const TENANT = 'cockpit-test-tenant';
const PERSON = 'the-person-who-connected';

/** How Microsoft words an administrator's approval being needed, for the two codes it uses. */
const ADMIN_NEEDED = [
  { situation: 'AADSTS65001', error: 'access_denied', description: 'AADSTS65001: The user or administrator has not consented to use the application.' },
  { situation: 'AADSTS90094', error: 'consent_required', description: 'AADSTS90094: The grant requires admin permission.' },
] as const;

interface Started {
  session: string;
  asked: URL;
  attempt: string;
}

const scopesOf = (asked: URL) => asked.searchParams.get('scope')!.split(' ');

/** Pressing Connect: where the browser is sent, and the attempt it is left holding. */
async function startConnecting(session?: string): Promise<Started> {
  await issuerIsReachable();
  const held = session ?? (await signInAs(USER_ID));
  const res = await SELF.fetch(`http://cockpit.test/v1/workspaces/${WORKSPACE_ID}/connections/teams/connect`, {
    redirect: 'manual',
    headers: { cookie: held },
  });
  return { session: held, ...reached(res) };
}

/** Where a redirect sends the browser and the connect attempt it sets, as the browser would keep them. */
function reached(res: Response): { asked: URL; attempt: string } {
  const attempt = res.headers
    .getSetCookie()
    .map((cookie) => cookie.split(';')[0]!)
    .filter((cookie) => cookie.startsWith('cockpit_connect='))
    .at(-1)!;
  return { asked: new URL(res.headers.get('location')!, 'http://cockpit.test'), attempt };
}

/** Microsoft sending the browser back, carrying the reply as given and the state this attempt asked with. */
function comeBack(started: Started, reply: Record<string, string>, attempt = started.attempt) {
  return SELF.fetch(
    `http://cockpit.test/v1/connections/teams/callback?${new URLSearchParams({
      state: started.asked.searchParams.get('state')!,
      ...reply,
    })}`,
    { redirect: 'manual', headers: { cookie: `${started.session}; ${attempt}` } },
  );
}

/** Microsoft handing back a code that spends for this person, with what the grant holds. */
function microsoftGives(started: Started, grant: { refresh_token?: string; access_token?: string; scope?: string } = {}) {
  issuerWillIdentify(
    { email: 'michael@example.com', name: 'Michael', nonce: started.asked.searchParams.get('nonce')!, tenant: TENANT, object: PERSON },
    'a-code',
    grant,
  );
}

/** Microsoft saying an administrator must approve, and the browser sent on to ask for the next tier. */
async function refusedForAdmin(started: Started, how: (typeof ADMIN_NEEDED)[number] = ADMIN_NEEDED[0]): Promise<Started> {
  const res = await comeBack(started, { error: how.error, error_description: how.description });
  expect(res.status).toBe(302);
  return { session: started.session, ...reached(res) };
}

interface Row extends Record<string, string | null> {
  granted: string | null;
}
const storedRows = () => inTheStore((sql) => [...sql.exec<Row>('SELECT id, granted FROM connector_accounts')]);

async function credentialStored() {
  const connection = await pushHostFor('teams', { env, filed: () => {} }).forAccount(`${TENANT}:${PERSON}`);
  return JSON.parse((await connection!.getCredentials()).credential!) as Record<string, unknown>;
}

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
  describe('connecting Teams asks for the most it can get and steps down one tier per admin-approval refusal', () => {
    it('asks chats and channel posts first, and stores a connection granting both where Microsoft grants them', async () => {
      const started = await startConnecting();
      expect(scopesOf(started.asked)).toEqual(
        expect.arrayContaining(['openid', 'email', 'profile', 'offline_access', 'Chat.Read', 'ChannelMessage.Read.All']),
      );
      microsoftGives(started, { access_token: 'an-access-token', refresh_token: 'a-refresh-token' });

      const back = await comeBack(started, { code: 'a-code' });

      expect(back.headers.get('location')).toBe(`/w/${WORKSPACE_ID}?connections=connected`);
      expect((await storedRows()).map((row) => row.granted)).toEqual(['["chats","channels"]']);
    });

    it.each(ADMIN_NEEDED)('asks for chats alone where channel posts need an administrator ($situation), and stores chats', async (how) => {
      const first = await startConnecting();

      const second = await refusedForAdmin(first, how);

      expect(second.asked.origin + second.asked.pathname).toBe(first.asked.origin + first.asked.pathname);
      expect(scopesOf(second.asked)).toEqual(expect.arrayContaining(['offline_access', 'Chat.Read']));
      expect(scopesOf(second.asked)).not.toContain('ChannelMessage.Read.All');
      // A request of its own: what the first carried cannot be spent for the second.
      expect(second.asked.searchParams.get('state')).not.toBe(first.asked.searchParams.get('state'));
      expect(await storedRows()).toEqual([]);
      microsoftGives(second, { access_token: 'an-access-token', refresh_token: 'a-refresh-token' });

      const back = await comeBack(second, { code: 'a-code' });

      expect(back.headers.get('location')).toBe(`/w/${WORKSPACE_ID}?connections=connected`);
      expect((await storedRows()).map((row) => row.granted)).toEqual(['["chats"]']);
    });

    it('asks for no read permission where chats need an administrator too, and stores today’s connection granting nothing', async () => {
      const first = await startConnecting();
      const second = await refusedForAdmin(first);

      const third = await refusedForAdmin(second, ADMIN_NEEDED[1]);

      expect(scopesOf(third.asked).sort()).toEqual(['email', 'openid', 'profile']);
      microsoftGives(third);

      const back = await comeBack(third, { code: 'a-code' });

      expect(back.headers.get('location')).toBe(`/w/${WORKSPACE_ID}?connections=connected`);
      expect((await storedRows()).map((row) => row.granted)).toEqual(['[]']);
    });

    it('ends the connect where even the last tier needs an administrator, storing nothing', async () => {
      const third = await refusedForAdmin(await refusedForAdmin(await startConnecting()));

      const back = await comeBack(third, { error: ADMIN_NEEDED[0].error, error_description: ADMIN_NEEDED[0].description });

      expect(back.headers.get('location')).toBe(`/w/${WORKSPACE_ID}?connections=refused`);
      expect(await storedRows()).toEqual([]);
    });

    it.each([
      { situation: 'the person cancels at Microsoft', error: 'access_denied', description: 'AADSTS65004: The user declined to consent to access the app.' },
      { situation: 'Microsoft fails', error: 'server_error', description: 'AADSTS90033: A Microsoft Entra service error occurred.' },
      { situation: 'an administrator code is named under an error that is not a consent', error: 'invalid_request', description: 'AADSTS65001: The user or administrator has not consented.' },
      { situation: 'Microsoft says nothing more', error: 'access_denied', description: '' },
    ])('does not step down where $situation, and stores nothing', async ({ error, description }) => {
      const started = await startConnecting();

      const back = await comeBack(started, { error, error_description: description });

      expect(back.headers.get('location')).toBe(`/w/${WORKSPACE_ID}?connections=refused`);
      expect(await storedRows()).toEqual([]);
    });

    it('refuses a callback whose reply does not answer the request the browser holds, even one that says an administrator must approve', async () => {
      const started = await startConnecting();

      const back = await SELF.fetch(
        `http://cockpit.test/v1/connections/teams/callback?${new URLSearchParams({
          state: 'a-state-nobody-asked-with',
          error: ADMIN_NEEDED[0].error,
          error_description: ADMIN_NEEDED[0].description,
        })}`,
        { redirect: 'manual', headers: { cookie: `${started.session}; ${started.attempt}` } },
      );

      expect(back.headers.get('location')).toBe(`/w/${WORKSPACE_ID}?connections=refused`);
      expect(await storedRows()).toEqual([]);
    });

    it.each([
      { situation: 'a tier the connector does not have', tier: 3 },
      { situation: 'a tier far past any it has', tier: 9 },
      { situation: 'a negative tier', tier: -1 },
      { situation: 'part of a tier', tier: 1.5 },
      { situation: 'words for a tier', tier: 'chats' },
    ])('refuses a callback whose attempt names $situation, and stores nothing', async ({ tier }) => {
      const started = await startConnecting();
      const [name, value] = [started.attempt.slice(0, started.attempt.indexOf('=')), started.attempt.slice(started.attempt.indexOf('=') + 1)];
      const edited = `${name}=${encodeURIComponent(JSON.stringify({ ...JSON.parse(decodeURIComponent(value)), tier }))}`;
      microsoftGives(started, { access_token: 'an-access-token', refresh_token: 'a-refresh-token' });

      const back = await comeBack(started, { code: 'a-code' }, edited);

      expect(back.headers.get('location')).not.toContain('connections=connected');
      expect(await storedRows()).toEqual([]);
    });
  });

  describe('a connection keeps what it was granted, and only a read grant stores a credential to read with', () => {
    it('stores a sealed refresh token with a grant of chats', async () => {
      const second = await refusedForAdmin(await startConnecting());
      microsoftGives(second, { access_token: 'an-access-token', refresh_token: 'a-refresh-token' });

      await comeBack(second, { code: 'a-code' });

      expect((await storedRows()).map((row) => row.granted)).toEqual(['["chats"]']);
      expect(await credentialStored()).toMatchObject({ refresh_token: 'a-refresh-token' });
      // Sealed: the row holds neither word of it.
      const raw = await inTheStore((sql) => [...sql.exec<{ encrypted_credential: string }>('SELECT encrypted_credential FROM connector_accounts')]);
      expect(raw[0]!.encrypted_credential).not.toContain('a-refresh-token');
    });

    it('stores no refresh token, as today, for a connection granting nothing', async () => {
      const third = await refusedForAdmin(await refusedForAdmin(await startConnecting()));
      microsoftGives(third);

      await comeBack(third, { code: 'a-code' });

      expect((await storedRows()).map((row) => row.granted)).toEqual(['[]']);
      const credential = await credentialStored();
      expect(credential).toHaveProperty('id_token');
      expect(credential).not.toHaveProperty('refresh_token');
    });

    it('reads as granting nothing, and works as before, for a Teams connection made before this', async () => {
      const started = await startConnecting();
      microsoftGives(started);
      await comeBack(started, { code: 'a-code' });
      await inTheStore((sql) => sql.exec('UPDATE connector_accounts SET granted = NULL'));

      const listed = (await (await asUser(`http://cockpit.test/v1/workspaces/${WORKSPACE_ID}/connections`)).json()) as {
        sourceAccounts: { granted: string[] | null }[];
      };

      expect(listed.sourceAccounts.map((account) => account.granted)).toEqual([null]);
      expect(await pushHostFor('teams', { env, filed: () => {} }).forAccount(`${TENANT}:${PERSON}`)).not.toBeNull();
    });

    it('lists what each connection was granted with its connections', async () => {
      const second = await refusedForAdmin(await startConnecting());
      microsoftGives(second, { access_token: 'an-access-token', refresh_token: 'a-refresh-token' });
      await comeBack(second, { code: 'a-code' });

      const listed = (await (await asUser(`http://cockpit.test/v1/workspaces/${WORKSPACE_ID}/connections`)).json()) as {
        sourceAccounts: { connectorId: string; granted: string[] | null }[];
      };

      expect(listed.sourceAccounts.map((account) => [account.connectorId, account.granted])).toEqual([['teams', ['chats']]]);
    });

    it('asks the top tier again on Reconnect, and stores a grant it now gets on the same row', async () => {
      const connected = await startConnecting();
      const down = await refusedForAdmin(await refusedForAdmin(connected));
      microsoftGives(down);
      await comeBack(down, { code: 'a-code' });
      const [before] = await storedRows();
      expect(before!.granted).toBe('[]');

      const again = await startConnecting(connected.session);
      expect(scopesOf(again.asked)).toEqual(expect.arrayContaining(['Chat.Read', 'ChannelMessage.Read.All']));
      microsoftGives(again, { access_token: 'an-access-token', refresh_token: 'a-refresh-token' });
      await comeBack(again, { code: 'a-code' });

      const after = await storedRows();
      expect(after.map((row) => [row.id, row.granted])).toEqual([[before!.id, '["chats","channels"]']]);
    });

    it('keeps one connection where the same callback arrives twice', async () => {
      const started = await startConnecting();
      microsoftGives(started, { access_token: 'an-access-token', refresh_token: 'a-refresh-token' });
      await comeBack(started, { code: 'a-code' });

      // The browser's attempt was spent by the first, so the second arrives holding none.
      const twice = await SELF.fetch(
        `http://cockpit.test/v1/connections/teams/callback?${new URLSearchParams({
          state: started.asked.searchParams.get('state')!,
          code: 'a-code',
        })}`,
        { redirect: 'manual', headers: { cookie: started.session } },
      );

      expect(twice.headers.get('location')).not.toContain('connections=connected');
      expect(await storedRows()).toHaveLength(1);
    });
  });
});
