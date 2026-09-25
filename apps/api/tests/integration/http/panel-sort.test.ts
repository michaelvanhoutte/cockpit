import { beforeEach, describe, expect, inject, it } from 'vitest';
import { applyD1Migrations, env } from 'cloudflare:test';
import type { Panel, WorkspaceSnapshot } from '@cockpit/shared';
import {
  OTHER_USER_ID,
  TASK_TYPE_ID,
  WORKSPACE_ID,
  asUser,
  inTheStore,
  seedRegister,
  startFromEmpty,
} from '../seed.js';

/**
 * Integration level, through the real Worker (`asUser`), because a Panel's sort
 * is a stored column read back through the real snapshot, and what is refused
 * is the real route's validation ("Sort a panel of items by the fields you
 * choose", issue 526). Which order a sort puts rows in is the client's, in
 * apps/web/tests/unit/sorting.test.ts.
 *
 * **A file of its own rather than more cases in panels.test.ts**, which is
 * already as long as one isolate of the Workers test pool survives: the pool
 * nests a Proxy around a Durable Object's prototype every time one is
 * constructed, so a long enough file overflows the stack and every later case
 * in it answers 500.
 */

let seq = 0;
function nextId(): string {
  seq += 1;
  return `018f0000-0000-7000-8000-${String(seq).padStart(12, '0')}`;
}

const AT = '2026-09-01T10:00:00.000Z';

async function send(command: string, body: Record<string, unknown>) {
  return asUser(`http://cockpit.test/v1/commands/${command}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ commandId: nextId(), issuedAt: AT, ...body }),
  });
}

/** A panel of the given kind, on a dashboard of its own so no case disturbs another's. */
async function aPanel(kind: 'items' | 'text' | 'filter' = 'items'): Promise<string> {
  const dashboardId = nextId();
  expect(
    (await send('add_dashboard', { workspaceId: WORKSPACE_ID, dashboardId, panelId: nextId(), name: `Today ${seq}` }))
      .status,
  ).toBe(200);
  const panelId = nextId();
  expect(
    (await send('add_panel', { workspaceId: WORKSPACE_ID, dashboardId, panelId, name: `Reading list ${seq}`, kind }))
      .status,
  ).toBe(200);
  return panelId;
}

async function snapshot(): Promise<WorkspaceSnapshot> {
  const res = await asUser(`http://cockpit.test/v1/workspaces/${WORKSPACE_ID}/snapshot`);
  expect(res.status).toBe(200);
  return (await res.json()) as WorkspaceSnapshot;
}

/** One panel as the snapshot hands it back. */
async function panelNow(panelId: string): Promise<Panel> {
  const found = (await snapshot()).panels.find((panel) => panel.id === panelId);
  expect(found).toBeDefined();
  return found!;
}

async function anItem(message: string): Promise<string> {
  const itemId = nextId();
  expect(
    (await send('capture_item', { workspaceId: WORKSPACE_ID, itemId, message, typeId: TASK_TYPE_ID })).status,
  ).toBe(200);
  return itemId;
}

/** Files an item by writing the row, so what is asked is what the sort does to it, not what filing does. */
async function fileOn(panelId: string, itemId: string, position: number): Promise<void> {
  await inTheStore((sql) =>
    sql.exec(
      'INSERT INTO panel_items (tenant_id, panel_id, item_id, position, created_at) VALUES (?, ?, ?, ?, ?)',
      'tenant-default',
      panelId,
      itemId,
      position,
      AT,
    ),
  );
}

/** The items filed on one panel, in the order it holds them. */
async function filingsOn(panelId: string): Promise<string[]> {
  return (await snapshot()).filings
    .filter((filing) => filing.panelId === panelId)
    .sort((a, b) => a.position - b.position)
    .map((filing) => filing.itemId);
}

/** A sort by two fields: soonest due first, then High before Low wherever two are due the same day. */
const BY_DUE_THEN_PRIORITY = [
  { field: 'dueDate', direction: 'asc' },
  { field: 'priority', direction: 'desc' },
];

/** How a panel of items is sorted, or null for Manual; `userId` signs in as someone else. */
function setSort(panelId: string, sort: unknown, commandId?: string, userId?: string) {
  return asUser(
    'http://cockpit.test/v1/commands/set_panel_sort',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        commandId: commandId ?? nextId(),
        issuedAt: AT,
        workspaceId: WORKSPACE_ID,
        panelId,
        sort,
      }),
    },
    userId,
  );
}

beforeEach(async () => {
  await applyD1Migrations(env.DB, inject('migrations'));
  await startFromEmpty();
  await seedRegister();
  seq = 0;
});

describe('Panels', () => {
  describe('a panel’s sort is kept on the panel, and Manual is having none', () => {
    it('reads back a saved sort, Manual once it is set back, and Manual where it was never sorted', async () => {
      const panelId = await aPanel();
      expect((await panelNow(panelId)).sort).toBeNull();

      expect((await setSort(panelId, BY_DUE_THEN_PRIORITY)).status).toBe(200);
      expect((await panelNow(panelId)).sort).toEqual(BY_DUE_THEN_PRIORITY);

      expect((await setSort(panelId, null)).status).toBe(200);
      expect((await panelNow(panelId)).sort).toBeNull();
    });

    it('leaves the order its items were filed in untouched, sorted or back to Manual', async () => {
      const panelId = await aPanel();
      const first = await anItem('First filed');
      const second = await anItem('Second filed');
      await fileOn(panelId, second, 0);
      await fileOn(panelId, first, 1);

      await setSort(panelId, [{ field: 'title', direction: 'asc' }]);
      expect(await filingsOn(panelId)).toEqual([second, first]);
      await setSort(panelId, null);
      expect(await filingsOn(panelId)).toEqual([second, first]);
    });

    it('applies the same change once, however many times it is sent', async () => {
      const panelId = await aPanel();
      const commandId = nextId();
      expect((await setSort(panelId, BY_DUE_THEN_PRIORITY, commandId)).status).toBe(200);
      await setSort(panelId, null);

      // The first change arriving again, after a later one, changes nothing.
      const again = await setSort(panelId, BY_DUE_THEN_PRIORITY, commandId);

      expect(await again.json()).toEqual({ ok: true, applied: false });
      expect((await panelNow(panelId)).sort).toBeNull();
    });

    it.each([
      { situation: 'what cannot be read at all', stored: '{not json' },
      {
        situation: 'a field this release has never heard of',
        stored: JSON.stringify({ criteria: [{ field: 'weather', direction: 'asc' }] }),
      },
    ])('reads $situation as Manual, and the workspace still opens', async ({ stored }) => {
      // Written straight into the store: only a release this one is not can
      // write either, so no request here can drive it.
      const panelId = await aPanel();
      await inTheStore((sql) =>
        sql.exec('UPDATE panels SET sort_criteria = ? WHERE id = ?', stored, panelId),
      );

      expect(await panelNow(panelId)).toMatchObject({ kind: 'items', sort: null });
    });

    it.each([
      {
        situation: 'a field twice',
        kind: 'items' as const,
        sort: [
          { field: 'dueDate', direction: 'asc' },
          { field: 'dueDate', direction: 'desc' },
        ],
      },
      { situation: 'a field nothing knows about', kind: 'items' as const, sort: [{ field: 'weather', direction: 'asc' }] },
      { situation: 'a direction nothing knows about', kind: 'items' as const, sort: [{ field: 'title', direction: 'sideways' }] },
      { situation: 'no field at all, where Manual is having no sort', kind: 'items' as const, sort: [] },
      { situation: 'a panel of text, which has no rows', kind: 'text' as const, sort: BY_DUE_THEN_PRIORITY },
      // Until "Choose how a Filter's rows are sorted" (issue 527).
      { situation: 'a Filter, whose order is its own', kind: 'filter' as const, sort: BY_DUE_THEN_PRIORITY },
    ])('refuses a sort of $situation, and stores nothing of it', async ({ kind, sort }) => {
      const panelId = await aPanel(kind);

      expect((await setSort(panelId, sort)).status).toBe(400);

      expect((await panelNow(panelId)).sort).toBeNull();
    });

    it('refuses sorting a panel that has been deleted', async () => {
      const panelId = await aPanel();
      expect((await send('delete_panel', { workspaceId: WORKSPACE_ID, panelId })).status).toBe(200);

      expect((await setSort(panelId, BY_DUE_THEN_PRIORITY)).status).toBe(404);
    });

    it('never sorts another account’s panel', async () => {
      const panelId = await aPanel();

      const theirs = await setSort(panelId, BY_DUE_THEN_PRIORITY, undefined, OTHER_USER_ID);

      expect(theirs.status).toBe(404);
      expect((await panelNow(panelId)).sort).toBeNull();
    });
  });
});
