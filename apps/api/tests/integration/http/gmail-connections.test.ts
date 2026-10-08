import { beforeEach, describe, expect, inject, it, vi } from 'vitest';
import { SELF, applyD1Migrations, env } from 'cloudflare:test';
import {
  OTHER_USER_ID,
  USER_ID,
  WORKSPACE_ID,
  alsoWorkspaces,
  asUser,
  inTheStore,
  seedRegister,
  signInAs,
  startFromEmpty,
} from '../seed.js';
import {
  issuerAnswersTogether,
  issuerIsReachable,
  issuerRevokes,
  issuerWillIdentify,
  issuerWillRefuseTheExchange,
  revoked,
  type Grant,
} from '../issuer.js';

/**
 * Integration level, through the real Worker, because every rule here is
 * about what ends up stored, what one Workspace sees of another's, and what
 * disconnecting leaves behind ("Connect a Gmail account to a workspace, and
 * disconnect it", issue 724). Google is faked at the network boundary
 * (../issuer.ts): the application does its own redirect, code exchange,
 * signature check and revoke against it.
 *
 * What the address Connect leaves for asks Google, and which claims name the
 * mailbox, are tests/unit/connectors/gmail.test.ts's; what Teams' pair of
 * routes share with these (a reply carrying another connection's proof, one
 * that comes back signed in as another account, a Workspace this account
 * does not have) is tests/integration/http/connections.test.ts's.
 */

const OTHER_WORKSPACE_ID = 'ws-atlas';
const MODIFY = 'https://www.googleapis.com/auth/gmail.modify';

interface StoredRow extends Record<string, string> {
  id: string;
  workspace_id: string;
  connector_id: string;
  external_account_key: string;
  display_name: string;
  encrypted_credential: string;
  credential_nonce: string;
  updated_at: string;
}

function storedRows(): Promise<StoredRow[]> {
  return inTheStore((sql) => [
    ...sql.exec<StoredRow>('SELECT * FROM connector_accounts ORDER BY connected_at'),
  ]);
}

/** What Google hands over for a mailbox whose owner allowed everything asked. */
function granted(refreshToken: string): Grant {
  return {
    refresh_token: refreshToken,
    access_token: `access-for-${refreshToken}`,
    expires_in: 3599,
    scope: `openid https://www.googleapis.com/auth/userinfo.email ${MODIFY}`,
  };
}

async function startConnecting(
  workspaceId: string,
  session: string,
  choosing = '',
): Promise<{ asked: URL; attempt: string }> {
  const res = await SELF.fetch(
    `http://cockpit.test/v1/workspaces/${workspaceId}/connections/gmail/connect${choosing}`,
    { redirect: 'manual', headers: { cookie: session } },
  );
  expect(res.status).toBe(302);
  const asked = new URL(res.headers.get('location')!);
  const attempt = res.headers
    .getSetCookie()
    .map((cookie) => cookie.split(';')[0]!)
    .find((cookie) => cookie.startsWith('cockpit_connect='))!;
  return { asked, attempt };
}

function comeBack(query: Record<string, string>, cookies: string): Promise<Response> {
  return SELF.fetch(
    `http://cockpit.test/v1/connections/gmail/callback?${new URLSearchParams(query)}`,
    { redirect: 'manual', headers: { cookie: cookies } },
  );
}

/** The whole walk for one mailbox: Connect, Google says whose it is, and back. */
async function connect(
  who: { email: string; subject: string },
  grant: Grant = granted(`refresh-${who.subject}`),
  workspaceId = WORKSPACE_ID,
  choosing = '',
): Promise<Response> {
  await issuerIsReachable();
  const session = await signInAs(USER_ID);
  const { asked, attempt } = await startConnecting(workspaceId, session, choosing);
  issuerWillIdentify({ ...who, nonce: asked.searchParams.get('nonce')! }, 'a-code', grant);
  return comeBack(
    { code: 'a-code', state: asked.searchParams.get('state')! },
    `${session}; ${attempt}`,
  );
}

async function listed(
  workspaceId = WORKSPACE_ID,
  userId = USER_ID,
): Promise<{ id: string; displayName: string; connectorId: string; follows?: string; followsLabel?: string }[]> {
  const res = await asUser(`http://cockpit.test/v1/workspaces/${workspaceId}/connections`, {}, userId);
  expect(res.status).toBe(200);
  return (
    (await res.json()) as {
      sourceAccounts: { id: string; displayName: string; connectorId: string; follows?: string; followsLabel?: string }[];
    }
  ).sourceAccounts;
}

function disconnect(sourceAccountId: string, commandId: string, workspaceId = WORKSPACE_ID): Promise<Response> {
  return asUser('http://cockpit.test/v1/commands/disconnect_source_account', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      commandId,
      issuedAt: '2026-10-04T10:00:00.000Z',
      workspaceId,
      sourceAccountId,
    }),
  });
}

const ANNA = { email: 'Anna@Example.com', subject: 'google-anna' };
const PIETER = { email: 'pieter@example.com', subject: 'google-pieter' };

beforeEach(async () => {
  await applyD1Migrations(env.DB, inject('migrations'));
  await startFromEmpty();
  await seedRegister();
  await alsoWorkspaces();
});

describe('Connector management', () => {
  describe('a workspace lists exactly the Gmail accounts it connected, named by their address', () => {
    it('one row per mailbox, in the workspace that connected it only', async () => {
      expect((await connect(ANNA)).headers.get('location')).toBe(
        `/w/${WORKSPACE_ID}?connections=gmail-connected`,
      );
      expect(await listed()).toMatchObject([{ connectorId: 'gmail', displayName: 'anna@example.com' }]);
      expect(await listed(OTHER_WORKSPACE_ID)).toEqual([]);
      expect(await listed(WORKSPACE_ID, OTHER_USER_ID)).toEqual([]);

      await connect(PIETER);
      expect((await listed()).map((one) => one.displayName)).toEqual([
        'anna@example.com',
        'pieter@example.com',
      ]);
    });

    it('connecting the same mailbox again refreshes its row and its credential', async () => {
      await connect(ANNA, granted('the-first-refresh-token'));
      const [first] = await storedRows();

      await connect(ANNA, granted('the-second-refresh-token'));
      const after = await storedRows();

      expect(after).toHaveLength(1);
      expect(after[0]!.id).toBe(first!.id);
      expect(after[0]!.encrypted_credential).not.toBe(first!.encrypted_credential);
    });

    it('takes its Gmail connections with it when the workspace is deleted', async () => {
      await connect(ANNA);
      await connect(PIETER);

      const deleted = await asUser('http://cockpit.test/v1/commands/delete_workspace', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          commandId: '018f0000-0000-7000-8000-0000000724a1',
          issuedAt: '2026-10-04T10:00:00.000Z',
          workspaceId: WORKSPACE_ID,
        }),
      });

      expect(deleted.status).toBe(200);
      expect(await storedRows()).toEqual([]);
    });

    /**
     * Two tabs, or a double press: both reach the store at once, because the
     * issuer answers both together, and the unique index is what decides.
     */
    it('two tabs connecting the same mailbox at once leave one row', async () => {
      await issuerIsReachable();
      const session = await signInAs();
      const [one, two] = await Promise.all([
        startConnecting(WORKSPACE_ID, session),
        startConnecting(WORKSPACE_ID, session),
      ]);
      issuerWillIdentify({ ...ANNA, nonce: one.asked.searchParams.get('nonce')! }, 'code-one', granted('r1'));
      issuerWillIdentify({ ...ANNA, nonce: two.asked.searchParams.get('nonce')! }, 'code-two', granted('r2'));
      const together = issuerAnswersTogether(2);

      const both = Promise.all([
        comeBack({ code: 'code-one', state: one.asked.searchParams.get('state')! }, `${session}; ${one.attempt}`),
        comeBack({ code: 'code-two', state: two.asked.searchParams.get('state')! }, `${session}; ${two.attempt}`),
      ]);
      while (!together.allArrived()) await new Promise((resolve) => setTimeout(resolve, 5));
      together.answer();
      const answers = await both;

      expect(answers.map((res) => res.headers.get('location'))).toEqual([
        `/w/${WORKSPACE_ID}?connections=gmail-connected`,
        `/w/${WORKSPACE_ID}?connections=gmail-connected`,
      ]);
      expect(await storedRows()).toHaveLength(1);
    });
  });

  /** "Connect Gmail by star, and bring in conversations starred from then on", issue 822. */
  describe('a Gmail connection follows the one mark chosen to connect it, the label where none was chosen', () => {
    // Its row names the mark in Gmail's words ("Take source names out of the shared contract", issue 927).
    const BY_STAR = { follows: 'star', followsLabel: 'starred' };
    const BY_LABEL = { follows: 'label', followsLabel: 'label Cockpit' };
    it.each([
      { situation: 'by star', choosing: '?follows=star', row: BY_STAR, told: 'gmail-star-connected' },
      { situation: 'by label', choosing: '?follows=label', row: BY_LABEL, told: 'gmail-connected' },
      { situation: 'choosing nothing', choosing: '', row: BY_LABEL, told: 'gmail-connected' },
      { situation: 'choosing a mark there is not', choosing: '?follows=flag', row: BY_LABEL, told: 'gmail-connected' },
    ])('connected $situation, the row follows the $row.follows', async ({ choosing, row, told }) => {
      const back = await connect(ANNA, granted('a-refresh-token'), WORKSPACE_ID, choosing);

      expect(back.headers.get('location')).toBe(`/w/${WORKSPACE_ID}?connections=${told}`);
      expect(await listed()).toMatchObject([{ connectorId: 'gmail', ...row }]);
    });

    it('connecting the same mailbox again follows the mark chosen the second time', async () => {
      await connect(ANNA, granted('the-first-refresh-token'), WORKSPACE_ID, '?follows=star');
      await connect(ANNA, granted('the-second-refresh-token'));

      expect(await listed()).toMatchObject([{ follows: 'label' }]);
      expect(await storedRows()).toHaveLength(1);
    });
  });

  describe('connecting Gmail either stores one encrypted credential or nothing', () => {
    it('stores the sign-in encrypted, and nothing of it in the clear', async () => {
      await connect(ANNA, granted('the-refresh-token-itself'));

      const [row] = await storedRows();
      expect(row).toMatchObject({ connector_id: 'gmail', external_account_key: 'google-anna' });
      expect(row!.credential_nonce).not.toBe('');
      expect(row!.encrypted_credential).not.toContain('the-refresh-token-itself');
      const logged = await inTheStore((sql) => [
        ...sql.exec<{ payload: string }>("SELECT payload FROM commands WHERE name = 'connect_source_account'"),
      ]);
      expect(logged[0]!.payload).not.toContain(row!.encrypted_credential);
    });

    it.each([
      {
        situation: 'the consent screen is declined',
        reply: { error: 'access_denied' },
        answer: 'none' as const,
        told: 'cancelled',
      },
      {
        situation: 'Google refuses the sign-in for any other reason',
        reply: { error: 'admin_policy_enforced' },
        answer: 'none' as const,
        told: 'refused',
      },
      // A spent code, an expired one and a failed exchange are one answer
      // from Google, and so one case.
      {
        situation: 'Google refuses the code, spent, expired or otherwise',
        reply: { code: 'a-code' },
        answer: 'refused' as const,
        told: 'refused',
      },
      {
        situation: 'Google hands over no refresh token',
        reply: { code: 'a-code' },
        answer: (({ refresh_token: _none, ...rest }) => rest)(granted('x')) as Grant,
        told: 'gmail-no-refresh-token',
      },
      {
        situation: 'the permission to change mail is unticked on the consent screen',
        reply: { code: 'a-code' },
        answer: { ...granted('x'), scope: 'openid https://www.googleapis.com/auth/userinfo.email' } as Grant,
        told: 'gmail-permission-missing',
      },
    ])('refuses and stores nothing when $situation, saying why where you can act on it', async ({ reply, answer, told }) => {
      await issuerIsReachable();
      const session = await signInAs();
      const { asked, attempt } = await startConnecting(WORKSPACE_ID, session);
      if (answer === 'refused') issuerWillRefuseTheExchange();
      else if (answer !== 'none') issuerWillIdentify({ ...ANNA, nonce: asked.searchParams.get('nonce')! }, 'a-code', answer);

      const back = await comeBack({ ...reply, state: asked.searchParams.get('state')! }, `${session}; ${attempt}`);

      expect(back.headers.get('location')).toBe(`/w/${WORKSPACE_ID}?connections=${told}`);
      expect(await storedRows()).toEqual([]);
    });

    /** An unsolicited `?error=` proves nothing, so it cannot say cancelled either. */
    it('says refused, not cancelled, for a declined reply that does not match the attempt', async () => {
      await issuerIsReachable();
      const session = await signInAs();
      const { attempt } = await startConnecting(WORKSPACE_ID, session);

      const back = await comeBack({ error: 'access_denied', state: 'not-the-attempt' }, `${session}; ${attempt}`);

      expect(back.headers.get('location')).toBe(`/w/${WORKSPACE_ID}?connections=refused`);
    });

    it('refuses the same reply delivered twice by the back button, and connects once', async () => {
      await issuerIsReachable();
      const session = await signInAs();
      const { asked, attempt } = await startConnecting(WORKSPACE_ID, session);
      const reply = { code: 'a-code', state: asked.searchParams.get('state')! };
      issuerWillIdentify({ ...ANNA, nonce: asked.searchParams.get('nonce')! }, 'a-code', granted('r'));
      await comeBack(reply, `${session}; ${attempt}`);

      const again = await comeBack(reply, `${session}; ${attempt}`);

      expect(again.headers.get('location')).not.toContain('connected');
      expect(await storedRows()).toHaveLength(1);
    });

    /** A Teams attempt arriving at Gmail's door did not begin there. */
    it('refuses a reply to an attempt started for another source', async () => {
      await issuerIsReachable();
      const session = await signInAs();
      const teams = await SELF.fetch(`http://cockpit.test/v1/workspaces/${WORKSPACE_ID}/connections/teams/connect`, {
        redirect: 'manual',
        headers: { cookie: session },
      });
      const asked = new URL(teams.headers.get('location')!);
      const attempt = teams.headers.getSetCookie().map((cookie) => cookie.split(';')[0]!).find((cookie) => cookie.startsWith('cockpit_connect='))!;
      issuerWillIdentify({ ...ANNA, nonce: asked.searchParams.get('nonce')! }, 'a-code', granted('r'));

      const back = await comeBack({ code: 'a-code', state: asked.searchParams.get('state')! }, `${session}; ${attempt}`);

      expect(back.headers.get('location')).toBe('/');
      expect(await storedRows()).toEqual([]);
    });
  });

  describe('disconnecting Gmail forgets the sign-in and revokes it at Google', () => {
    it('takes the row and its credential, and hands the token back to Google', async () => {
      await connect(ANNA, granted('the-refresh-token-to-revoke'));
      const [anna] = await listed();

      const res = await disconnect(anna!.id, '018f0000-0000-7000-8000-0000000724b1');

      expect(res.status).toBe(200);
      expect(await storedRows()).toEqual([]);
      expect(revoked).toEqual(['the-refresh-token-to-revoke']);
    });

    /**
     * Google revokes the whole grant rather than one token, so a revoke here
     * would cut off the other Workspace's connection to the same mailbox.
     */
    it('leaves the sign-in at Google while another workspace still holds the mailbox', async () => {
      await connect(ANNA, granted('work-refresh-token'));
      await connect(ANNA, granted('atlas-refresh-token'), OTHER_WORKSPACE_ID);
      const [inWork] = await listed();
      const [inAtlas] = await listed(OTHER_WORKSPACE_ID);

      expect((await disconnect(inWork!.id, '018f0000-0000-7000-8000-0000000724b3')).status).toBe(200);
      expect(await listed()).toEqual([]);
      expect(await listed(OTHER_WORKSPACE_ID)).toHaveLength(1);
      expect(revoked).toEqual([]);

      expect((await disconnect(inAtlas!.id, '018f0000-0000-7000-8000-0000000724b4', OTHER_WORKSPACE_ID)).status).toBe(200);
      expect(revoked).toEqual(['atlas-refresh-token']);
    });

    it.each([
      { situation: 'Google refuses the revoke', how: 'refuses' as const },
      { situation: 'Google never answers the revoke', how: 'times out' as const },
    ])('still forgets it, and logs the failure, when $situation', async ({ how }) => {
      await connect(ANNA, granted('a-refresh-token'));
      const [anna] = await listed();
      issuerRevokes(how);
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const res = await disconnect(anna!.id, '018f0000-0000-7000-8000-0000000724b2');

        expect(res.status).toBe(200);
        expect(await storedRows()).toEqual([]);
        expect(revoked).toEqual(['a-refresh-token']);
        expect(logged.mock.calls.some(([line]) => String(line).includes('did not revoke a token'))).toBe(true);
      } finally {
        logged.mockRestore();
      }
    });
  });
});
