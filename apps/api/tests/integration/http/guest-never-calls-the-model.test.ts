import { afterEach, beforeEach, describe, expect, inject, it, vi } from 'vitest';
import { SELF, applyD1Migrations, env } from 'cloudflare:test';
import type { CommandName, CommandPayload, WorkspaceSnapshot } from '@cockpit/shared';
import { handleQueue } from '../../../src/jobs/index.js';
import type { EnrichmentJob } from '../../../src/jobs/enrichment.js';
import { GUEST_ACCOUNT_NAME } from '../../../src/auth/register.js';
import {
  ACCOUNT_NAME,
  DASHBOARD_ID,
  TASK_TYPE_ID,
  WORKSPACE_ID,
  asUser,
  inStoreAsItIs,
  seedRegister,
  signInAs,
  startFromEmpty,
} from '../seed.js';

/**
 * Integration level, through the real Worker: the shared guest demo spends the
 * same key for anyone who opens it, so it is treated as an environment with no
 * key ("Cut what cleaning up a captured note costs", issue 887). **A key is
 * set**, which is what makes each case a proof: without one nothing would be
 * queued for anybody. Claude is not faked, because it must never be reached -
 * any request to the network fails the case that makes one - and the queue's
 * timing is held, as `guest-runs.test.ts` does.
 *
 * **Nothing queued is shown by waiting.** What a request queues is queued after
 * its response, so a guest that queued something would not have yet when the
 * response returned. Each case therefore has a positive control: the same act
 * by a signed-in account, whose job is waited for, after the guest's own.
 */

const WORKSPACE = 'guest-ws-personal';
const AT = '2026-10-05T10:00:00.000Z';

let seq = 0;
const nextId = () => {
  seq += 1;
  return `018f0000-0000-7000-8700-${String(seq).padStart(12, '0')}`;
};

let held: EnrichmentJob[] = [];
let realQueue: typeof env.ENRICHMENT;
let reachedTheNetwork: string[] = [];
let cookie: string;

function holdTheQueue(): void {
  realQueue = env.ENRICHMENT;
  env.ENRICHMENT = {
    send: async (body: EnrichmentJob) => {
      held.push(body);
    },
    sendBatch: async () => {
      throw new Error('nothing here sends a batch');
    },
  } as unknown as typeof env.ENRICHMENT;
}

/** Delivers one message through the real consumer, as the queue would; a retry fails the case. */
async function deliver(body: unknown): Promise<{ acked: boolean }> {
  let acked = false;
  await handleQueue(
    {
      queue: 'cockpit-enrichment',
      messages: [
        {
          id: crypto.randomUUID(),
          timestamp: new Date(),
          body,
          attempts: 1,
          ack: () => {
            acked = true;
          },
          retry: () => {
            throw new Error('a message for the guest was retried');
          },
        },
      ],
      ackAll: () => {},
      retryAll: () => {},
    } as unknown as Parameters<typeof handleQueue>[0],
    env,
  );
  return { acked };
}

async function continueAsGuest(): Promise<string> {
  const back = await SELF.fetch('http://cockpit.test/v1/sign-in/guest', { redirect: 'manual' });
  return back.headers
    .getSetCookie()
    .map((one) => one.split(';')[0]!)
    .find((one) => one.startsWith('cockpit_session='))!;
}

async function snapshot(): Promise<WorkspaceSnapshot> {
  const res = await SELF.fetch(`http://cockpit.test/v1/workspaces/${WORKSPACE}/snapshot`, { headers: { cookie } });
  expect(res.status).toBe(200);
  return (await res.json()) as WorkspaceSnapshot;
}

async function postChange<N extends CommandName>(name: N, payload: Omit<CommandPayload<N>, 'commandId' | 'issuedAt'>) {
  const res = await SELF.fetch(`http://cockpit.test/v1/commands/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ commandId: nextId(), issuedAt: AT, ...payload }),
  });
  expect(res.status).toBe(200);
}

/** Captures a note in the guest's Workspace and returns what the Item is called afterwards. */
async function capture(message: string): Promise<{ itemId: string; title: string }> {
  const itemId = nextId();
  const { itemTypes } = await snapshot();
  await postChange('capture_item', { workspaceId: WORKSPACE, itemId, message, typeId: itemTypes[0]!.id });
  const item = (await snapshot()).items.find((one) => one.id === itemId)!;
  return { itemId, title: item.title };
}

/** What Cockpit changed says about one of the guest's Items, read straight out of the store. */
async function whatCockpitChangedSaysOf(itemId: string): Promise<{ id: string; status: string; message: string | null }[]> {
  return inStoreAsItIs(GUEST_ACCOUNT_NAME, (sql) =>
    sql.exec<{ id: string; status: string; message: string | null }>(
      'SELECT id, status, message FROM rewrite_history WHERE item_id = ? ORDER BY attempted_at',
      itemId,
    ).toArray(),
  );
}

/** Files an Item the guest has not filed yet onto a Panel that already holds some. */
async function fileAnItem(): Promise<string> {
  const { items, filings } = await snapshot();
  const filed = new Set(filings.map((one) => one.itemId));
  const itemId = items.find((one) => !filed.has(one.id))!.id;
  const panelId = filings[0]!.panelId;
  const order = [...filings.filter((one) => one.panelId === panelId).map((one) => one.itemId), itemId];
  await postChange('add_item_to_panel', { workspaceId: WORKSPACE, itemId, panelId, order });
  return itemId;
}

/** A signed-in account's own capture, waited for until its clean-up is on the queue - after which the guest's, had there been one, is too. */
async function aSignedInAccountHasCapturedToo(): Promise<void> {
  const response = await asUser('http://cockpit.test/v1/commands/capture_item', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      commandId: nextId(),
      issuedAt: AT,
      workspaceId: WORKSPACE_ID,
      itemId: nextId(),
      message: 'call the plumber about the leak',
      typeId: TASK_TYPE_ID,
    }),
  });
  expect(response.status).toBe(200);
  await vi.waitFor(() => expect(held.some((job) => job.accountName === ACCOUNT_NAME && job.kind === 'clean-up-a-note')).toBe(true), {
    timeout: 15_000,
    interval: 20,
  });
}

/** A signed-in account's own first filing, waited for until its refresh is on the queue. */
async function aSignedInAccountHasFiledToo(): Promise<void> {
  const send = async (name: string, payload: Record<string, unknown>) => {
    const response = await asUser(`http://cockpit.test/v1/commands/${name}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ commandId: nextId(), issuedAt: AT, workspaceId: WORKSPACE_ID, ...payload }),
    });
    expect(response.status).toBe(200);
  };
  const panelId = nextId();
  const itemId = nextId();
  await send('add_panel', { dashboardId: DASHBOARD_ID, panelId, name: 'Somewhere else', kind: 'items' });
  await send('capture_item', { itemId, message: 'call the plumber about the leak', typeId: TASK_TYPE_ID });
  await send('move_item_to_panel', { itemId, panelId, order: [itemId] });
  await vi.waitFor(() => expect(held.some((job) => job.accountName === ACCOUNT_NAME && job.kind === 're-propose-panels')).toBe(true), {
    timeout: 15_000,
    interval: 20,
  });
}

beforeEach(async () => {
  await applyD1Migrations(env.DB, inject('migrations'));
  await startFromEmpty();
  await seedRegister();
  held = [];
  reachedTheNetwork = [];
  cookie = await continueAsGuest();
  await signInAs();
  env.ANTHROPIC_API_KEY = 'a-key-that-proves-nothing-here';
  // After signing in, which may itself use the network; from here a call to anywhere is Claude being reached.
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    reachedTheNetwork.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    throw new Error('the guest account reached out to the network');
  });
  holdTheQueue();
});

afterEach(() => {
  env.ENRICHMENT = realQueue;
  env.ANTHROPIC_API_KEY = '';
  vi.unstubAllGlobals();
});

describe('Capture', () => {
  describe('the guest account never asks the model', () => {
    it('a guest capture keeps the title it was typed with, nothing is queued to change it, and What Cockpit changed says why', async () => {
      const { itemId, title } = await capture('call jan about the invoice, not before 10');
      await aSignedInAccountHasCapturedToo();

      expect(title).toBe('call jan about the invoice, not before 10');
      expect(held.filter((job) => job.accountName === GUEST_ACCOUNT_NAME)).toEqual([]);
      expect(reachedTheNetwork).toEqual([]);
      await vi.waitFor(
        async () =>
          expect((await whatCockpitChangedSaysOf(itemId)).map(({ status, message }) => ({ status, message }))).toEqual([
            { status: 'left-as-is', message: 'nothing was enriched: the guest account never calls the model' },
          ]),
        { timeout: 15_000, interval: 20 },
      );
    });

    it('a guest filing queues no refresh of the rest of the Inbox', async () => {
      await fileAnItem();
      await aSignedInAccountHasFiledToo();

      expect(held.filter((job) => job.accountName === GUEST_ACCOUNT_NAME)).toEqual([]);
      expect(reachedTheNetwork).toEqual([]);
    });

    it('a clean-up or a refresh already queued for the guest asks the model nothing', async () => {
      const { itemId } = await capture('call jan about the invoice');
      const { workspaces } = (await (await SELF.fetch('http://cockpit.test/v1/workspaces', { headers: { cookie } })).json()) as {
        workspaces: { id: string }[];
      };

      // What a capture queued before the guest stopped being queued left behind: a row still waiting.
      const attemptId = nextId();
      await inStoreAsItIs(GUEST_ACCOUNT_NAME, (sql) =>
        sql.exec(
          `INSERT INTO rewrite_history (id, tenant_id, workspace_id, item_id, title_before, looks_at, status, attempted_at)
           VALUES (?, ?, ?, ?, ?, 'texts-and-panel', 'pending', ?)`,
          attemptId,
          GUEST_ACCOUNT_NAME,
          WORKSPACE,
          itemId,
          'call jan about the invoice',
          AT,
        ),
      );

      const cleanUp = await deliver({ kind: 'clean-up-a-note', accountName: GUEST_ACCOUNT_NAME, itemId, attemptId });
      const refresh = await deliver({ kind: 're-propose-panels', accountName: GUEST_ACCOUNT_NAME, workspaceId: workspaces[0]!.id });

      expect(cleanUp.acked).toBe(true);
      expect(refresh.acked).toBe(true);
      expect(reachedTheNetwork).toEqual([]);
      expect((await snapshot()).items.find((one) => one.id === itemId)!.title).toBe('call jan about the invoice');
      expect((await whatCockpitChangedSaysOf(itemId)).find((row) => row.id === attemptId)?.status).toBe('left-as-is');
    });
  });
});
