import { beforeEach, describe, expect, inject, it } from 'vitest';
import { SELF, applyD1Migrations, env } from 'cloudflare:test';
import type { AgentRun, CommandName, CommandPayload, WorkspaceSnapshot } from '@cockpit/shared';
import { ACCOUNT_NAME, WORKSPACE_ID, asUser, inTheStore, seedRegister, signInAs, startFromEmpty } from '../seed.js';

/**
 * Integration level, through the real Worker: a Run an Agent started before
 * Agents were retired ("Retire the agents' dock and routines, keeping what each
 * agent knew", issue 1165) is still the store's to read and its Item's Status
 * still ends it, and the address its session's hooks reported to answers
 * nothing. The Agent and its Run are written straight into the store, since
 * nothing can start one any more.
 */

const AT = '2026-10-17T10:00:00.000Z';
const AGENT_ID = '018f0000-0000-7000-a000-000000000001';
const RUN_ID = '018f0000-0000-7000-a000-000000000002';
const ROUTINE_ID = 'cn-routine';
const SESSION_URL = 'https://claude.ai/code/session_01EXAMPLE';

let seq = 0;
const nextId = () => {
  seq += 1;
  return `018f0000-0000-7000-b000-${String(seq).padStart(12, '0')}`;
};

async function postChange<N extends CommandName>(name: N, payload: Omit<CommandPayload<N>, 'commandId' | 'issuedAt'>) {
  return asUser(`http://cockpit.test/v1/commands/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ commandId: nextId(), issuedAt: AT, ...payload }),
  });
}

async function runOn(itemId: string): Promise<AgentRun | undefined> {
  const res = await asUser(`http://cockpit.test/v1/workspaces/${WORKSPACE_ID}/snapshot`);
  expect(res.status).toBe(200);
  return ((await res.json()) as WorkspaceSnapshot).agentRuns.find((run) => run.itemId === itemId);
}

/** An Item with a Run "Scope in Cockpit" started on it through a routine connection, as an account holds one from before. */
async function anAgentsRun(): Promise<string> {
  const itemId = nextId();
  expect((await postChange('capture_item', { workspaceId: WORKSPACE_ID, itemId, message: 'Scope the export' })).status).toBe(200);
  await inTheStore((sql) => {
    sql.exec(
      `INSERT INTO agents (id, tenant_id, name, folded_name, color, engine, message, asks_for_prompt, starts_in_progress, position, created_at)
       VALUES (?, ?, 'Scope in Cockpit', 'scope in cockpit', '#6f62b5', 'claude-code', '/scoping {title}: {description}', 0, 0, 0, ?)`,
      AGENT_ID,
      ACCOUNT_NAME,
      AT,
    );
    sql.exec(
      `INSERT INTO agent_runs (id, tenant_id, workspace_id, item_id, agent_id, status, session_url, started_at, settled_at)
       VALUES (?, ?, ?, ?, ?, 'working', ?, ?, ?)`,
      RUN_ID,
      ACCOUNT_NAME,
      WORKSPACE_ID,
      itemId,
      AGENT_ID,
      SESSION_URL,
      AT,
      AT,
    );
  });
  return itemId;
}

beforeEach(async () => {
  await applyD1Migrations(env.DB, inject('migrations'));
  await startFromEmpty();
  await seedRegister();
  await signInAs();
});

describe('Agents', () => {
  describe('a Run an Agent started stays readable, naming its Agent, until its Item’s Status ends it', () => {
    it('is on its Item, naming the Agent, and Done ends it', async () => {
      const itemId = await anAgentsRun();

      expect(await runOn(itemId)).toMatchObject({
        id: RUN_ID,
        agentName: 'Scope in Cockpit',
        status: 'working',
        sessionUrl: SESSION_URL,
        destination: null,
      });

      expect((await postChange('set_done', { workspaceId: WORKSPACE_ID, itemId, done: true })).status).toBe(200);

      expect(await runOn(itemId)).toBeUndefined();
      const ended = await inTheStore((sql) =>
        sql.exec<{ ended_at: string | null }>('SELECT ended_at FROM agent_runs WHERE id = ?', RUN_ID).one().ended_at,
      );
      expect(ended).not.toBeNull();
    });
  });

  describe('a hook arriving for an old session is refused, and nothing changes', () => {
    it('answers not found, and the Run is neither waiting nor otherwise touched', async () => {
      const itemId = await anAgentsRun();
      const before = await runOn(itemId);

      const answer = await SELF.fetch(`http://cockpit.test/ingress/claude-code/hooks/${ROUTINE_ID}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer a-hook-secret' },
        body: JSON.stringify({ session_id: 'session_01EXAMPLE', hook_event_name: 'Stop' }),
      });

      expect(answer.status).toBe(404);
      expect(await runOn(itemId)).toEqual(before);
      expect(before?.waiting).toBe(false);
      const reported = await inTheStore((sql) => sql.exec<{ n: number }>('SELECT count(*) AS n FROM agent_run_activity').one().n);
      expect(reported).toBe(0);
    });
  });
});
