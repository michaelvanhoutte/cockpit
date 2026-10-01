import { beforeEach, describe, expect, inject, it } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { ACCOUNT_WIDE, AGENT_COLORS } from '@cockpit/shared';
import type { Agent, CommandName, CommandPayload, HiddenAgent } from '@cockpit/shared';
import {
  DASHBOARD_ID,
  OTHER_USER_ID,
  WORKSPACE_ID,
  alsoWorkspaces,
  asUser,
  inTheStore,
  seedRegister,
  startFromEmpty,
} from '../seed.js';

/**
 * Integration level, through the real Worker, because every rule here is
 * about what a query returns or what an index refuses - whether a name is
 * taken, which Dashboards a hide reaches, whether a live Claude Code
 * connection is there ("Keep your agents in a dock, and choose which each
 * dashboard shows", issue 570). The message template's own placeholder
 * substitution is pure and has its own unit test in
 * packages/shared/tests/unit/domain/agent.test.ts.
 */

const OTHER_WORKSPACE_ID = 'ws-atlas';

async function postChange<N extends CommandName>(
  name: N,
  payload: CommandPayload<N>,
  userId?: string,
) {
  return asUser(
    `http://cockpit.test/v1/commands/${name}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    },
    userId,
  );
}

let seq = 0;
const nextId = () => {
  seq += 1;
  return `018f0000-0000-7000-8000-${String(seq).padStart(12, '0')}`;
};

const envelope = () => ({
  commandId: nextId(),
  issuedAt: '2026-09-28T10:00:00.000Z',
  workspaceId: ACCOUNT_WIDE,
});

async function snapshotFor(workspaceId: string = WORKSPACE_ID, userId?: string) {
  const response = await asUser(
    `http://cockpit.test/v1/workspaces/${workspaceId}/snapshot`,
    {},
    userId,
  );
  expect(response.status).toBe(200);
  return (await response.json()) as {
    agents: Agent[];
    hiddenAgents: HiddenAgent[];
    hasClaudeCodeConnection: boolean;
  };
}

async function theAgents(workspaceId: string = WORKSPACE_ID, userId?: string): Promise<Agent[]> {
  return (await snapshotFor(workspaceId, userId)).agents;
}

const named = async (name: string) => (await theAgents()).find((agent) => agent.name === name);

async function makeAgent(overrides: Partial<CommandPayload<'create_agent'>> = {}) {
  const agentId = overrides.agentId ?? nextId();
  const response = await postChange('create_agent', {
    ...envelope(),
    agentId,
    name: 'Scope it',
    color: AGENT_COLORS[0]!,
    engine: 'claude-code',
    message: '/scoping {title}\n\n{description}',
    asksForPrompt: false,
    startsInProgress: true,
    ...overrides,
  });
  return { agentId, response };
}

/** A live connection to Claude Code for one Workspace, written directly - the connect flow itself is claude-code-connections.test.ts's own. */
async function connectClaudeCodeTo(workspaceId: string) {
  await inTheStore((sql) =>
    sql.exec(
      `INSERT INTO connector_accounts
       (id, tenant_id, workspace_id, connector_id, external_account_key, display_name, encrypted_credential, credential_nonce, connected_at, updated_at)
       VALUES (?, 'tenant-default', ?, 'claude-code', 'rt-1', 'Claude Code', 'sealed', 'nonce', ?, ?)`,
      `conn-${workspaceId}`,
      workspaceId,
      '2026-09-28T09:00:00.000Z',
      '2026-09-28T09:00:00.000Z',
    ),
  );
}

beforeEach(async () => {
  await applyD1Migrations(env.DB, inject('migrations'));
  await startFromEmpty();
  await seedRegister();
  await alsoWorkspaces();
});

describe('Agents', () => {
  describe('agents are made, changed and deleted from the dock', () => {
    it('makes one, in the account', async () => {
      const { response } = await makeAgent({ name: 'Scope it' });

      expect(response.status).toBe(200);
      expect((await named('Scope it'))?.engine).toBe('claude-code');
    });

    it('changes every field a Save sends, together', async () => {
      const { agentId } = await makeAgent({ name: 'Scope it' });

      const response = await postChange('update_agent', {
        ...envelope(),
        agentId,
        name: 'Scope it well',
        color: AGENT_COLORS[3]!,
        message: '/scoping {title}',
        asksForPrompt: true,
        startsInProgress: false,
      });

      expect(response.status).toBe(200);
      const agent = await named('Scope it well');
      expect(agent).toMatchObject({
        color: AGENT_COLORS[3],
        message: '/scoping {title}',
        asksForPrompt: true,
        startsInProgress: false,
      });
    });

    it('deletes it, and gives its name back', async () => {
      const { agentId } = await makeAgent({ name: 'Scope it' });

      expect((await postChange('delete_agent', { ...envelope(), agentId })).status).toBe(200);

      expect(await named('Scope it')).toBeUndefined();
      expect(
        (await makeAgent({ name: 'Scope it' })).response.status,
        'the name is free again once the agent that held it is gone',
      ).toBe(200);
    });

    it.each([
      { situation: 'a name another agent already has', name: 'Ship it', answers: 409 },
      { situation: 'that name in another capitalisation', name: 'SHIP IT', answers: 409 },
      { situation: 'a name nothing has', name: 'Review it', answers: 200 },
    ])('making an agent with $situation', async ({ name, answers }) => {
      await makeAgent({ name: 'Ship it' });

      const { response } = await makeAgent({ name });

      expect(response.status).toBe(answers);
    });

    it('refuses a change to an agent that is not there, and stores nothing', async () => {
      const gone = '018f0000-0000-7000-8000-999999999999';
      const body = { ...envelope(), agentId: gone };

      const response = await postChange('delete_agent', body);

      expect(response.status).toBe(404);
      expect(
        await inTheStore((sql) =>
          sql.exec('SELECT * FROM commands WHERE command_id = ?', body.commandId).toArray(),
        ),
      ).toHaveLength(0);
    });
  });

  describe('agents belong to the account', () => {
    it('are shown in every workspace of the account', async () => {
      await makeAgent({ name: 'Scope it' });

      expect((await theAgents(WORKSPACE_ID)).map((a) => a.name)).toContain('Scope it');
      expect((await theAgents(OTHER_WORKSPACE_ID)).map((a) => a.name)).toContain('Scope it');
    });

    it('are invisible to another account', async () => {
      await makeAgent({ name: 'Scope it' });

      const others = await theAgents(WORKSPACE_ID, OTHER_USER_ID);

      expect(others.map((a) => a.name)).not.toContain('Scope it');
    });
  });

  describe('hiding and showing are per dashboard', () => {
    it('hides an agent on this dashboard only, and shows it again', async () => {
      const { agentId } = await makeAgent({ name: 'Scope it' });

      expect(
        (
          await postChange('hide_agent_on_dashboard', {
            commandId: nextId(),
            issuedAt: '2026-09-28T10:00:00.000Z',
            workspaceId: WORKSPACE_ID,
            agentId,
            dashboardId: DASHBOARD_ID,
          })
        ).status,
      ).toBe(200);

      let hidden = (await snapshotFor(WORKSPACE_ID)).hiddenAgents;
      expect(hidden).toContainEqual({ dashboardId: DASHBOARD_ID, agentId });

      expect(
        (
          await postChange('show_agent_on_dashboard', {
            commandId: nextId(),
            issuedAt: '2026-09-28T10:05:00.000Z',
            workspaceId: WORKSPACE_ID,
            agentId,
            dashboardId: DASHBOARD_ID,
          })
        ).status,
      ).toBe(200);

      hidden = (await snapshotFor(WORKSPACE_ID)).hiddenAgents;
      expect(hidden).not.toContainEqual({ dashboardId: DASHBOARD_ID, agentId });
    });

    it('is no longer listed as hidden once the agent itself is deleted', async () => {
      const { agentId } = await makeAgent({ name: 'Scope it' });
      await postChange('hide_agent_on_dashboard', {
        commandId: nextId(),
        issuedAt: '2026-09-28T10:00:00.000Z',
        workspaceId: WORKSPACE_ID,
        agentId,
        dashboardId: DASHBOARD_ID,
      });

      await postChange('delete_agent', { ...envelope(), agentId });

      expect(await theAgents()).toHaveLength(0);
      expect((await snapshotFor(WORKSPACE_ID)).hiddenAgents).toHaveLength(0);
    });
  });

  describe('a dashboard shows every agent except those hidden on it', () => {
    it('reports a live Claude Code connection per workspace', async () => {
      expect((await snapshotFor(WORKSPACE_ID)).hasClaudeCodeConnection).toBe(false);

      await connectClaudeCodeTo(WORKSPACE_ID);

      expect((await snapshotFor(WORKSPACE_ID)).hasClaudeCodeConnection).toBe(true);
      // Another Workspace's own connection is its own: this one still has none.
      expect((await snapshotFor(OTHER_WORKSPACE_ID)).hasClaudeCodeConnection).toBe(false);
    });

    it('has no account-wide switch to post, and none in the snapshot', async () => {
      const posted = await asUser('http://cockpit.test/v1/commands/set_ask_claude_enabled', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...envelope(), enabled: false }),
      });

      expect(posted.status).toBe(404);
      expect(await snapshotFor(WORKSPACE_ID)).not.toHaveProperty('askClaudeEnabled');
    });
  });
});
