import { afterEach, beforeEach, describe, expect, inject, it, vi } from 'vitest';
import { SELF, applyD1Migrations, env } from 'cloudflare:test';
import { ACCOUNT_WIDE, AGENT_COLORS, AGENT_PREAMBLE } from '@cockpit/shared';
import type {
  AgentRun,
  CommandName,
  CommandPayload,
  ServerEvent,
  SourceAccount,
  WorkspaceSnapshot,
} from '@cockpit/shared';
import {
  ACCOUNT_NAME,
  DASHBOARD_ID,
  OTHER_USER_ID,
  TASK_TYPE_ID,
  USER_ID,
  WORKSPACE_ID,
  alsoWorkspaces,
  asUser,
  inTheStore,
  seedRegister,
  signInAs,
  startFromEmpty,
  storeNamed,
} from '../seed.js';

/**
 * Integration level, through the real Worker: every rule here is about what a
 * start records, when it calls Claude and how often, and what it refuses -
 * all of which is the store and the route together ("Drop an agent on an item
 * to start a Claude Code session on it", issue 571). Claude is faked at the
 * network boundary, so the application makes its own real call to it, exactly
 * as claude-code-connections.test.ts does.
 *
 * Not re-proved here: the wording of each refusal status, which is
 * tests/unit/connectors/claude-code.test.ts's; the message template's own
 * substitution, which is packages/shared/tests/unit/domain/agent.test.ts's;
 * what the chip says for each run, which is the web app's own F1 test.
 */

const ATLAS = 'ws-atlas';
const ROUTINE_URL = 'https://api.anthropic.com/v1/claude_code/routines/trig_workspace/fire';
const SESSION_URL = 'https://claude.ai/code/session_01EXAMPLE';

let seq = 0;
const nextId = () => {
  seq += 1;
  return `018f0000-0000-7000-8000-${String(seq).padStart(12, '0')}`;
};
const AT = '2026-09-28T10:00:00.000Z';

type Answer = { status: number; body?: unknown } | 'timeout';

/** A fake Claude: what it answers next, and every fire it was sent. */
const claude = {
  answer: { status: 200, body: { claude_code_session_url: SESSION_URL } } as Answer,
  fired: [] as { headers: Headers; text: string }[],
};

function claudeOnTheNetwork() {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith('https://api.anthropic.com/')) throw new Error(`nothing in a test may reach ${url}`);
    const sent = JSON.parse(String(init?.body ?? '{}')) as { text?: string };
    claude.fired.push({ headers: new Headers(init?.headers), text: sent.text ?? '' });
    if (claude.answer === 'timeout') throw new DOMException('The operation timed out.', 'TimeoutError');
    return new Response(claude.answer.body === undefined ? null : JSON.stringify(claude.answer.body), {
      status: claude.answer.status,
      headers: { 'content-type': 'application/json' },
    });
  });
}

async function postChange<N extends CommandName>(name: N, payload: Omit<CommandPayload<N>, 'commandId' | 'issuedAt'>, userId = USER_ID) {
  return asUser(
    `http://cockpit.test/v1/commands/${name}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ commandId: nextId(), issuedAt: AT, ...payload }),
    },
    userId,
  );
}

async function snapshot(workspaceId = WORKSPACE_ID, userId = USER_ID): Promise<WorkspaceSnapshot> {
  const res = await asUser(`http://cockpit.test/v1/workspaces/${workspaceId}/snapshot`, {}, userId);
  expect(res.status).toBe(200);
  return (await res.json()) as WorkspaceSnapshot;
}

async function runOn(itemId: string): Promise<AgentRun | undefined> {
  return (await snapshot()).agentRuns.find((run) => run.itemId === itemId);
}

async function connection(workspaceId = WORKSPACE_ID): Promise<SourceAccount> {
  const res = await asUser(`http://cockpit.test/v1/workspaces/${workspaceId}/connections`);
  const { sourceAccounts } = (await res.json()) as { sourceAccounts: SourceAccount[] };
  return sourceAccounts.find((account) => account.connectorId === 'claude-code')!;
}

async function connectClaudeCode(workspaceId = WORKSPACE_ID) {
  const res = await asUser(`http://cockpit.test/v1/workspaces/${workspaceId}/connections/claude-code/connect`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ routineUrl: ROUTINE_URL, token: 'a-routine-token' }),
  });
  expect(await res.json()).toEqual({ accepted: true });
}

async function anAgent(overrides: Partial<CommandPayload<'create_agent'>> = {}): Promise<string> {
  const agentId = nextId();
  const res = await postChange('create_agent', {
    workspaceId: ACCOUNT_WIDE,
    agentId,
    name: `Scope it ${seq}`,
    color: AGENT_COLORS[0]!,
    engine: 'claude-code',
    message: '/scoping {title} - {link}',
    asksForPrompt: false,
    startsInProgress: true,
    ...overrides,
  });
  expect(res.status).toBe(200);
  return agentId;
}

async function aPanel(workspaceId = WORKSPACE_ID, dashboardId = DASHBOARD_ID): Promise<string> {
  const panelId = nextId();
  expect((await postChange('add_panel', { workspaceId, dashboardId, panelId, name: `Now ${seq}`, kind: 'items' })).status).toBe(200);
  return panelId;
}

async function anItem(message: string, panelId: string | null, workspaceId = WORKSPACE_ID): Promise<string> {
  const itemId = nextId();
  expect((await postChange('capture_item', { workspaceId, itemId, message, typeId: TASK_TYPE_ID })).status).toBe(200);
  if (panelId) {
    expect(
      (await postChange('move_item_to_panel', { workspaceId, itemId, panelId, order: [itemId] })).status,
    ).toBe(200);
  }
  return itemId;
}

function start(
  itemId: string,
  agentId: string,
  options: { commandId?: string; workspaceId?: string; dashboardId?: string; userId?: string } = {},
) {
  return asUser(
    `http://cockpit.test/v1/workspaces/${options.workspaceId ?? WORKSPACE_ID}/items/${itemId}/agent-runs`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        commandId: options.commandId ?? nextId(),
        issuedAt: AT,
        runId: nextId(),
        agentId,
        dashboardId: options.dashboardId ?? DASHBOARD_ID,
      }),
    },
    options.userId ?? USER_ID,
  );
}

let panelId: string;

beforeEach(async () => {
  await applyD1Migrations(env.DB, inject('migrations'));
  await startFromEmpty();
  await seedRegister();
  await alsoWorkspaces();
  // Both signed in before Claude is put on the network, for the reason
  // claude-code-connections.test.ts gives: a first sign-in stubs fetch itself.
  await signInAs(USER_ID);
  await signInAs(OTHER_USER_ID);
  claude.answer = { status: 200, body: { claude_code_session_url: SESSION_URL } };
  claudeOnTheNetwork();
  await connectClaudeCode();
  claude.fired = [];
  panelId = await aPanel();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Agents', () => {
  describe('starting an agent records a run, then calls Claude once', () => {
    it.each([
      {
        situation: 'Claude accepts',
        answer: { status: 200, body: { claude_code_session_url: SESSION_URL } } as Answer,
        run: { status: 'working', sessionUrl: SESSION_URL, reason: null },
        failing: null,
      },
      {
        situation: 'Claude refuses the token',
        answer: { status: 401, body: { type: 'error' } } as Answer,
        run: { status: 'failed', sessionUrl: null, reason: 'The token is wrong or was revoked.' },
        failing: 'The token is wrong or was revoked.',
      },
      {
        situation: "Claude's answer never arrives",
        answer: 'timeout' as Answer,
        run: { status: 'unknown', sessionUrl: null, reason: null },
        failing: null,
      },
      {
        situation: 'Claude accepts, and its link cannot be stored',
        answer: { status: 200, body: { type: 'routine_fire' } } as Answer,
        run: { status: 'link_lost', sessionUrl: null, reason: null },
        failing: null,
      },
    ])('says so on the run when $situation', async ({ answer, run, failing }) => {
      const agentId = await anAgent();
      const itemId = await anItem('Chase the invoice', panelId);
      claude.answer = answer;

      const res = await start(itemId, agentId);

      expect(res.status).toBe(200);
      expect(await runOn(itemId)).toMatchObject({ agentId, ...run });
      expect(claude.fired).toHaveLength(1);
      expect((await connection()).failingBecause).toBe(failing);
      expect((await snapshot()).claudeCodeFailing).toBe(failing);
    });

    it("sends the agent's message with the item's words, the way Anthropic asks for it", async () => {
      const agentId = await anAgent({ message: '/scoping {title} - {link}' });
      const itemId = await anItem('Chase the invoice', panelId);

      await start(itemId, agentId);

      const [fired] = claude.fired;
      expect(fired!.headers.get('anthropic-version')).toBe('2023-06-01');
      expect(fired!.headers.get('authorization')).toBe('Bearer a-routine-token');
      expect(fired!.text).toBe(
        `${AGENT_PREAMBLE}

/scoping Chase the invoice - ${env.APP_ORIGIN}/w/${WORKSPACE_ID}/d/${DASHBOARD_ID}`,
      );
    });

    it('sends a link to each of the item’s files that opens it without signing in', async () => {
      const agentId = await anAgent({ message: '{title}' });
      const itemId = await anItem('Fix the layout', panelId);
      const bytes = new Uint8Array([137, 80, 78, 71, 9]);
      const uploaded = await asUser(`http://cockpit.test/v1/items/${itemId}/attachments`, {
        method: 'POST',
        headers: {
          'content-type': 'image/png',
          'x-attachment-id': nextId(),
          'x-command-id': nextId(),
          'x-issued-at': AT,
          'x-workspace-id': WORKSPACE_ID,
          'x-filename': 'layout.png',
        },
        body: bytes,
      });
      expect(uploaded.status).toBe(201);

      await start(itemId, agentId);

      const link = claude.fired[0]!.text.match(/- layout\.png: (\S+)/)?.[1];
      expect(link?.startsWith(`${env.APP_ORIGIN}/v1/attachment-links/`)).toBe(true);
      const opened = await SELF.fetch(link!);
      expect(opened.status).toBe(200);
      expect(new Uint8Array(await opened.arrayBuffer())).toEqual(bytes);
    });

    it('moves the connection’s last worked, and ends its failing, once a start works', async () => {
      const agentId = await anAgent();
      const refused = await anItem('Refused', panelId);
      claude.answer = { status: 401 };
      await start(refused, agentId);
      expect((await connection()).failingBecause).not.toBeNull();
      await inTheStore((sql) =>
        sql.exec("UPDATE connector_accounts SET last_tested_at = '2026-01-01T00:00:00.000Z'"),
      );

      claude.answer = { status: 200, body: { claude_code_session_url: SESSION_URL } };
      await start(await anItem('Works', await aPanel()), agentId);

      const after = await connection();
      expect(after.failingBecause).toBeNull();
      expect(after.lastTestedAt! > '2026-01-01T00:00:00.000Z').toBe(true);
    });
  });

  describe('an agent starts only where it is offered', () => {
    it.each([
      {
        situation: 'an Inbox row',
        arrange: async (agentId: string) => ({ itemId: await anItem('Unfiled', null), agentId }),
        refusal: 'An agent starts on an item on a dashboard, not in the Inbox.',
      },
      {
        situation: 'a dashboard that hides the agent',
        arrange: async (agentId: string) => {
          await postChange('hide_agent_on_dashboard', { workspaceId: WORKSPACE_ID, agentId, dashboardId: DASHBOARD_ID });
          return { itemId: await anItem('Filed', panelId), agentId };
        },
        refusal: 'That agent is not on this dashboard.',
      },
      {
        situation: 'an id that names no agent that was made, such as the one once built in',
        arrange: async () => ({ itemId: await anItem('Filed', panelId), agentId: 'ask-claude' }),
        refusal: 'That agent is not on this dashboard.',
      },
      {
        situation: 'an item that already has an open run',
        arrange: async (agentId: string) => {
          const itemId = await anItem('Filed', panelId);
          expect((await start(itemId, agentId)).status).toBe(200);
          claude.fired = [];
          return { itemId, agentId };
        },
        refusal: 'Claude is already on this item.',
      },
      {
        situation: 'a dismissed item',
        arrange: async (agentId: string) => {
          const itemId = await anItem('Filed', panelId);
          await postChange('set_dismissed', { workspaceId: WORKSPACE_ID, itemId, dismissed: true });
          return { itemId, agentId };
        },
        refusal: 'Claude only starts on an item still to be done.',
      },
      {
        situation: 'a done item',
        arrange: async (agentId: string) => {
          const itemId = await anItem('Filed', panelId);
          await postChange('set_done', { workspaceId: WORKSPACE_ID, itemId, done: true });
          return { itemId, agentId };
        },
        refusal: 'Claude only starts on an item still to be done.',
      },
    ])('refuses $situation, and calls Claude for nothing', async ({ arrange, refusal }) => {
      const { itemId, agentId } = await arrange(await anAgent());
      const runBefore = await runOn(itemId);

      const res = await start(itemId, agentId);

      expect({ status: res.status, said: await res.json() }).toEqual({ status: 409, said: { error: refusal } });
      expect(claude.fired).toEqual([]);
      expect(await runOn(itemId)).toEqual(runBefore);
    });

    it('refuses a workspace with no Claude Code connection', async () => {
      const agentId = await anAgent();
      const atlasPanel = await aPanel(ATLAS, `${ATLAS}-dashboard-1`);
      const itemId = await anItem('In Atlas', atlasPanel, ATLAS);

      const res = await start(itemId, agentId, { workspaceId: ATLAS, dashboardId: `${ATLAS}-dashboard-1` });

      expect({ status: res.status, said: await res.json() }).toEqual({
        status: 409,
        said: { error: 'This workspace has no Claude Code connection.' },
      });
      expect(claude.fired).toEqual([]);
    });

  });

  describe('starting sets the item In progress where the agent says so', () => {
    it.each([
      { situation: 'sets it In progress', startsInProgress: true, status: 'in progress' },
      { situation: 'leaves it alone', startsInProgress: false, status: 'to do' },
    ])('an agent that $situation', async ({ startsInProgress, status }) => {
      const agentId = await anAgent({ startsInProgress });
      const itemId = await anItem('Chase the invoice', panelId);

      await start(itemId, agentId);

      const item = (await snapshot()).items.find((candidate) => candidate.id === itemId)!;
      expect(item.startedAt === null ? 'to do' : 'in progress').toBe(status);
    });
  });

  describe('saying the agent finished ends the run and settles the item', () => {
    async function aWorkingRun() {
      const agentId = await anAgent();
      const itemId = await anItem('Chase the invoice', panelId);
      await start(itemId, agentId);
      return { agentId, itemId, run: (await runOn(itemId))! };
    }

    async function endedAt(runId: string): Promise<string | null> {
      return inTheStore((sql) =>
        sql.exec<{ ended_at: string | null }>('SELECT ended_at FROM agent_runs WHERE id = ?', runId).one().ended_at,
      );
    }

    it.each([
      { situation: 'Done', outcome: 'done' as const, item: { done: true, started: true } },
      { situation: 'Still to do', outcome: 'still_to_do' as const, item: { done: false, started: false } },
    ])('ends it and settles the item for Agent finished: $situation', async ({ outcome, item }) => {
      const { itemId, run } = await aWorkingRun();

      const res = await postChange('finish_agent_run', { workspaceId: WORKSPACE_ID, runId: run.id, itemId, outcome });

      expect(res.status).toBe(200);
      expect(await endedAt(run.id)).not.toBeNull();
      expect(await runOn(itemId)).toBeUndefined();
      const stored = await inTheStore((sql) =>
        sql.exec<{ completed_at: string | null; started_at: string | null }>(
          'SELECT completed_at, started_at FROM items WHERE id = ?',
          itemId,
        ).one(),
      );
      expect({ done: stored.completed_at !== null, started: stored.started_at !== null }).toEqual(item);
    });

    it('lets Done be undone, the way marking it done is', async () => {
      const { itemId, run } = await aWorkingRun();
      await postChange('finish_agent_run', { workspaceId: WORKSPACE_ID, runId: run.id, itemId, outcome: 'done' });

      await postChange('set_done', { workspaceId: WORKSPACE_ID, itemId, done: false });

      expect((await snapshot()).items.some((candidate) => candidate.id === itemId)).toBe(true);
    });

    it('stops showing a run once its item is marked done from its own menu, and shows it again on undo', async () => {
      const { itemId } = await aWorkingRun();

      await postChange('set_done', { workspaceId: WORKSPACE_ID, itemId, done: true });
      expect(await runOn(itemId)).toBeUndefined();

      await postChange('set_done', { workspaceId: WORKSPACE_ID, itemId, done: false });
      expect(await runOn(itemId)).toMatchObject({ status: 'working' });
    });

    it('keeps the link of a run whose agent was deleted, naming no agent', async () => {
      const { agentId, itemId } = await aWorkingRun();

      await postChange('delete_agent', { workspaceId: ACCOUNT_WIDE, agentId });

      expect(await runOn(itemId)).toMatchObject({ agentName: null, sessionUrl: SESSION_URL });
    });
  });

  describe('a start is made once, whoever else is starting one', () => {
    it('makes the same start sent twice one run and one call to Claude', async () => {
      const agentId = await anAgent();
      const itemId = await anItem('Chase the invoice', panelId);
      const commandId = nextId();

      const first = await start(itemId, agentId, { commandId });
      const again = await start(itemId, agentId, { commandId });

      expect(await first.json()).toEqual({ alreadyStarted: false, status: 'working' });
      expect(await again.json()).toEqual({ alreadyStarted: true });
      expect(claude.fired).toHaveLength(1);
      expect((await snapshot()).agentRuns.filter((run) => run.itemId === itemId)).toHaveLength(1);
    });

    it('lets one of two tabs dropping on the same item at once start, and refuses the other', async () => {
      const agentId = await anAgent();
      const other = await anAgent();
      const itemId = await anItem('Chase the invoice', panelId);

      const answers = await Promise.all([start(itemId, agentId), start(itemId, other)]);

      expect(answers.map((res) => res.status).sort()).toEqual([200, 409]);
      expect(claude.fired).toHaveLength(1);
    });

    it('tells another open tab the workspace changed', async () => {
      const agentId = await anAgent();
      const itemId = await anItem('Chase the invoice', panelId);
      const { upTo } = (await snapshot()) as WorkspaceSnapshot & { upTo: string };

      await start(itemId, agentId);

      const answer = await storeNamed(ACCOUNT_NAME).changesSince(ACCOUNT_NAME, upTo);
      const { events } = (answer as { status: 'ok'; value: { events: ServerEvent[] } }).value;
      expect(events.map((event) => event.workspaceId)).toContain(WORKSPACE_ID);
    });

    it('shows another account none of the runs, and lets it start none on these items', async () => {
      const agentId = await anAgent();
      const itemId = await anItem('Chase the invoice', panelId);
      await start(itemId, agentId);

      const theirs = await asUser('http://cockpit.test/v1/workspaces', {}, OTHER_USER_ID);
      const { workspaces } = (await theirs.json()) as { workspaces: { id: string }[] };
      for (const workspace of workspaces) {
        expect((await snapshot(workspace.id, OTHER_USER_ID)).agentRuns).toEqual([]);
      }
      expect((await start(itemId, agentId, { userId: OTHER_USER_ID })).status).toBe(404);
    });
  });
});
