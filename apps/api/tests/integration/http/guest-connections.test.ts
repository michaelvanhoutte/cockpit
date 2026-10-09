import { afterEach, beforeEach, describe, expect, inject, it, vi } from 'vitest';
import { SELF, applyD1Migrations, env } from 'cloudflare:test';
import type { Workspace } from '@cockpit/shared';
import { GUEST_ACCOUNT_NAME } from '../../../src/auth/register.js';
import {
  WORKSPACE_ID,
  asUser,
  inStoreAsItIs,
  seedRegister,
  startFromEmpty,
} from '../seed.js';
import { issuerIsForgotten } from '../issuer.js';
import {
  TEAMS_PERSON,
  TEAMS_TENANT,
  botFrameworkIsReachable,
  channelToken,
  saveToCockpitCall,
} from '../bot-framework.js';

/**
 * Integration level, through the real Worker, because the refusal depends on
 * the real session and gate ("Refuse every connection change from the guest
 * account", issue 772): the guest account is shared by every stranger who
 * presses "Continue as guest", so nothing they connect, change or push may
 * reach it. What the guest is shown instead is the web app's own F1 test.
 *
 * A connection is planted in the guest's store directly, because the way in
 * is exactly what is closed: only a row that is already there can show that a
 * disconnect, an edit or a push leaves it alone.
 */

const AT = '2026-10-05T10:00:00.000Z';
const ROUTINE_URL = 'https://api.anthropic.com/v1/claude_code/routines/trig_workspace/fire';

let seq = 0;
const nextId = () => {
  seq += 1;
  return `018f0000-0000-7000-8000-${String(seq).padStart(12, '0')}`;
};

/** Pressing "Continue as guest", and the cookie it hands back. */
async function continueAsGuest(): Promise<string> {
  const back = await SELF.fetch('http://cockpit.test/v1/sign-in/guest', { redirect: 'manual' });
  const cookie = back.headers
    .getSetCookie()
    .map((one) => one.split(';')[0]!)
    .find((one) => one.startsWith('cockpit_session='));
  expect(cookie, 'continuing as a guest set no session cookie').toBeDefined();
  return cookie!;
}

async function guestWorkspace(cookie: string): Promise<string> {
  const res = await SELF.fetch('http://cockpit.test/v1/workspaces', { headers: { cookie } });
  expect(res.status).toBe(200);
  return ((await res.json()) as { workspaces: Workspace[] }).workspaces[0]!.id;
}

interface Planted {
  id: string;
  connectorId: string;
}

/** A connection already sitting in the guest account's store, as the way in used to leave one. */
async function plantInGuestStore(workspaceId: string, connectorId: string, key: string): Promise<Planted> {
  const id = nextId();
  await inStoreAsItIs(GUEST_ACCOUNT_NAME, (sql) =>
    sql.exec(
      `INSERT INTO connector_accounts (id, tenant_id, workspace_id, connector_id, external_account_key, display_name,
         encrypted_credential, credential_nonce, connected_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'Planted', 'sealed', 'nonce', ?, ?)`,
      id,
      GUEST_ACCOUNT_NAME,
      workspaceId,
      connectorId,
      key,
      AT,
      AT,
    ),
  );
  return { id, connectorId };
}

/**
 * The connections the guest holds that the demo did not seed: every Workspace
 * arrives with a Gmail and a Teams row (issue 773, `DEMO_CONNECTION` in
 * accounts/changes.ts), and what is asked here is what a visitor adds.
 */
async function guestRows(): Promise<{ id: string; display_name: string; updated_at: string; follows: string }[]> {
  return inStoreAsItIs(GUEST_ACCOUNT_NAME, (sql) => [
    ...sql.exec<{ id: string; display_name: string; updated_at: string; follows: string }>(
      "SELECT id, display_name, updated_at, follows FROM connector_accounts WHERE id NOT LIKE '0e000000-%' ORDER BY id",
    ),
  ]);
}

/** The Claude Code connection the demo seeds in one Workspace. */
async function seededClaudeCode(workspaceId: string): Promise<Planted> {
  const [row] = await inStoreAsItIs(GUEST_ACCOUNT_NAME, (sql) => [
    ...sql.exec<{ id: string }>(
      "SELECT id FROM connector_accounts WHERE connector_id = 'claude-code' AND workspace_id = ?",
      workspaceId,
    ),
  ]);
  return { id: row!.id, connectorId: 'claude-code' };
}

/** Every Claude Code row the guest holds, as stored - what a refused change must leave exactly as it was. */
const claudeCodeRows = () =>
  inStoreAsItIs(GUEST_ACCOUNT_NAME, (sql) => [
    ...sql.exec("SELECT * FROM connector_accounts WHERE connector_id = 'claude-code' ORDER BY id"),
  ]);

/** The Teams items the guest holds that came from a message saved to Cockpit rather than from the demo. */
const savedFromTeams = (sql: SqlStorage) => [
  ...sql.exec(
    "SELECT id FROM items WHERE source_connector = ? AND COALESCE(source_link, '') NOT LIKE ?",
    'teams',
    'https://demo.cockpit.invalid/%',
  ),
];

function asGuest(cookie: string, path: string, init: RequestInit = {}): Promise<Response> {
  return SELF.fetch(`http://cockpit.test${path}`, {
    redirect: 'manual',
    ...init,
    headers: { ...((init.headers as Record<string, string>) ?? {}), cookie },
  });
}

const post = (body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

beforeEach(async () => {
  await applyD1Migrations(env.DB, inject('migrations'));
  await startFromEmpty();
  await seedRegister();
});

afterEach(() => {
  issuerIsForgotten();
  vi.unstubAllGlobals();
});

describe('Connector management', () => {
  describe('the guest can neither connect, change nor test any real account, and nothing is stored', () => {
    it.each([
      { situation: 'starts a Gmail connect', path: (ws: string) => `/v1/workspaces/${ws}/connections/gmail/connect` },
      { situation: 'starts a Teams connect', path: (ws: string) => `/v1/workspaces/${ws}/connections/teams/connect` },
      {
        situation: 'arrives at Gmail’s return with a valid-looking code',
        path: () => '/v1/connections/gmail/callback?code=a-code&state=a-state',
      },
      {
        situation: 'arrives at Teams’ return with a valid-looking code',
        path: () => '/v1/connections/teams/callback?code=a-code&state=a-state',
      },
    ])('refuses a guest who $situation', async ({ path }) => {
      const cookie = await continueAsGuest();
      const workspaceId = await guestWorkspace(cookie);

      const res = await asGuest(cookie, path(workspaceId));

      expect(res.status).toBe(403);
      expect(await guestRows()).toEqual([]);
    });

    it.each([
      { situation: 'disconnect', command: 'disconnect_source_account', extra: {} },
      // "Ask a connection's one choice on connecting, and change it later", issue 942.
      { situation: 'switch to the star', command: 'set_connection_choice', extra: { choice: 'star' } },
    ])('keeps the Gmail row the guest tries to $situation as it was', async ({ command, extra }) => {
      const cookie = await continueAsGuest();
      const workspaceId = await guestWorkspace(cookie);
      const planted = await plantInGuestStore(workspaceId, 'gmail', 'google-planted');
      const before = await guestRows();

      const res = await asGuest(
        cookie,
        `/v1/commands/${command}`,
        post({ commandId: nextId(), issuedAt: AT, workspaceId, sourceAccountId: planted.id, ...extra }),
      );

      expect(res.status).toBe(403);
      expect(await guestRows()).toEqual(before);
    });

    it('stores no Claude Code connection a guest creates, and leaves one already there as it was', async () => {
      const cookie = await continueAsGuest();
      const workspaceId = await guestWorkspace(cookie);
      const reached = vi.fn();
      vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
        reached(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
        throw new Error('nothing in a test may reach out');
      });
      const connect = `/v1/workspaces/${workspaceId}/connections/claude-code/connect`;

      const created = await asGuest(cookie, connect, post({ routineUrl: ROUTINE_URL, token: 'a-routine-token' }));
      expect(created.status).toBe(403);
      expect(await guestRows()).toEqual([]);

      // Seeded in every Workspace ("Show agents at work in the guest demo", issue 774), with a placeholder credential.
      const planted = await seededClaudeCode(workspaceId);
      const before = await claudeCodeRows();

      const edited = await asGuest(cookie, connect, post({ routineUrl: ROUTINE_URL, token: 'another-token' }));
      const tested = await asGuest(
        cookie,
        `/v1/workspaces/${workspaceId}/connections/claude-code/${planted.id}/test`,
        { method: 'POST' },
      );

      expect([edited.status, tested.status]).toEqual([403, 403]);
      expect(await claudeCodeRows()).toEqual(before);
      expect(reached).not.toHaveBeenCalled();
    });

    it('still lets a named person start a Gmail connect', async () => {
      const res = await asUser(`http://cockpit.test/v1/workspaces/${WORKSPACE_ID}/connections/gmail/connect?choice=label`, {
        redirect: 'manual',
      });

      expect(res.status).not.toBe(403);
    });
  });

  describe('a push addressed to the guest account changes nothing', () => {
    it('files no item for a Teams save that names a connection in the guest account', async () => {
      const cookie = await continueAsGuest();
      const workspaceId = await guestWorkspace(cookie);
      await plantInGuestStore(workspaceId, 'teams', `${TEAMS_TENANT}:${TEAMS_PERSON}`);
      await env.DB.prepare(
        `INSERT INTO connector_directory (connector_id, external_account_key, account_id, workspace_id, connected_at)
         VALUES ('teams', ?, ?, ?, ?)`,
      )
        .bind(`${TEAMS_TENANT}:${TEAMS_PERSON}`, GUEST_ACCOUNT_NAME, workspaceId, AT)
        .run();
      await botFrameworkIsReachable();

      const answer = await SELF.fetch('http://cockpit.test/ingress/teams/messages', {
        method: 'POST',
        headers: { authorization: `Bearer ${await channelToken()}`, 'content-type': 'application/json' },
        body: JSON.stringify(saveToCockpitCall()),
      });

      expect(answer.status).toBeLessThan(500);
      const saved = await inStoreAsItIs(GUEST_ACCOUNT_NAME, savedFromTeams);
      expect(saved).toEqual([]);
    });

    it('answers a Claude Code hook carrying the secret of a guest connection as having no such connection', async () => {
      const cookie = await continueAsGuest();
      const workspaceId = await guestWorkspace(cookie);
      const planted = await seededClaudeCode(workspaceId);
      await env.DB.prepare(
        `INSERT INTO connector_directory (connector_id, external_account_key, account_id, workspace_id, connected_at)
         VALUES ('claude-code-hooks', ?, ?, ?, ?)`,
      )
        .bind(planted.id, GUEST_ACCOUNT_NAME, workspaceId, AT)
        .run();
      const { hookSecretFor } = await import('../../../src/engines/claude-code-hooks.js');
      const secret = await hookSecretFor(env.CONNECTOR_CREDENTIAL_KEY, planted.id);

      const answer = await SELF.fetch(`http://cockpit.test/ingress/claude-code/hooks/${planted.id}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
        body: JSON.stringify({ session_id: 'session_01EXAMPLE', hook_event_name: 'Stop' }),
      });

      expect(answer.status).toBe(404);
    });
  });
});
