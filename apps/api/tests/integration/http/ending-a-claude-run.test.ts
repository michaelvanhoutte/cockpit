import { beforeEach, describe, expect, inject, it } from 'vitest';
import { applyD1Migrations, env } from 'cloudflare:test';
import type { AgentRun, CommandName, CommandPayload, Item, WorkspaceSnapshot } from '@cockpit/shared';
import {
  ACCOUNT_NAME,
  OTHER_USER_ID,
  USER_ID,
  WORKSPACE_ID,
  asUser,
  inTheStore,
  seedRegister,
  signInAs,
  startFromEmpty,
} from '../seed.js';

/**
 * Integration level, through the real Worker: ending a Claude run from its row
 * or the selection bar changes the run and nothing else on its Item, and its
 * Undo brings back exactly that run only while nothing has moved on ("End a
 * Claude run from its row, and make Needs you say what Claude is asking", issue
 * 1770). Not re-proved here: the replay of one command, which is every
 * command's; the chip and the menu, which are the web app's own tests.
 */

const AT = '2026-10-16T10:00:00.000Z';
const later = (seconds: number) => new Date(Date.parse(AT) + seconds * 1000).toISOString();

let seq = 0;
const nextId = () => {
  seq += 1;
  return `018f0000-0000-7000-9000-${String(seq).padStart(12, '0')}`;
};

async function postChange<N extends CommandName>(
  name: N,
  payload: Omit<CommandPayload<N>, 'commandId' | 'issuedAt'>,
  { userId = USER_ID, issuedAt = AT }: { userId?: string; issuedAt?: string } = {},
) {
  return asUser(
    `http://cockpit.test/v1/commands/${name}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ commandId: nextId(), issuedAt, ...payload }),
    },
    userId,
  );
}

async function snapshot(userId = USER_ID): Promise<WorkspaceSnapshot> {
  const res = await asUser(`http://cockpit.test/v1/workspaces/${WORKSPACE_ID}/snapshot`, {}, userId);
  expect(res.status).toBe(200);
  return (await res.json()) as WorkspaceSnapshot;
}

async function openRuns(itemId: string, userId = USER_ID): Promise<AgentRun[]> {
  return (await snapshot(userId)).agentRuns.filter((run) => run.itemId === itemId);
}

async function theItem(itemId: string): Promise<Item> {
  return (await snapshot()).items.find((item) => item.id === itemId)!;
}

async function anItem(message: string, userId = USER_ID): Promise<string> {
  const itemId = nextId();
  expect((await postChange('capture_item', { workspaceId: WORKSPACE_ID, itemId, message }, { userId })).status).toBe(200);
  return itemId;
}

/** An Item sent to Claude, and the run that made. */
async function sentItem(message = 'Chase the invoice', { issuedAt = AT, userId = USER_ID } = {}) {
  const itemId = await anItem(message, userId);
  const runId = nextId();
  const sent = await postChange(
    'send_item_to_claude',
    { workspaceId: WORKSPACE_ID, itemId, runId, destination: 'code', folder: 'C:\\GitHub\\Cockpit' },
    { userId, issuedAt },
  );
  expect(sent.status).toBe(200);
  return { itemId, runId };
}

const end = (itemId: string, runId: string | undefined, issuedAt = later(10), userId = USER_ID) =>
  postChange(
    'end_claude_run',
    { workspaceId: WORKSPACE_ID, itemId, ...(runId ? { runId } : {}) },
    { issuedAt, userId },
  );

const undoEnd = (itemId: string, runId: string, issuedAt = later(20)) =>
  postChange('end_claude_run', { workspaceId: WORKSPACE_ID, itemId, runId, reopen: true }, { issuedAt });

/** What Claude reported on a run, written as its report would (that command is the MCP tool's alone, with no route). */
async function reported(runId: string, report: { stage: string; sessionUrl?: string; resultUrl?: string; note?: string }) {
  await inTheStore((sql) => {
    sql.exec(
      'UPDATE agent_runs SET stage = ?, session_url = ?, result_url = ?, note = ? WHERE id = ?',
      report.stage,
      report.sessionUrl ?? null,
      report.resultUrl ?? null,
      report.note ?? null,
      runId,
    );
  });
}

async function endedAtOf(runId: string) {
  return inTheStore(
    (sql) => sql.exec<{ ended_at: string | null }>('SELECT ended_at FROM agent_runs WHERE id = ?', runId).one().ended_at,
  );
}

beforeEach(async () => {
  await applyD1Migrations(env.DB, inject('migrations'));
  await startFromEmpty();
  await seedRegister();
  await signInAs(USER_ID);
  await signInAs(OTHER_USER_ID);
});

describe('Agents', () => {
  describe('ending a Claude run ends that Item’s open run and changes nothing else on it', () => {
    it.each([
      {
        situation: 'a To do Item with a Ready run',
        prepare: async (_itemId: string, runId: string) =>
          reported(runId, { stage: 'ready', resultUrl: 'https://example.com/draft', note: 'Two drafts' }),
      },
      {
        situation: 'an In progress Item',
        prepare: async (itemId: string) => {
          await postChange('set_started', { workspaceId: WORKSPACE_ID, itemId, started: true }, { issuedAt: later(1) });
        },
      },
      {
        situation: 'an Item Waiting for reply',
        prepare: async (itemId: string) => {
          await postChange(
            'wait_for_reply',
            { workspaceId: WORKSPACE_ID, itemId, days: 3, timeZone: 'Europe/Brussels' },
            { issuedAt: later(1) },
          );
        },
      },
    ])('ends the run on $situation and leaves its Status, Panels, due date and priority', async ({ prepare }) => {
      const { itemId, runId } = await sentItem();
      await postChange('set_priority', { workspaceId: WORKSPACE_ID, itemId, priority: 'high' }, { issuedAt: later(1) });
      await prepare(itemId, runId);
      const before = await theItem(itemId);

      const res = await end(itemId, runId);

      expect(res.status).toBe(200);
      expect(await openRuns(itemId)).toEqual([]);
      expect(await endedAtOf(runId)).toBe(later(10));
      const { updatedAt: _a, ...kept } = before;
      expect(await theItem(itemId)).toMatchObject(kept);
    });

    it('ends the run an Agent started before Agents were retired the same way', async () => {
      const itemId = await anItem('Scope the export');
      const agentId = nextId();
      const runId = nextId();
      await inTheStore((sql) => {
        sql.exec(
          `INSERT INTO agents (id, tenant_id, name, folded_name, color, engine, message, asks_for_prompt, starts_in_progress, position, created_at)
           VALUES (?, ?, 'Scope in Cockpit', 'scope in cockpit', '#6f62b5', 'claude-code', '/scoping {title}', 0, 0, 0, ?)`,
          agentId,
          ACCOUNT_NAME,
          AT,
        );
        sql.exec(
          `INSERT INTO agent_runs (id, tenant_id, workspace_id, item_id, agent_id, status, started_at, settled_at)
           VALUES (?, ?, ?, ?, ?, 'working', ?, ?)`,
          runId,
          ACCOUNT_NAME,
          WORKSPACE_ID,
          itemId,
          agentId,
          AT,
          AT,
        );
      });
      expect(await openRuns(itemId)).toHaveLength(1);

      expect((await end(itemId, runId)).status).toBe(200);

      expect(await openRuns(itemId)).toEqual([]);
    });

    it('takes an Item with no open run, and a run already ended, and changes nothing', async () => {
      const bare = await anItem('Nothing sent');
      const { itemId, runId } = await sentItem();
      expect((await end(itemId, runId)).status).toBe(200);

      const noRun = await end(bare, undefined);
      const again = await end(itemId, runId, later(30));

      expect([noRun.status, again.status]).toEqual([200, 200]);
      expect(await endedAtOf(runId)).toBe(later(10));
    });

    it('ends the Item’s open run where the command names none', async () => {
      const { itemId, runId } = await sentItem();

      expect((await end(itemId, undefined)).status).toBe(200);

      expect(await endedAtOf(runId)).toBe(later(10));
    });

    it.each([
      { situation: 'another Item', as: 'item' as const },
      { situation: 'another account', as: 'account' as const },
    ])('refuses a run of $situation and changes nothing', async ({ as }) => {
      const mine = await anItem('Mine');
      const theirs = as === 'item' ? await sentItem('Another') : await sentItem('Theirs', { userId: OTHER_USER_ID });

      const res = await end(mine, theirs.runId);

      expect(res.status).toBe(404);
      // Read through the run's own account: its store is not the default one.
      expect(await openRuns(theirs.itemId, as === 'item' ? USER_ID : OTHER_USER_ID)).toHaveLength(1);
    });

    it('opens a new run when the Item is sent to Claude again', async () => {
      const { itemId, runId } = await sentItem();
      await end(itemId, runId);

      const again = await postChange(
        'send_item_to_claude',
        { workspaceId: WORKSPACE_ID, itemId, runId: nextId(), destination: 'cowork', folder: '' },
        { issuedAt: later(15) },
      );

      expect(again.status).toBe(200);
      expect(await openRuns(itemId)).toEqual([expect.objectContaining({ destination: 'cowork', stage: 'sent' })]);
    });
  });

  describe('Undo brings back exactly the run it ended, only while nothing has moved on', () => {
    it('opens the same run again with its stage, session link and note', async () => {
      const { itemId, runId } = await sentItem();
      await reported(runId, { stage: 'needs_you', sessionUrl: 'https://claude.ai/code/session_01', note: 'Which tenancy?' });
      await end(itemId, runId);

      expect((await undoEnd(itemId, runId)).status).toBe(200);

      expect(await openRuns(itemId)).toEqual([
        expect.objectContaining({ id: runId, stage: 'needs_you', sessionUrl: 'https://claude.ai/code/session_01', note: 'Which tenancy?' }),
      ]);
    });

    it.each([
      {
        situation: 'the Item was marked Done since',
        since: (itemId: string) => postChange('set_done', { workspaceId: WORKSPACE_ID, itemId, done: true }, { issuedAt: later(12) }),
      },
      {
        situation: 'the Item was dismissed since',
        since: (itemId: string) =>
          postChange('set_dismissed', { workspaceId: WORKSPACE_ID, itemId, dismissed: true }, { issuedAt: later(12) }),
      },
      {
        situation: 'the Item was sent to Claude again since',
        since: (itemId: string) =>
          postChange(
            'send_item_to_claude',
            { workspaceId: WORKSPACE_ID, itemId, runId: nextId(), destination: 'code', folder: '' },
            { issuedAt: later(12) },
          ),
      },
      {
        situation: 'a run was started and ended on the Item since',
        since: async (itemId: string) => {
          const second = nextId();
          await postChange(
            'send_item_to_claude',
            { workspaceId: WORKSPACE_ID, itemId, runId: second, destination: 'code', folder: '' },
            { issuedAt: later(12) },
          );
          await end(itemId, second, later(13));
        },
      },
    ])('reopens nothing where $situation', async ({ since }) => {
      const { itemId, runId } = await sentItem();
      await end(itemId, runId);
      await since(itemId);
      const open = (await openRuns(itemId)).map((run) => run.id);

      const res = await undoEnd(itemId, runId);

      expect(res.status).toBe(200);
      expect(await endedAtOf(runId)).toBe(later(10));
      expect((await openRuns(itemId)).map((run) => run.id)).toEqual(open);
    });
  });
});
