import { afterEach, beforeEach, describe, expect, inject, it, vi } from 'vitest';
import { SELF, applyD1Migrations, env } from 'cloudflare:test';
import { ACCOUNT_WIDE, AGENT_COLORS } from '@cockpit/shared';
import type { AgentRun, ClaudeCodeHooks, CommandName, CommandPayload, SourceAccount, WorkspaceSnapshot } from '@cockpit/shared';
import {
  DASHBOARD_ID,
  TASK_TYPE_ID,
  USER_ID,
  WORKSPACE_ID,
  alsoWorkspaces,
  asUser,
  seedRegister,
  signInAs,
  startFromEmpty,
} from '../seed.js';

/**
 * Integration level, through the real Worker: a Claude Code hook arriving
 * with no sign-in, and what it moves in the account's own store ("See on the
 * item when Claude is waiting on you", issue 572). The route is outside the
 * sign-in gate, so its own checks are the only door - which only holds
 * entered the way a hook enters it. Claude is faked at the network boundary
 * for the start the runs come from, as agent-runs.test.ts does.
 *
 * Not re-proved here: which ids name a session, and the secret's own checks,
 * which are tests/unit/connectors/claude-code-hooks.test.ts's and
 * packages/shared's; what the chip and the dock say, which is the web app's
 * own F1 tests.
 */

const ATLAS = 'ws-atlas';
const ROUTINE_URL = 'https://api.anthropic.com/v1/claude_code/routines/trig_workspace/fire';
const SESSION_ID = 'session_01EXAMPLE';
const SESSION_URL = `https://claude.ai/code/${SESSION_ID}`;
const AT = '2026-09-29T10:00:00.000Z';

let seq = 0;
const nextId = () => {
  seq += 1;
  return `018f0000-0000-7000-8000-${String(seq).padStart(12, '0')}`;
};

function claudeOnTheNetwork() {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith('https://api.anthropic.com/')) throw new Error(`nothing in a test may reach ${url}`);
    return new Response(JSON.stringify({ claude_code_session_id: SESSION_ID, claude_code_session_url: SESSION_URL }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
}

async function postChange<N extends CommandName>(name: N, payload: Omit<CommandPayload<N>, 'commandId' | 'issuedAt'>) {
  const res = await asUser(`http://cockpit.test/v1/commands/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ commandId: nextId(), issuedAt: AT, ...payload }),
  });
  expect(res.status).toBe(200);
}

async function connectClaudeCode(workspaceId: string): Promise<string> {
  const res = await asUser(`http://cockpit.test/v1/workspaces/${workspaceId}/connections/claude-code/connect`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ routineUrl: ROUTINE_URL, token: 'a-routine-token' }),
  });
  expect(await res.json()).toEqual({ accepted: true });
  const list = await asUser(`http://cockpit.test/v1/workspaces/${workspaceId}/connections`);
  const { sourceAccounts } = (await list.json()) as { sourceAccounts: SourceAccount[] };
  return sourceAccounts.find((account) => account.connectorId === 'claude-code')!.id;
}

async function hooksFor(workspaceId: string, sourceAccountId: string): Promise<ClaudeCodeHooks> {
  const res = await asUser(
    `http://cockpit.test/v1/workspaces/${workspaceId}/connections/claude-code/${sourceAccountId}/hooks`,
    { method: 'POST' },
  );
  expect(res.status).toBe(200);
  return (await res.json()) as ClaudeCodeHooks;
}

/** A run working on an Item on the Dashboard, its session the one Claude answered with. */
async function aWorkingRun(): Promise<{ itemId: string; runId: string }> {
  const agentId = nextId();
  await postChange('create_agent', {
    workspaceId: ACCOUNT_WIDE,
    agentId,
    name: `Scope it ${seq}`,
    color: AGENT_COLORS[0]!,
    engine: 'claude-code',
    message: '{title}',
    asksForPrompt: false,
    startsInProgress: false,
  });
  const panelId = nextId();
  await postChange('add_panel', { workspaceId: WORKSPACE_ID, dashboardId: DASHBOARD_ID, panelId, name: `Now ${seq}`, kind: 'items' });
  const itemId = nextId();
  await postChange('capture_item', { workspaceId: WORKSPACE_ID, itemId, message: 'Chase the invoice', typeId: TASK_TYPE_ID });
  await postChange('move_item_to_panel', { workspaceId: WORKSPACE_ID, itemId, panelId, order: [itemId] });
  const runId = nextId();
  const res = await asUser(`http://cockpit.test/v1/workspaces/${WORKSPACE_ID}/items/${itemId}/agent-runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ commandId: nextId(), issuedAt: AT, runId, agentId, dashboardId: DASHBOARD_ID }),
  });
  expect(await res.json()).toEqual({ alreadyStarted: false, status: 'working' });
  return { itemId, runId };
}

/** A hook as Claude Code posts it: no cookie, the secret in a header, the hook's input as the body. */
function hook(
  url: string,
  secret: string | null,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return SELF.fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(secret === null ? {} : { authorization: `Bearer ${secret}` }),
      ...headers,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function snapshot(): Promise<WorkspaceSnapshot> {
  const res = await asUser(`http://cockpit.test/v1/workspaces/${WORKSPACE_ID}/snapshot`);
  return (await res.json()) as WorkspaceSnapshot;
}

async function runOn(itemId: string): Promise<AgentRun | undefined> {
  return (await snapshot()).agentRuns.find((run) => run.itemId === itemId);
}

const stop = (sessionId = SESSION_ID) => ({ session_id: sessionId, hook_event_name: 'Stop' });
const prompt = (sessionId = SESSION_ID) => ({ session_id: sessionId, hook_event_name: 'UserPromptSubmit' });

let connectionId: string;
let hooks: ClaudeCodeHooks;

beforeEach(async () => {
  await applyD1Migrations(env.DB, inject('migrations'));
  await startFromEmpty();
  await seedRegister();
  await alsoWorkspaces();
  // Signed in before Claude is put on the network, for the reason
  // agent-runs.test.ts gives: a first sign-in stubs fetch itself.
  await signInAs(USER_ID);
  claudeOnTheNetwork();
  connectionId = await connectClaudeCode(WORKSPACE_ID);
  hooks = await hooksFor(WORKSPACE_ID, connectionId);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Agents', () => {
  describe('a hook moves the run whose session it names, and nothing else', () => {
    it('says the run is waiting on you at Stop, and working again at the next prompt', async () => {
      const { itemId } = await aWorkingRun();

      expect((await hook(hooks.url, hooks.secret, stop())).status).toBe(204);
      expect(await runOn(itemId)).toMatchObject({ status: 'working', waiting: true });

      expect((await hook(hooks.url, hooks.secret, prompt())).status).toBe(204);
      expect(await runOn(itemId)).toMatchObject({ status: 'working', waiting: false });
    });

    it('knows the session by the id in its header, where the body names another', async () => {
      const { itemId } = await aWorkingRun();

      await hook(hooks.url, hooks.secret, stop('a-local-session'), { 'x-claude-code-remote-session': SESSION_ID });

      expect((await runOn(itemId))?.waiting).toBe(true);
    });

    it.each([
      { situation: 'another Claude session in the repository', body: stop('session_01SOMEONEELSE'), status: 204 },
      { situation: 'a hook that is neither Stop nor a prompt', body: { session_id: SESSION_ID, hook_event_name: 'PreToolUse' }, status: 204 },
    ])('ignores $situation', async ({ body, status }) => {
      const { itemId } = await aWorkingRun();

      expect((await hook(hooks.url, hooks.secret, body)).status).toBe(status);
      expect((await runOn(itemId))?.waiting).toBe(false);
    });

    it('ignores a run somebody already said finished', async () => {
      const { itemId, runId } = await aWorkingRun();
      await postChange('finish_agent_run', { workspaceId: WORKSPACE_ID, runId, itemId, outcome: 'still_to_do' });

      expect((await hook(hooks.url, hooks.secret, stop())).status).toBe(204);
      expect((await snapshot()).agentRuns.some((run) => run.waiting)).toBe(false);
    });

    it.each([
      { situation: 'a wrong secret', secret: 'bm90LXRoZS1zZWNyZXQtYXQtYWxsLW5vdC1ldmVuLWNsb3Nl' },
      { situation: 'no secret', secret: null },
    ])('refuses $situation, and changes nothing', async ({ secret }) => {
      const { itemId } = await aWorkingRun();

      expect((await hook(hooks.url, secret, stop())).status).toBe(401);
      expect((await runOn(itemId))?.waiting).toBe(false);
      expect((await hooksFor(WORKSPACE_ID, connectionId)).lastArrivedAt).toBeNull();
    });

    it('says on the connection when a hook last arrived, whether or not it moved a run', async () => {
      expect(hooks.lastArrivedAt).toBeNull();

      await hook(hooks.url, hooks.secret, stop('session_01SOMEONEELSE'));

      expect((await hooksFor(WORKSPACE_ID, connectionId)).lastArrivedAt).not.toBeNull();
    });
  });

  describe('the hooks’ address is its own door', () => {
    it('refuses a body over the size limit, and changes nothing', async () => {
      const { itemId } = await aWorkingRun();
      const huge = JSON.stringify({ ...stop(), last_assistant_message: 'x'.repeat(1024 * 1024) });

      expect((await hook(hooks.url, hooks.secret, huge)).status).toBe(413);
      expect((await runOn(itemId))?.waiting).toBe(false);
    });

    it('refuses the secret of another workspace’s connection', async () => {
      const { itemId } = await aWorkingRun();
      const atlas = await hooksFor(ATLAS, await connectClaudeCode(ATLAS));

      expect((await hook(hooks.url, atlas.secret, stop())).status).toBe(401);
      expect((await runOn(itemId))?.waiting).toBe(false);
    });

    it('refuses a flood from one connection once it passes the limit', async () => {
      const answers: number[] = [];
      for (let i = 0; i < 61; i += 1) answers.push((await hook(hooks.url, hooks.secret, stop('session_01QUIET'))).status);

      expect(answers.slice(0, 60).every((status) => status === 204)).toBe(true);
      expect(answers[60]).toBe(429);
    });

    it('refuses a connection that has since been disconnected', async () => {
      await postChange('disconnect_source_account', { workspaceId: WORKSPACE_ID, sourceAccountId: connectionId });

      expect((await hook(hooks.url, hooks.secret, stop())).status).toBe(404);
    });
  });
});
