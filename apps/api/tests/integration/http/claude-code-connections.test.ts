import { afterEach, beforeEach, describe, expect, inject, it, vi } from 'vitest';
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

/**
 * Integration level, through the real Worker: every rule here is about what
 * actually ends up stored, what the routine trigger address is checked
 * against, and what one Workspace can see of another's ("Connect a workspace
 * to Claude Code", issue 569). Claude is faked at the network boundary - the
 * application makes its own real HTTP call, exactly as it does against
 * Microsoft in connections.test.ts - and nothing here re-proves
 * `isRoutineTriggerUrl`'s own branches, which is
 * tests/unit/engines/claude-code.test.ts's.
 */

const OTHER_WORKSPACE_ID = 'ws-atlas';
const ROUTINE_URL = 'https://api.anthropic.com/v1/claude_code/routines/rt-workspace-1/fire';

interface StoredRow extends Record<string, string | null> {
  id: string;
  workspace_id: string;
  connector_id: string;
  external_account_key: string;
  display_name: string;
  encrypted_credential: string;
  credential_nonce: string;
  connected_at: string;
  updated_at: string;
  last_tested_at: string | null;
}

function storedRows(): Promise<StoredRow[]> {
  return inTheStore((sql) => [
    ...sql.exec<StoredRow>(
      "SELECT * FROM connector_accounts WHERE connector_id = 'claude-code' ORDER BY connected_at",
    ),
  ]);
}

/** Puts a fake Claude Code on the network, answering every call the same way. */
function claudeCodeAnswers(answer: { status: number } | { unreachable: true }) {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith('https://api.anthropic.com/')) {
      throw new Error(`nothing in a test may reach ${url}`);
    }
    if ('unreachable' in answer) throw new Error('the network is down');
    return new Response(null, { status: answer.status });
  });
}

function connectClaudeCode(
  routineUrl: string,
  token: string,
  workspaceId = WORKSPACE_ID,
  userId = USER_ID,
): Promise<Response> {
  return asUser(
    `http://cockpit.test/v1/workspaces/${workspaceId}/connections/claude-code/connect`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ routineUrl, token }),
    },
    userId,
  );
}

function testAgain(
  sourceAccountId: string,
  workspaceId = WORKSPACE_ID,
  userId = USER_ID,
): Promise<Response> {
  return asUser(
    `http://cockpit.test/v1/workspaces/${workspaceId}/connections/claude-code/${sourceAccountId}/test`,
    { method: 'POST' },
    userId,
  );
}

async function listed(
  workspaceId = WORKSPACE_ID,
  userId = USER_ID,
): Promise<{ id: string; displayName: string; connectorId: string; lastTestedAt: string | null }[]> {
  const res = await asUser(
    `http://cockpit.test/v1/workspaces/${workspaceId}/connections`,
    {},
    userId,
  );
  expect(res.status).toBe(200);
  return (
    (await res.json()) as {
      sourceAccounts: {
        id: string;
        displayName: string;
        connectorId: string;
        lastTestedAt: string | null;
      }[];
    }
  ).sourceAccounts;
}

beforeEach(async () => {
  await applyD1Migrations(env.DB, inject('migrations'));
  await startFromEmpty();
  await seedRegister();
  await alsoWorkspaces();
  // Signing in stubs `fetch` to the issuer alone, and does it again on every
  // *first* sign-in for a user id (`signInAs`, seed.ts) - so both accounts
  // are signed in here, before any case installs its own Claude Code stub,
  // rather than each case's own `asUser` call re-stubbing fetch to the
  // issuer right before the request `claudeCodeAnswers` below was meant to
  // answer.
  await signInAs(USER_ID);
  await signInAs(OTHER_USER_ID);
});

describe('Connector management', () => {
  describe('a connection is stored only after Claude accepted its test', () => {
    it('stores it, sealed, once Claude accepts', async () => {
      claudeCodeAnswers({ status: 200 });

      const res = await connectClaudeCode(ROUTINE_URL, 'a-real-token');

      expect({ status: res.status, said: await res.json() }).toEqual({
        status: 200,
        said: { accepted: true },
      });
      const [row] = await storedRows();
      expect(row).toMatchObject({ workspace_id: WORKSPACE_ID, connector_id: 'claude-code' });
      expect(row!.encrypted_credential).not.toContain('a-real-token');
      expect(row!.encrypted_credential).not.toContain(ROUTINE_URL);
      expect(row!.last_tested_at).toBe(row!.connected_at);
    });

    it.each([
      { situation: '401', answer: { status: 401 }, message: 'The token is wrong or was revoked.' },
      { situation: '404', answer: { status: 404 }, message: 'That routine no longer exists.' },
      {
        situation: '429',
        answer: { status: 429 },
        message: "Claude's limit for starting sessions was reached - try again later.",
      },
      {
        situation: 'unreachable',
        answer: { unreachable: true as const },
        message: 'Claude could not be reached.',
      },
    ])('stores nothing, and says why, when Claude answers $situation', async ({ answer, message }) => {
      claudeCodeAnswers(answer);

      const res = await connectClaudeCode(ROUTINE_URL, 'a-token');

      expect({ status: res.status, said: await res.json() }).toEqual({
        status: 200,
        said: { accepted: false, message },
      });
      expect(await storedRows()).toEqual([]);
    });
  });

  describe('only an address of Anthropic’s routine trigger is ever called', () => {
    it('refuses a different address before any call is made', async () => {
      const reached = vi.fn();
      vi.stubGlobal('fetch', reached);

      const res = await connectClaudeCode('https://evil.example.com/fire', 'a-token');

      expect(await res.json()).toMatchObject({ accepted: false });
      expect(reached).not.toHaveBeenCalled();
      expect(await storedRows()).toEqual([]);
    });
  });

  describe('the token never leaves the server once stored', () => {
    it('never appears in the connections list', async () => {
      claudeCodeAnswers({ status: 200 });
      await connectClaudeCode(ROUTINE_URL, 'a-secret-token');

      const rows = await listed();

      expect(JSON.stringify(rows)).not.toContain('a-secret-token');
      expect(rows[0]).not.toHaveProperty('token');
    });

    it('is stored encrypted, never as the routine address or the token in the clear', async () => {
      claudeCodeAnswers({ status: 200 });
      await connectClaudeCode(ROUTINE_URL, 'a-secret-token');

      const [row] = await storedRows();

      expect(row!.encrypted_credential).not.toContain('a-secret-token');
      expect(row!.encrypted_credential).not.toContain(ROUTINE_URL);
    });
  });

  describe('the window lists what is connected, then what can be added', () => {
    it('lists the workspace’s Claude Code connection with its connector id', async () => {
      claudeCodeAnswers({ status: 200 });
      await connectClaudeCode(ROUTINE_URL, 'a-token');

      const [row] = await listed();

      expect(row).toMatchObject({ connectorId: 'claude-code', displayName: 'Claude Code' });
      expect(row!.lastTestedAt).not.toBeNull();
    });
  });

  describe('a connected Claude Code can be tested, edited and disconnected', () => {
    it('updates when it last worked once Test again is accepted', async () => {
      claudeCodeAnswers({ status: 200 });
      await connectClaudeCode(ROUTINE_URL, 'a-token');
      const { id, lastTestedAt: connectedAt } = (await listed())[0]!;
      await new Promise((resolve) => setTimeout(resolve, 5));

      const res = await testAgain(id);

      expect(await res.json()).toEqual({ accepted: true });
      const { lastTestedAt: testedAt } = (await listed())[0]!;
      expect(testedAt! >= connectedAt!).toBe(true);
    });

    it('leaves the stored connection untouched when Test again is refused', async () => {
      claudeCodeAnswers({ status: 200 });
      await connectClaudeCode(ROUTINE_URL, 'a-token');
      const [before] = await storedRows();
      claudeCodeAnswers({ status: 401 });

      const res = await testAgain(before!.id);

      expect(await res.json()).toEqual({
        accepted: false,
        message: 'The token is wrong or was revoked.',
      });
      const [after] = await storedRows();
      expect(after).toEqual(before);
    });

    it('stores the new token when Edit… is accepted, refreshing the same row', async () => {
      claudeCodeAnswers({ status: 200 });
      await connectClaudeCode(ROUTINE_URL, 'a-token');
      const [before] = await storedRows();

      const res = await connectClaudeCode(ROUTINE_URL, 'a-new-token');

      expect(await res.json()).toEqual({ accepted: true });
      const rows = await storedRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.id).toBe(before!.id);
      expect(rows[0]!.encrypted_credential).not.toBe(before!.encrypted_credential);
    });

    it('keeps the old connection when Edit… is refused', async () => {
      claudeCodeAnswers({ status: 200 });
      await connectClaudeCode(ROUTINE_URL, 'a-token');
      const [before] = await storedRows();
      claudeCodeAnswers({ status: 404 });

      const res = await connectClaudeCode(ROUTINE_URL, 'a-new-token');

      expect(await res.json()).toMatchObject({ accepted: false });
      const [after] = await storedRows();
      expect(after).toEqual(before);
    });

    it('asks before disconnecting nothing here, but disconnecting still takes the row and the credential together', async () => {
      claudeCodeAnswers({ status: 200 });
      await connectClaudeCode(ROUTINE_URL, 'a-token');
      const { id } = (await listed())[0]!;

      const res = await asUser('http://cockpit.test/v1/commands/disconnect_source_account', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          commandId: '018f0000-0000-7000-8000-0000000005a1',
          issuedAt: '2026-09-28T10:00:00.000Z',
          workspaceId: WORKSPACE_ID,
          sourceAccountId: id,
        }),
      });

      expect(res.status).toBe(200);
      expect(await storedRows()).toEqual([]);
    });
  });

  describe('a connection belongs to one workspace', () => {
    it('refuses to connect for a workspace this account does not have', async () => {
      claudeCodeAnswers({ status: 200 });

      const res = await connectClaudeCode(ROUTINE_URL, 'a-token', 'ws-nobody-has');

      expect(res.status).toBe(404);
      expect(await storedRows()).toEqual([]);
    });

    it('refuses to test a connection named from a workspace it does not belong to', async () => {
      claudeCodeAnswers({ status: 200 });
      await connectClaudeCode(ROUTINE_URL, 'a-token');
      const { id } = (await listed())[0]!;

      const res = await testAgain(id, OTHER_WORKSPACE_ID);

      expect(res.status).toBe(404);
    });

    it('is not another account’s to test, whatever id it names', async () => {
      claudeCodeAnswers({ status: 200 });
      await connectClaudeCode(ROUTINE_URL, 'a-token');
      const { id } = (await listed())[0]!;

      const res = await testAgain(id, WORKSPACE_ID, OTHER_USER_ID);

      expect(res.status).toBe(404);
    });

    it('refuses a second Claude Code connection on the same workspace by refreshing the first instead', async () => {
      claudeCodeAnswers({ status: 200 });
      await connectClaudeCode(ROUTINE_URL, 'a-token');
      await connectClaudeCode(ROUTINE_URL, 'a-token');

      expect(await storedRows()).toHaveLength(1);
    });

    it('is a connection per workspace, not one the workspaces share', async () => {
      claudeCodeAnswers({ status: 200 });
      await connectClaudeCode(ROUTINE_URL, 'a-token');
      await connectClaudeCode(ROUTINE_URL, 'another-token', OTHER_WORKSPACE_ID);

      expect((await listed()).map((row) => row.connectorId)).toEqual(['claude-code']);
      expect((await listed(OTHER_WORKSPACE_ID)).map((row) => row.connectorId)).toEqual([
        'claude-code',
      ]);
    });

    /**
     * The test route reads a Claude Code credential and fires it at Claude,
     * so a Teams row's id has to be refused the same way a wrong workspace
     * is - not treated as a connection to test (found in review).
     */
    it('refuses to test a row that is not a Claude Code connection at all', async () => {
      const teamsRowId = await inTheStore((sql) => {
        const id = 'cn-teams-1';
        sql.exec(
          `INSERT INTO connector_accounts
            (id, tenant_id, workspace_id, connector_id, external_account_key,
             display_name, encrypted_credential, credential_nonce, connected_at, updated_at)
           VALUES (?, 'tenant-default', ?, 'teams', 'a-tenant:somebody',
                   'Somebody at Microsoft', 'c2VhbGVk', 'bm9uY2UtMTItYnl0', ?, ?)`,
          id,
          WORKSPACE_ID,
          '2026-09-28T10:00:00.000Z',
          '2026-09-28T10:00:00.000Z',
        );
        return id;
      });

      const res = await testAgain(teamsRowId);

      expect(res.status).toBe(404);
    });
  });

  describe('a routine trigger URL and token too long to be genuine are refused', () => {
    it('refuses a token past a sane length, before any call is made', async () => {
      const reached = vi.fn();
      vi.stubGlobal('fetch', reached);

      const res = await connectClaudeCode(ROUTINE_URL, 'x'.repeat(4097));

      expect(res.status).toBe(400);
      expect(reached).not.toHaveBeenCalled();
      expect(await storedRows()).toEqual([]);
    });

    it('refuses a routine URL past a sane length, before any call is made', async () => {
      const reached = vi.fn();
      vi.stubGlobal('fetch', reached);

      const res = await connectClaudeCode(
        `https://api.anthropic.com/v1/claude_code/routines/${'x'.repeat(2048)}/fire`,
        'a-token',
      );

      expect(res.status).toBe(400);
      expect(reached).not.toHaveBeenCalled();
      expect(await storedRows()).toEqual([]);
    });
  });

  describe('where the deployment cannot seal a credential', () => {
    beforeEach(() => {
      delete env.CONNECTOR_CREDENTIAL_KEY;
    });
    afterEach(() => {
      env.CONNECTOR_CREDENTIAL_KEY = 'Y29ja3BpdC10ZXN0LWNvbm5lY3Rvci1rZXktMDAwMDA=';
    });

    it('refuses without testing anything, and stores nothing', async () => {
      const reached = vi.fn();
      vi.stubGlobal('fetch', reached);

      const res = await connectClaudeCode(ROUTINE_URL, 'a-token');

      expect(await res.json()).toMatchObject({ accepted: false });
      expect(reached).not.toHaveBeenCalled();
      expect(await storedRows()).toEqual([]);
    });
  });
});
