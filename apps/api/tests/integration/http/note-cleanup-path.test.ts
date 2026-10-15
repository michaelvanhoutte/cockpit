import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { ACCOUNT_WIDE } from '@cockpit/shared';
import { ACCOUNT_NAME, WORKSPACE_ID, alsoWorkspaces, asUser, inTheStore, storeNamed } from '../seed.js';
import { handleQueue } from '../../../src/jobs/index.js';
import type { EnrichmentJob } from '../../../src/jobs/enrichment.js';
import {
  A_READING,
  asked,
  reading,
  theModelReadsAPlace,
  nextId,
  captureANote,
  textsOf,
  isACleanUp,
  isAPlaceRead,
  routingOf,
  priorityOf,
  historyOf,
  dueDateOf,
  workspaceOf,
  itemsDrawnIn,
  untilTheChangeIsRecorded,
  aPanel,
  moveOnto,
  panelsHolding,
  decisionsOn,
  aModelThatReads,
  batchOf,
} from './note-cleanup.support.js';

aModelThatReads();

/**
 * "File a capture on the panels you name, read from the spoken path" (issue
 * 1116). The model is faked at the network boundary, so these prove what
 * Cockpit does with the names it is handed back - against a real store, since
 * filing is a command, the decision history and the re-proposal queue are
 * store state, and which places the model is shown is a read of live rows.
 * Where the names point is the unit tier's (`tests/unit/domain/spoken-path.test.ts`).
 *
 * The account has three workspaces (`alsoWorkspaces`); Personal plays Home,
 * with a Day to day dashboard holding Admin & money and This week.
 */

// Ids as a person's own panels have them, since a filing names a panel by one.
const ADMIN = '018f0000-0000-7000-8000-0000000000a1';
const WEEK = '018f0000-0000-7000-8000-0000000000a2';
const PERSONAL = 'ws-personal';

/** Personal's Day to day dashboard and its two panels, written as fixture rows. */
async function aDayToDayDashboard(): Promise<void> {
  await inTheStore((sql) => {
    sql.exec(
      `INSERT INTO dashboards (id, tenant_id, workspace_id, name, folded_name, created_at)
       VALUES ('personal-day', ?, ?, 'Day to day', 'day to day', '2026-08-12T00:00:04.000Z')`,
      ACCOUNT_NAME,
      PERSONAL,
    );
    for (const [id, name] of [
      [ADMIN, 'Admin & money'],
      [WEEK, 'This week'],
    ] as const) {
      sql.exec(
        `INSERT INTO panels (id, tenant_id, dashboard_id, name, folded_name, created_at)
         VALUES (?, ?, 'personal-day', ?, ?, '2026-08-12T00:00:05.000Z')`,
        id,
        ACCOUNT_NAME,
        name,
        name.toLowerCase(),
      );
    }
  });
}

/** Runs `meanwhile` during the first call of the kind `which` picks out, and during no other. */
function duringThe(
  which: (call: { system: string }) => boolean,
  meanwhile: () => Promise<unknown>,
): (call: { system: string }) => Promise<unknown> {
  let ran = false;
  return async (call) => {
    if (ran || !which(call)) return;
    ran = true;
    await meanwhile();
  };
}

/** Where a tab's next read of what changed starts, once everything already there is older. */
async function changesFrom(since: string): Promise<string> {
  const answer = await storeNamed(ACCOUNT_NAME).changesSince(ACCOUNT_NAME, since);
  return (answer as { value: { cursor: string } }).value.cursor;
}

/** An item already filed at the top of a Panel of Personal, captured with no place named. */
async function alreadyOn(panelId: string): Promise<string> {
  theModelReadsAPlace(null);
  const itemId = await captureANote({ workspaceId: PERSONAL });
  await untilTheChangeIsRecorded(itemId);
  await moveOnto(itemId, panelId, PERSONAL);
  return itemId;
}

/**
 * The re-proposals a filing asks for, held here rather than queued: one
 * delivered later would ask the model about this account's Inbox in whatever
 * case runs next, and be read as that case's own call.
 */
let refreshesAskedFor: EnrichmentJob[] = [];
let realQueue: typeof env.ENRICHMENT;

describe('Capture', () => {
  beforeEach(async () => {
    await alsoWorkspaces();
    await aDayToDayDashboard();
    refreshesAskedFor = [];
    realQueue = env.ENRICHMENT;
    env.ENRICHMENT = {
      send: async (job: EnrichmentJob, options?: QueueSendOptions) => {
        if (job.kind === 're-propose-panels') refreshesAskedFor.push(job);
        else await realQueue.send(job, options);
      },
      sendBatch: () => Promise.reject(new Error('nothing here sends a batch')),
    } as unknown as typeof env.ENRICHMENT;
  });

  afterEach(() => {
    env.ENRICHMENT = realQueue;
  });

  describe('reading where a note goes shows the model only names, and only of the workspaces the capture may reach', () => {
    const placeReadOf = async (capturedWith: object) => {
      theModelReadsAPlace({});
      asked.length = 0;
      const itemId = await captureANote(capturedWith);
      await untilTheChangeIsRecorded(itemId);
      return { place: asked.find(isAPlaceRead)?.system, cleanUp: asked.find(isACleanUp)!.system };
    };

    it('shows every live workspace, dashboard and panel for a capture to Any workspace, and none to the clean-up', async () => {
      const { place, cleanUp } = await placeReadOf({ workspaceDecided: false });

      for (const name of ['Workspace: Workspace 1', 'Workspace: Atlas Copco', 'Workspace: Personal', 'Dashboard: Day to day', '- Admin & money']) {
        expect(place).toContain(name);
      }
      expect(place).not.toContain(A_READING.title);
      expect(cleanUp).not.toContain('Personal');
    });

    it('shows only its own workspace for a capture made inside one', async () => {
      const { place } = await placeReadOf({});

      expect(place).toContain('Workspace: Workspace 1');
      expect(place).not.toContain('Workspace: Personal');
      expect(place).not.toContain('- Admin & money');
    });

    it('leaves out a deleted workspace, dashboard and panel', async () => {
      await inTheStore((sql) => {
        sql.exec("UPDATE workspaces SET deleted_at = '2026-09-01T00:00:00.000Z' WHERE id = 'ws-atlas'");
        sql.exec(
          "UPDATE dashboards SET name = 'Old board', folded_name = 'old board', deleted_at = '2026-09-01T00:00:00.000Z' WHERE id = 'ws-personal-dashboard-1'",
        );
        sql.exec(`UPDATE panels SET deleted_at = '2026-09-01T00:00:00.000Z' WHERE id = '${WEEK}'`);
      });

      const { place } = await placeReadOf({ workspaceDecided: false });

      expect(place).toContain('- Admin & money');
      for (const gone of ['Atlas Copco', 'Old board', 'This week']) expect(place).not.toContain(gone);
    });

    it('makes no second call for a capture naming no place', async () => {
      theModelReadsAPlace(null);
      const itemId = await captureANote({ workspaceDecided: false });
      await untilTheChangeIsRecorded(itemId);

      expect(asked.filter(isAPlaceRead)).toHaveLength(0);
    });
  });

  describe('a note is filed where it said, once, as your own filing, only if you have not dealt with it first', () => {
    it('settles an Any workspace note in Personal and files it at the top of Admin & money, out of every Inbox', async () => {
      const there = await alreadyOn(ADMIN);
      theModelReadsAPlace({ dashboard: 'Day to day', panels: ['Admin & money'] });

      const itemId = await captureANote({ workspaceDecided: false });
      await untilTheChangeIsRecorded(itemId);

      expect(await workspaceOf(itemId)).toMatchObject({ workspaceId: PERSONAL, decided: true });
      expect(await panelsHolding(itemId)).toEqual([{ panelId: ADMIN, position: 0 }]);
      expect(await panelsHolding(there)).toEqual([{ panelId: ADMIN, position: 1 }]);
      for (const workspaceId of [WORKSPACE_ID, PERSONAL]) expect(await itemsDrawnIn(workspaceId)).not.toContain(itemId);
    });

    it('files a note naming two panels at the top of each', async () => {
      const onAdmin = await alreadyOn(ADMIN);
      const onWeek = await alreadyOn(WEEK);
      theModelReadsAPlace({ panels: ['Admin & money', 'This week'] });

      const itemId = await captureANote({ workspaceDecided: false });
      await untilTheChangeIsRecorded(itemId);

      expect(await panelsHolding(itemId)).toEqual([
        { panelId: ADMIN, position: 0 },
        { panelId: WEEK, position: 0 },
      ]);
      expect(await panelsHolding(onAdmin)).toEqual([{ panelId: ADMIN, position: 1 }]);
      expect(await panelsHolding(onWeek)).toEqual([{ panelId: WEEK, position: 1 }]);
    });

    it('leaves a note where you put it when you filed it first', async () => {
      theModelReadsAPlace({ panels: ['Admin & money'] });
      const itemId = nextId();
      reading.during = duringThe(isACleanUp, () => moveOnto(itemId, WEEK, PERSONAL));

      await captureANote({ itemId, workspaceDecided: false });
      await untilTheChangeIsRecorded(itemId);

      expect(await panelsHolding(itemId)).toEqual([{ panelId: WEEK, position: 0 }]);
    });

    it('skips a panel deleted while the note was read, and with none left leaves it in the Inbox with its proposal', async () => {
      theModelReadsAPlace({ panels: ['Admin & money'] }, { choosing: { panelId: WEEK, reason: 'this week’s errands' } });
      const itemId = nextId();
      reading.during = duringThe(isAPlaceRead, () =>
        inTheStore((sql) => sql.exec(`UPDATE panels SET deleted_at = '2026-09-09T10:00:01.000Z' WHERE id = '${ADMIN}'`)),
      );

      await captureANote({ itemId, workspaceDecided: false });
      await untilTheChangeIsRecorded(itemId);

      expect(await panelsHolding(itemId)).toEqual([]);
      expect(await workspaceOf(itemId)).toMatchObject({ workspaceId: PERSONAL, decided: true });
      expect(await itemsDrawnIn(PERSONAL)).toContain(itemId);
      expect((await routingOf(itemId))?.proposed_panel_id).toBe(WEEK);
    });

    it('files on a panel set to Never propose', async () => {
      await inTheStore((sql) => sql.exec(`UPDATE panels SET never_propose = 1 WHERE id = '${ADMIN}'`));
      theModelReadsAPlace({ panels: ['Admin & money'] });

      const itemId = await captureANote({ workspaceDecided: false });
      await untilTheChangeIsRecorded(itemId);

      expect(await panelsHolding(itemId)).toEqual([{ panelId: ADMIN, position: 0 }]);
    });

    it('withdraws the panel proposed before it is filed', async () => {
      const workPanel = await aPanel('Compliance questions');
      theModelReadsAPlace(null, { cleanUp: { panel: { panelId: workPanel, reason: 'a compliance question' } } });
      const itemId = await captureANote({ workspaceDecided: false });
      await vi.waitFor(async () => expect((await routingOf(itemId))?.proposed_panel_id).toBe(workPanel), {
        timeout: 15_000,
        interval: 50,
      });

      theModelReadsAPlace({ panels: ['Admin & money'] });
      await handleQueue(batchOf({ kind: 'clean-up-a-note', accountName: ACCOUNT_NAME, itemId, attemptId: nextId() }), env);

      expect(await panelsHolding(itemId)).toEqual([{ panelId: ADMIN, position: 0 }]);
      expect(await routingOf(itemId)).toEqual({ proposed_panel_id: null, proposed_panel_reason: null });
    });
  });

  describe('routing learns from a note filed where it said, as from your first filing', () => {
    it.each([
      { situation: 'it is filed on one panel', place: { panels: ['Admin & money'] }, expected: [{ workspace_id: PERSONAL, chosen_panel_id: ADMIN, proposed_panel_id: null }] },
      { situation: 'nothing is filed', place: { panels: ['Groceries'] }, expected: [] },
    ])('records one decision, naming no proposal, where $situation', async ({ place, expected }) => {
      theModelReadsAPlace(place);

      const itemId = await captureANote({ workspaceDecided: false });
      await untilTheChangeIsRecorded(itemId);

      expect(await decisionsOn(itemId)).toEqual(expected);
    });

    it('asks for the rest of the workspace’s Inbox to be proposed again', async () => {
      theModelReadsAPlace({ panels: ['Admin & money'] });
      const itemId = await captureANote({ workspaceDecided: false });
      await untilTheChangeIsRecorded(itemId);

      expect(refreshesAskedFor).toEqual([expect.objectContaining({ kind: 're-propose-panels', workspaceId: PERSONAL })]);
    });
  });

  describe('every open tab is told a note filed where it said has moved', () => {
    it('tells the tabs of every workspace, whichever they are showing', async () => {
      // A first reading names no place, so the item waits in every Inbox.
      theModelReadsAPlace(null);
      const itemId = await captureANote({ workspaceDecided: false });
      await untilTheChangeIsRecorded(itemId);
      const from = await changesFrom('2026-09-08T00:00:00.000Z');

      theModelReadsAPlace({ panels: ['Admin & money'] });
      await handleQueue(batchOf({ kind: 'clean-up-a-note', accountName: ACCOUNT_NAME, itemId, attemptId: nextId() }), env);

      expect(await panelsHolding(itemId)).toHaveLength(1);
      const answer = await storeNamed(ACCOUNT_NAME).changesSince(ACCOUNT_NAME, from);
      const events = (answer as { value: { events: { type: string; workspaceId: string }[] } }).value.events;
      expect(events).toContainEqual(expect.objectContaining({ type: 'snapshot_invalidated', workspaceId: ACCOUNT_WIDE }));
    });
  });

  describe('a note read again, or read where the second call fails, is filed at most once', () => {
    it('files nothing, and still sets the title, priority and due date, where the read of the place fails', async () => {
      theModelReadsAPlace('fails', { cleanUp: { priority: 'high', dueDate: '2026-09-11' } });

      const itemId = await captureANote({ workspaceDecided: false, timeZone: 'Europe/Brussels' });
      await untilTheChangeIsRecorded(itemId);

      expect(await panelsHolding(itemId)).toEqual([]);
      expect((await historyOf(itemId))[0]?.status).toBe('rewritten');
      expect((await textsOf(itemId))?.title).toBe(A_READING.title);
      expect((await priorityOf(itemId))?.priority).toBe('high');
      expect((await dueDateOf(itemId))?.due_date).toBe('2026-09-11');
    });

    it('files once, with one decision, when the whole reading is delivered again after it filed', async () => {
      theModelReadsAPlace({ panels: ['Admin & money'] });
      const itemId = await captureANote({ workspaceDecided: false });
      await untilTheChangeIsRecorded(itemId);
      const [first] = await historyOf(itemId);

      await handleQueue(batchOf({ kind: 'clean-up-a-note', accountName: ACCOUNT_NAME, itemId, attemptId: first!.id }), env);

      expect(await panelsHolding(itemId)).toEqual([{ panelId: ADMIN, position: 0 }]);
      expect(await decisionsOn(itemId)).toHaveLength(1);
    });
  });
});
