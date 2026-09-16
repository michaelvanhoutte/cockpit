import { afterEach, beforeEach, describe, expect, inject, it, vi } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import type { CommandName, CommandPayload } from '@cockpit/shared';
import {
  ACCOUNT_NAME,
  TASK_TYPE_ID,
  WORKSPACE_ID,
  alsoWorkspaces,
  asUser,
  inStoreAsItIs,
  seedRegister,
  signInAs,
  startFromEmpty,
} from '../seed.js';
import { handleQueue } from '../../../src/jobs/index.js';
import { enrichmentJobSchema, type EnrichmentJob } from '../../../src/jobs/enrichment.js';

/**
 * Integration level: a real store, a real queue, and the capture and every
 * correction arrive through the real Worker (`SELF.fetch`, via `asUser`) -
 * the same shape `note-cleanup.test.ts` already exercises for the job these
 * rows are written from. What is faked is the model, at the network
 * boundary.
 *
 * "See the history of what Cockpit proposed for the Inbox's items" (issue
 * 444), its Rules 1 through 4.
 */

const A_READING = {
  language: 'English',
  title: 'A cleaner title',
  message: 'A fuller message.',
  readings: [] as unknown[],
};

type Answering = { says: unknown } | 'fails' | 'declines';
let answering: Answering = { says: A_READING };

function theModelIs(next: Answering): void {
  answering = next;
}

/**
 * Held open until `releaseTheModel` is called - what lets a case observe the
 * row a capture writes before the model has answered at all, or edit an item
 * while the model is still "thinking", deterministically rather than by
 * racing a poll or a real network delay.
 */
let gate: Promise<void> | null = null;
let releaseTheModel: () => void = () => {};

function holdTheModel(): void {
  gate = new Promise((resolve) => {
    releaseTheModel = resolve;
  });
}

function stubTheModel(): void {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    if (url.hostname !== 'api.anthropic.com') {
      throw new Error(`the suite tried to reach ${url.origin}`);
    }
    if (gate) await gate;
    if (answering === 'fails') throw new Error('the model could not be reached');
    return Response.json({
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-5',
      content:
        answering === 'declines'
          ? []
          : [{ type: 'text', text: JSON.stringify(answering.says) }],
      stop_reason: answering === 'declines' ? 'refusal' : 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    });
  });
}

async function postChange<N extends CommandName>(name: N, payload: CommandPayload<N>) {
  return asUser(`http://cockpit.test/v1/commands/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

let seq = 0;
function nextId(): string {
  seq += 1;
  return `018f0000-0000-7000-9200-${String(seq).padStart(12, '0')}`;
}

async function captureANote(overrides: Partial<CommandPayload<'capture_item'>> = {}): Promise<string> {
  const itemId = overrides.itemId ?? nextId();
  const response = await postChange('capture_item', {
    commandId: nextId(),
    issuedAt: '2026-09-16T10:00:00.000Z',
    workspaceId: WORKSPACE_ID,
    itemId,
    message: 'call the plumber about the leak',
    typeId: TASK_TYPE_ID,
    ...overrides,
  });
  expect(response.status).toBe(200);
  return itemId;
}

/**
 * An item that exists but was never captured through the route that queues a
 * rewrite attempt - the one way to get an item with no history at all, since
 * `captureANote` above always fires `enqueueCleanUp`.
 */
async function anItemWithNoAttemptYet(): Promise<string> {
  const itemId = nextId();
  const when = '2026-09-16T09:00:00.000Z';
  // `inStoreAsItIs` writes straight into storage, bypassing the account's own
  // up-to-date check - fine everywhere else in this file, where a capture has
  // always touched the store first, but this is the one case with no such
  // capture ahead of it, so the schema is brought into being here instead.
  await asUser(`http://cockpit.test/v1/workspaces/${WORKSPACE_ID}/snapshot`);
  await inStoreAsItIs(ACCOUNT_NAME, (sql) =>
    sql.exec(
      `INSERT INTO items
         (id, tenant_id, workspace_id, source, captured_message, title, texts_proposed_at, status, unseen, created_at, updated_at)
       VALUES (?, ?, ?, 'internal', NULL, ?, NULL, 'to_process', 0, ?, ?)`,
      itemId,
      ACCOUNT_NAME,
      WORKSPACE_ID,
      'Untitled',
      when,
      when,
    ),
  );
  return itemId;
}

async function aPanel(workspaceId: string, dashboardId: string): Promise<string> {
  const panelId = nextId();
  const response = await postChange('add_panel', {
    commandId: nextId(),
    issuedAt: '2026-09-16T09:30:00.000Z',
    workspaceId,
    dashboardId,
    panelId,
    name: 'Somewhere',
    kind: 'items',
  });
  expect(response.status).toBe(200);
  return panelId;
}

async function correctTitle(itemId: string, title: string) {
  const response = await postChange('set_title', {
    commandId: nextId(),
    issuedAt: '2026-09-16T10:00:01.000Z',
    workspaceId: WORKSPACE_ID,
    itemId,
    title,
  });
  expect(response.status).toBe(200);
}

type RewriteRow = {
  id: string;
  item_id: string;
  workspace_id: string;
  title_before: string;
  title_after: string | null;
  description_after: string | null;
  status: string;
  message: string | null;
};

/** Every rewrite-history row for one item, most recent first - read straight out of the store. */
async function rowsFor(itemId: string): Promise<RewriteRow[]> {
  return inStoreAsItIs(ACCOUNT_NAME, (sql) =>
    sql
      .exec<RewriteRow>(
        `SELECT id, item_id, workspace_id, title_before, title_after, description_after, status, message
         FROM rewrite_history WHERE item_id = ? AND tenant_id = ? ORDER BY attempted_at DESC`,
        itemId,
        ACCOUNT_NAME,
      )
      .toArray(),
  );
}

async function statusOf(itemId: string): Promise<string | undefined> {
  return (await rowsFor(itemId))[0]?.status;
}

function batchOf(job: EnrichmentJob) {
  const message = {
    id: 'message-1',
    timestamp: new Date(),
    body: job as unknown,
    attempts: 1,
    ack: () => {},
    retry: () => {},
  };
  const batch = { queue: 'cockpit-enrichment', messages: [message], ackAll: () => {}, retryAll: () => {} };
  return batch as unknown as Parameters<typeof handleQueue>[0];
}

async function workspaceHistory(workspaceId: string = WORKSPACE_ID): Promise<{ id: string; itemId: string }[]> {
  const response = await asUser(`http://cockpit.test/v1/workspaces/${workspaceId}/rewrite-history`);
  expect(response.status).toBe(200);
  const body = (await response.json()) as { entries: { id: string; itemId: string }[] };
  return body.entries.map((entry) => ({ id: entry.id, itemId: entry.itemId }));
}

async function itemHistory(itemId: string): Promise<{ id: string; status: string }[]> {
  const response = await asUser(`http://cockpit.test/v1/items/${itemId}/rewrite-history`);
  expect(response.status).toBe(200);
  const body = (await response.json()) as { entries: { id: string; status: string }[] };
  return body.entries;
}

beforeEach(async () => {
  await applyD1Migrations(env.DB, inject('migrations'));
  await startFromEmpty();
  await seedRegister();
  await signInAs();
  answering = { says: A_READING };
  gate = null;
  releaseTheModel = () => {};
  stubTheModel();
});

afterEach(() => {
  // Never left held: a case that opened the gate and forgot to release it
  // would hang the next fake fetch this stub answers, in whatever case runs
  // next.
  releaseTheModel();
  env.ANTHROPIC_API_KEY = '';
  vi.unstubAllGlobals();
});

describe('Rewrite history', () => {
  describe('an attempt is recorded from the moment it is queued through to its outcome', () => {
    it('is Pending the moment it is queued, before the job has run', async () => {
      env.ANTHROPIC_API_KEY = 'a-key-that-proves-nothing-here';
      holdTheModel();
      const itemId = await captureANote();

      // The row itself is written synchronously inside `enqueueCleanUp`, ahead
      // of the queue round trip - `waitUntil` work is not drained before the
      // response is, so the only honest way to observe it is to wait, with the
      // model held open so the queued job cannot race past Pending under this
      // poll.
      await vi.waitFor(async () => expect(await statusOf(itemId)).toBeDefined(), {
        timeout: 15_000,
        interval: 20,
      });
      expect(await statusOf(itemId)).toBe('pending');

      releaseTheModel();
    });

    it('is rewritten with the new title and message once it succeeds', async () => {
      env.ANTHROPIC_API_KEY = 'a-key-that-proves-nothing-here';
      const itemId = await captureANote();

      await vi.waitFor(async () => expect(await statusOf(itemId)).toBe('rewritten'), {
        timeout: 15_000,
        interval: 50,
      });

      const row = (await rowsFor(itemId))[0]!;
      expect(row.title_after).toBe(A_READING.title);
      expect(row.description_after).toBe(A_READING.message);
    });

    it('is left as-is, with the reason, where nothing was worth proposing', async () => {
      env.ANTHROPIC_API_KEY = 'a-key-that-proves-nothing-here';
      theModelIs('declines');
      const itemId = await captureANote();

      await vi.waitFor(async () => expect(await statusOf(itemId)).toBe('left-as-is'), {
        timeout: 15_000,
        interval: 50,
      });

      expect((await rowsFor(itemId))[0]!.message).toMatch(/nothing was proposed/);
    });

    it('is left as-is, with that reason, where the environment has no API key configured', async () => {
      env.ANTHROPIC_API_KEY = '';
      const itemId = await captureANote();

      await vi.waitFor(async () => expect(await statusOf(itemId)).toBeDefined(), {
        timeout: 15_000,
        interval: 20,
      });
      const row = (await rowsFor(itemId))[0]!;
      expect(row.status).toBe('left-as-is');
      expect(row.message).toContain('ANTHROPIC_API_KEY');
    });

    /**
     * The window the job cannot see: the edit lands after the note has been
     * sent to be read and before the answer comes back, the same race
     * `note-cleanup.test.ts`'s "leaves both texts alone when you rename it
     * while Cockpit is still reading" exercises for the item's own texts -
     * this is the same race read back through the rewrite-history row
     * instead, which must not claim a rewrite that the store refused.
     */
    it('is left as-is, not falsely Rewritten, when you rename it while Cockpit is still reading', async () => {
      env.ANTHROPIC_API_KEY = 'a-key-that-proves-nothing-here';
      holdTheModel();
      const itemId = await captureANote();
      await vi.waitFor(async () => expect(await statusOf(itemId)).toBe('pending'), {
        timeout: 15_000,
        interval: 20,
      });

      await correctTitle(itemId, 'Typed while it was thinking');
      releaseTheModel();

      await vi.waitFor(async () => expect(await statusOf(itemId)).toBe('left-as-is'), {
        timeout: 15_000,
        interval: 50,
      });
      const row = (await rowsFor(itemId))[0]!;
      expect(row.title_after).toBeNull();
    });

    /**
     * **Driven by hand from here on, never by letting a capture's own automatic
     * delivery fail for real.** `jobs/index.ts`'s own consumer retries a
     * genuine failure through the real queue this pool runs, and this pool
     * does not honour the delay that asks for - a job left failing for real
     * outlives this case and has gone on to redeliver itself into a later
     * one's freshly-wiped store. `handleQueue` called directly, the same way
     * `note-cleanup.test.ts` drives a "second reading", reaches the identical
     * code with no such tail: its `ack`/`retry` are no-ops.
     */
    it('shows Failed, with the last error, once every retry has failed', async () => {
      env.ANTHROPIC_API_KEY = 'a-key-that-proves-nothing-here';
      const itemId = await captureANote();
      await vi.waitFor(async () => expect(await statusOf(itemId)).toBe('rewritten'), {
        timeout: 15_000,
        interval: 50,
      });
      const attemptId = (await rowsFor(itemId))[0]!.id;

      theModelIs('fails');
      await handleQueue(
        batchOf({ kind: 'clean-up-a-note', accountName: ACCOUNT_NAME, itemId, attemptId }),
        env,
      );

      const rows = await rowsFor(itemId);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.status).toBe('failed');
      expect(rows[0]!.message).toBeTruthy();
      // Not a stale leftover from the success this same record held a
      // moment ago: a retry that fails must show as failed, not as a
      // rewrite that both happened and didn't (found in review).
      expect(rows[0]!.title_after).toBeNull();
      expect(rows[0]!.description_after).toBeNull();
    });

    it('ends up showing the success on the same record, never a second one, when a retry follows a failure', async () => {
      env.ANTHROPIC_API_KEY = 'a-key-that-proves-nothing-here';
      const itemId = await captureANote();
      await vi.waitFor(async () => expect(await statusOf(itemId)).toBe('rewritten'), {
        timeout: 15_000,
        interval: 50,
      });
      const attemptId = (await rowsFor(itemId))[0]!.id;

      theModelIs('fails');
      await handleQueue(
        batchOf({ kind: 'clean-up-a-note', accountName: ACCOUNT_NAME, itemId, attemptId }),
        env,
      );
      expect(await statusOf(itemId)).toBe('failed');

      theModelIs({ says: A_READING });
      await handleQueue(
        batchOf({ kind: 'clean-up-a-note', accountName: ACCOUNT_NAME, itemId, attemptId }),
        env,
      );

      const rows = await rowsFor(itemId);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.status).toBe('rewritten');
      expect(rows[0]!.title_after).toBe(A_READING.title);
    });

    /**
     * A message enqueued by the Worker version before `attemptId` existed
     * can still be delivered after this ships - Cloudflare Queues carry no
     * version pin to the producer, and this deploy has no drain or pause
     * (found in review) - so `enrichmentJobSchema`'s own union has to keep
     * accepting that older shape rather than refusing it outright, the way
     * it already refuses one it genuinely does not recognise.
     */
    it('still accepts a job enqueued before attemptId existed, rather than refusing it', () => {
      const result = enrichmentJobSchema.safeParse({
        kind: 'clean-up-a-note',
        accountName: ACCOUNT_NAME,
        itemId: nextId(),
      });
      expect(result.success).toBe(true);
    });

    it('cleans up the note from that older-shaped job, without adding a second record', async () => {
      env.ANTHROPIC_API_KEY = 'a-key-that-proves-nothing-here';
      const itemId = await captureANote();
      await vi.waitFor(async () => expect(await statusOf(itemId)).toBe('rewritten'), {
        timeout: 15_000,
        interval: 50,
      });

      await handleQueue(batchOf({ kind: 'clean-up-a-note', accountName: ACCOUNT_NAME, itemId }), env);

      // No second row: the old-shaped message names no attemptId, so the
      // fresh one this run mints matches no existing row and its own
      // outcome write no-ops, exactly as it already does for the "account
      // left the register" rarity.
      expect(await rowsFor(itemId)).toHaveLength(1);
    });
  });

  describe('a later, separate re-proposal is its own new record', () => {
    it('adds a second record for the item once a correction elsewhere re-reads it too', async () => {
      env.ANTHROPIC_API_KEY = 'a-key-that-proves-nothing-here';
      const itemId = await captureANote();
      await vi.waitFor(async () => expect(await statusOf(itemId)).toBe('rewritten'), {
        timeout: 15_000,
        interval: 50,
      });
      expect(await rowsFor(itemId)).toHaveLength(1);

      // A different item's correction is what fires the account-wide re-read
      // ("Re-read the rest of the inbox the moment you fix a title", issue
      // 399) - `itemId`'s own texts are still Cockpit's (nothing here ever
      // settled them), so it is re-read along with everything else unsettled.
      const other = await captureANote({ itemId: nextId() });
      await vi.waitFor(async () => expect(await statusOf(other)).toBe('rewritten'), {
        timeout: 15_000,
        interval: 50,
      });
      await correctTitle(other, 'My own title for this one');

      await vi.waitFor(async () => expect(await rowsFor(itemId)).toHaveLength(2), {
        timeout: 15_000,
        interval: 50,
      });
    });
  });

  describe('history is visible exactly where the item it is about is visible', () => {
    it('includes an item captured but not yet given a workspace', async () => {
      env.ANTHROPIC_API_KEY = 'a-key-that-proves-nothing-here';
      const itemId = await captureANote({ workspaceDecided: false });
      await vi.waitFor(async () => expect(await statusOf(itemId)).toBeDefined(), {
        timeout: 15_000,
        interval: 20,
      });

      const entries = await workspaceHistory(WORKSPACE_ID);
      expect(entries.some((entry) => entry.itemId === itemId)).toBe(true);
    });

    it('never shows an item belonging to a different workspace', async () => {
      await alsoWorkspaces();
      env.ANTHROPIC_API_KEY = 'a-key-that-proves-nothing-here';
      const itemId = await captureANote({ workspaceId: 'ws-personal' });
      await vi.waitFor(async () => expect(await statusOf(itemId)).toBeDefined(), {
        timeout: 15_000,
        interval: 20,
      });

      const entries = await workspaceHistory(WORKSPACE_ID);
      expect(entries.some((entry) => entry.itemId === itemId)).toBe(false);
    });

    it('follows an item still undecided when it is filed into a workspace, and leaves the others', async () => {
      await alsoWorkspaces();
      env.ANTHROPIC_API_KEY = 'a-key-that-proves-nothing-here';
      // Undecided, so it shows in every workspace's Inbox until filed
      // ("Capture something before you know which workspace it belongs to",
      // issue 165) - the one way an item's workspace genuinely changes after
      // its attempt was already recorded against a frozen workspace id.
      const itemId = await captureANote({ workspaceId: 'ws-personal', workspaceDecided: false });
      await vi.waitFor(async () => expect(await statusOf(itemId)).toBeDefined(), {
        timeout: 15_000,
        interval: 20,
      });
      expect((await workspaceHistory(WORKSPACE_ID)).some((entry) => entry.itemId === itemId)).toBe(true);
      expect((await workspaceHistory('ws-personal')).some((entry) => entry.itemId === itemId)).toBe(true);

      const panelId = await aPanel(WORKSPACE_ID, `${WORKSPACE_ID}-dashboard-1`);
      const moved = await postChange('move_item_to_panel', {
        commandId: nextId(),
        issuedAt: '2026-09-16T10:00:02.000Z',
        workspaceId: WORKSPACE_ID,
        itemId,
        panelId,
        order: [itemId],
      });
      expect(moved.status).toBe(200);

      expect((await workspaceHistory('ws-personal')).some((entry) => entry.itemId === itemId)).toBe(false);
      expect((await workspaceHistory(WORKSPACE_ID)).some((entry) => entry.itemId === itemId)).toBe(true);
    });

    /**
     * A dismissed item is gone from the Inbox it was captured into, and its
     * rewrite-history rows follow it out of the account-wide table - the
     * same rule `recentlyCapturedUnfiled` already states for the same
     * reason (found in review): identified only by id, a dead item's rows
     * have nothing here to open, and would otherwise crowd a live item's
     * out of the capped result.
     */
    it('leaves out an item once it has been dismissed', async () => {
      env.ANTHROPIC_API_KEY = 'a-key-that-proves-nothing-here';
      const itemId = await captureANote();
      await vi.waitFor(async () => expect(await statusOf(itemId)).toBeDefined(), {
        timeout: 15_000,
        interval: 20,
      });
      expect((await workspaceHistory(WORKSPACE_ID)).some((entry) => entry.itemId === itemId)).toBe(true);

      const dismissed = await postChange('set_dismissed', {
        commandId: nextId(),
        issuedAt: '2026-09-16T10:00:02.000Z',
        workspaceId: WORKSPACE_ID,
        itemId,
        dismissed: true,
      });
      expect(dismissed.status).toBe(200);

      expect((await workspaceHistory(WORKSPACE_ID)).some((entry) => entry.itemId === itemId)).toBe(false);
    });
  });

  describe('an empty account or an empty item is empty, not an error', () => {
    it('answers an empty list for a workspace nothing has ever been proposed in', async () => {
      expect(await workspaceHistory(WORKSPACE_ID)).toEqual([]);
    });

    it('answers an empty list for an item nothing has ever been proposed for', async () => {
      const itemId = await anItemWithNoAttemptYet();
      expect(await itemHistory(itemId)).toEqual([]);
    });
  });
});
