import { afterEach, beforeEach, describe, expect, inject, it, vi } from 'vitest';
import { SELF, applyD1Migrations, env } from 'cloudflare:test';
import { ACCOUNT_WIDE, AGENT_COLORS, demoAddress, demoPageOf } from '@cockpit/shared';
import type { AgentRun, CommandName, CommandPayload, ServerEvent, SourceAccount, WorkspaceSnapshot } from '@cockpit/shared';
import { handleQueue } from '../../../src/jobs/index.js';
import type { EnrichmentJob } from '../../../src/jobs/enrichment.js';
import { GUEST_ACCOUNT_NAME } from '../../../src/auth/register.js';
import { seedRegister, startFromEmpty, storeNamed } from '../seed.js';

/**
 * Integration level, through the real Worker: what is claimed is what the
 * guest's own start route does and what the queue's consumer then does to the
 * account's own store ("Show agents at work in the guest demo, with simulated
 * runs", issue 774). Claude is not faked, because it must never be reached: any
 * request to the network fails the case that makes one.
 *
 * The queue's *timing* is held, as refresh-debounce.test.ts does: every message
 * the Worker sends is kept with the delay it was sent with, and delivered
 * through the real consumer when a case says so, so no case waits fifteen
 * seconds.
 */

const WORKSPACE = 'guest-ws-personal';
const DASHBOARD = 'guest-db-personal-day-to-day';
const AT = '2026-10-05T10:00:00.000Z';

let seq = 0;
const nextId = () => {
  seq += 1;
  return `018f0000-0000-7000-8000-${String(seq).padStart(12, '0')}`;
};

let held: { body: EnrichmentJob; delaySeconds: number | undefined }[] = [];
let realQueue: typeof env.ENRICHMENT;
let reachedTheNetwork: string[] = [];

function holdTheQueue(): void {
  realQueue = env.ENRICHMENT;
  env.ENRICHMENT = {
    send: async (body: EnrichmentJob, options?: { delaySeconds?: number }) => {
      held.push({ body, delaySeconds: options?.delaySeconds });
    },
    sendBatch: async () => {
      throw new Error('nothing here sends a batch');
    },
  } as unknown as typeof env.ENRICHMENT;
}

/** Delivers one held message through the real consumer, as the queue would once its delay has passed. */
async function deliver(message: { body: EnrichmentJob }): Promise<void> {
  await handleQueue(
    {
      queue: 'cockpit-enrichment',
      messages: [
        {
          id: crypto.randomUUID(),
          timestamp: new Date(),
          body: message.body,
          attempts: 1,
          ack: () => {},
          retry: () => {
            throw new Error(`a ${message.body.kind} was retried`);
          },
        },
      ],
      ackAll: () => {},
      retryAll: () => {},
    } as unknown as Parameters<typeof handleQueue>[0],
    env,
  );
}

async function continueAsGuest(): Promise<string> {
  const back = await SELF.fetch('http://cockpit.test/v1/sign-in/guest', { redirect: 'manual' });
  return back.headers
    .getSetCookie()
    .map((one) => one.split(';')[0]!)
    .find((one) => one.startsWith('cockpit_session='))!;
}

let cookie: string;

async function snapshot(): Promise<WorkspaceSnapshot> {
  const res = await SELF.fetch(`http://cockpit.test/v1/workspaces/${WORKSPACE}/snapshot`, { headers: { cookie } });
  expect(res.status).toBe(200);
  return (await res.json()) as WorkspaceSnapshot;
}

async function postChange<N extends CommandName>(name: N, payload: Omit<CommandPayload<N>, 'commandId' | 'issuedAt'>) {
  return SELF.fetch(`http://cockpit.test/v1/commands/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ commandId: nextId(), issuedAt: AT, ...payload }),
  });
}

/** A filed, still-to-do Item of the demo that no Agent is on. */
async function aFreeFiledItem(): Promise<string> {
  const { items, filings, agentRuns } = await snapshot();
  const filed = new Set(filings.map((one) => one.itemId));
  const busy = new Set(agentRuns.map((one) => one.itemId));
  return items.find((one) => filed.has(one.id) && !busy.has(one.id))!.id;
}

async function start(itemId: string, agentId: string, runId = nextId()) {
  const res = await SELF.fetch(`http://cockpit.test/v1/workspaces/${WORKSPACE}/items/${itemId}/agent-runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ commandId: nextId(), issuedAt: AT, runId, agentId, dashboardId: DASHBOARD }),
  });
  return { res, runId };
}

async function runOf(runId: string): Promise<AgentRun | undefined> {
  return (await snapshot()).agentRuns.find((one) => one.id === runId);
}

beforeEach(async () => {
  await applyD1Migrations(env.DB, inject('migrations'));
  await startFromEmpty();
  await seedRegister();
  held = [];
  reachedTheNetwork = [];
  cookie = await continueAsGuest();
  // After signing in, which may itself use the network; from here a call to anywhere is Claude being reached.
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    reachedTheNetwork.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    throw new Error('a guest run reached out to the network');
  });
  holdTheQueue();
});

afterEach(() => {
  env.ENRICHMENT = realQueue;
  vi.unstubAllGlobals();
});

describe('Agents', () => {
  describe('the guest opens with four agents and runs at work, and Claude Code connected everywhere', () => {
    it('holds the four agents and runs both working and waiting on the personal workspace', async () => {
      const { agents, agentRuns } = await snapshot();

      expect(agents.map((one) => one.name)).toEqual(['Draft a reply', 'Research', 'Plan it', 'Fix it']);
      expect(agentRuns.some((one) => one.waiting)).toBe(true);
      expect(agentRuns.some((one) => !one.waiting)).toBe(true);
      for (const run of agentRuns) {
        expect(run.status, run.id).toBe('working');
        expect(demoPageOf(run.sessionUrl!), run.id).toBe('session');
        expect(agents.map((one) => one.name)).toContain(run.agentName);
      }
    });

    it('lists Claude Code as connected, and not failing, in every workspace', async () => {
      const workspaces = (
        (await (await SELF.fetch('http://cockpit.test/v1/workspaces', { headers: { cookie } })).json()) as {
          workspaces: { id: string; name: string }[];
        }
      ).workspaces.filter((one) => one.name !== 'Workspace 1');
      expect(workspaces).toHaveLength(3);

      for (const workspace of workspaces) {
        const res = await SELF.fetch(`http://cockpit.test/v1/workspaces/${workspace.id}/connections`, { headers: { cookie } });
        const { sourceAccounts } = (await res.json()) as { sourceAccounts: SourceAccount[] };
        const claudeCode = sourceAccounts.find((one) => one.connectorId === 'claude-code');
        expect(claudeCode, workspace.name).toBeDefined();
        expect(claudeCode!.failingBecause ?? null, workspace.name).toBeNull();
      }
    });
  });

  describe('starting an agent in the guest account plays the run out and never calls Claude', () => {
    it.each([
      { situation: 'a seeded agent', madeByGuest: false },
      { situation: 'an agent the guest made', madeByGuest: true },
    ])('settles $situation as working on a demo session, with no call to Claude', async ({ madeByGuest }) => {
      let agentId = (await snapshot()).agents.find((one) => one.name === 'Research')!.id;
      if (madeByGuest) {
        agentId = nextId();
        const made = await postChange('create_agent', {
          workspaceId: ACCOUNT_WIDE,
          agentId,
          name: 'Mine',
          color: AGENT_COLORS[0]!,
          engine: 'claude-code',
          message: '{title}',
          asksForPrompt: false,
          startsInProgress: false,
        });
        expect(made.status).toBe(200);
      }
      const itemId = await aFreeFiledItem();

      const { res, runId } = await start(itemId, agentId);

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ alreadyStarted: false, status: 'working' });
      const run = await runOf(runId);
      expect(run).toMatchObject({ itemId, agentId, status: 'working', waiting: false, sessionUrl: demoAddress('session', runId) });
      expect(reachedTheNetwork).toEqual([]);
      // A simulated run is not a paid call, so it leaves no record (issue 902).
      expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM provider_calls').first<{ n: number }>())!.n).toBe(0);
    });

    it('asks the queue for one step, about fifteen seconds on, and for nothing else', async () => {
      const agentId = (await snapshot()).agents[0]!.id;

      const { runId } = await start(await aFreeFiledItem(), agentId);

      expect(held).toEqual([
        {
          body: { kind: 'simulated-run-waits', accountName: GUEST_ACCOUNT_NAME, workspaceId: WORKSPACE, runId },
          delaySeconds: 15,
        },
      ]);
    });
  });

  describe('a simulated run moves to waiting on you when its step arrives, and only while it is still open', () => {
    async function aWorkingRun() {
      const agentId = (await snapshot()).agents[0]!.id;
      const itemId = await aFreeFiledItem();
      const { runId } = await start(itemId, agentId);
      return { runId, itemId, step: held[0]! };
    }

    it('says waiting on you once the step arrives, and the change feed reports it', async () => {
      const { runId, step } = await aWorkingRun();
      const { upTo } = (await snapshot()) as WorkspaceSnapshot & { upTo: string };

      await deliver(step);

      expect(await runOf(runId)).toMatchObject({ status: 'working', waiting: true });
      const answer = await storeNamed(GUEST_ACCOUNT_NAME).changesSince(GUEST_ACCOUNT_NAME, upTo);
      const { events } = (answer as { status: 'ok'; value: { events: ServerEvent[] } }).value;
      expect(events.map((event) => event.workspaceId)).toContain(WORKSPACE);
    });

    it('changes nothing when the run was marked done before the step arrived', async () => {
      const { runId, itemId, step } = await aWorkingRun();
      expect(
        (await postChange('finish_agent_run', { workspaceId: WORKSPACE, runId, itemId, outcome: 'done' })).status,
      ).toBe(200);

      await deliver(step);

      // Ended by the finish, so it is on no row, and the step found nothing to move.
      expect(await runOf(runId)).toBeUndefined();
    });

    it('is waiting once, with no error, when the step arrives twice', async () => {
      const { runId, step } = await aWorkingRun();

      await deliver(step);
      await deliver(step);

      expect(await runOf(runId)).toMatchObject({ waiting: true });
    });
  });
});
