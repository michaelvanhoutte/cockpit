import { beforeEach, describe, expect, inject, it } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { ACCOUNT_WIDE } from '@cockpit/shared';
import type { CommandName, CommandPayload, ScreenSize, WorkspaceSnapshot } from '@cockpit/shared';
import {
  ACCOUNT_NAME,
  DASHBOARD_ID,
  TASK_TYPE_ID,
  WORKSPACE_ID,
  alsoWorkspaces,
  asUser,
  inTheStore,
  seedRegister,
  startFromEmpty,
} from '../seed.js';

/**
 * Integration level, through the real Worker, for the same reason
 * `item-types.test.ts` is: every rule here is about what a query returns or
 * what an index refuses once real rows are behind it. Making the fixture
 * layouts needs writing straight into the store - the exception the testing
 * skill allows for a rule the real interface cannot reach, because no command
 * writes a layout's screen size until "Draw a dashboard against the screen
 * sizes its account has" (issue 263) makes `save_layout` do it.
 */
async function postChange<N extends CommandName>(name: N, payload: CommandPayload<N>) {
  return asUser(`http://cockpit.test/v1/commands/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

let seq = 0;
const nextId = () => {
  seq += 1;
  return `018f0000-0000-7000-8000-${String(seq).padStart(12, '0')}`;
};

const envelope = () => ({
  commandId: nextId(),
  issuedAt: '2026-09-08T10:00:00.000Z',
  workspaceId: ACCOUNT_WIDE,
});

/** The account's screen sizes, as any workspace's snapshot reads them. */
async function theSizes(workspaceId: string = WORKSPACE_ID): Promise<ScreenSize[]> {
  const response = await asUser(`http://cockpit.test/v1/workspaces/${workspaceId}/snapshot`);
  expect(response.status).toBe(200);
  return ((await response.json()) as WorkspaceSnapshot).screenSizes;
}

const named = async (name: string) => (await theSizes()).find((size) => size.name === name);

/** A layout at a screen size, written straight in - see the file comment. */
async function putLayoutAtSize(layout: {
  id: string;
  dashboardId: string;
  screenSizeId: string | null;
  width: number;
}): Promise<void> {
  await inTheStore((sql) => {
    sql.exec(
      `INSERT INTO layouts (id, tenant_id, dashboard_id, name, folded_name, screen_width, screen_size_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      layout.id,
      ACCOUNT_NAME,
      layout.dashboardId,
      layout.id,
      layout.id,
      layout.width,
      layout.screenSizeId,
      '2026-09-08T10:00:00.000Z',
    );
    sql.exec(
      `INSERT INTO layout_rows (tenant_id, layout_id, row_index, height) VALUES (?, ?, 0, NULL)`,
      ACCOUNT_NAME,
      layout.id,
    );
  });
}

async function rowCount(table: string, where: string, ...params: unknown[]): Promise<number> {
  return inTheStore(
    (sql) => sql.exec(`SELECT 1 FROM ${table} WHERE ${where}`, ...params).toArray().length,
  );
}

beforeEach(async () => {
  await applyD1Migrations(env.DB, inject('migrations'));
  await startFromEmpty();
  await seedRegister();
});

describe('Layouts', () => {
  describe('a screen size belongs to the account, not to a dashboard or a workspace', () => {
    it('is offered in every workspace once made, from one row', async () => {
      await alsoWorkspaces();

      const response = await postChange('create_screen_size', {
        ...envelope(),
        screenSizeId: nextId(),
        name: 'Wide',
        width: 1280,
      });

      expect(response.status).toBe(200);
      expect((await theSizes(WORKSPACE_ID)).map((s) => s.name)).toEqual(['Wide']);
      expect((await theSizes('ws-atlas')).map((s) => s.name)).toEqual(['Wide']);
    });

    it('is seen by every workspace even when the change was sent from one of them', async () => {
      await alsoWorkspaces();

      // Sent from a real workspace rather than the account-wide sentinel, the
      // way a change is sent from wherever the size happens to be managed -
      // this must not leave any other open tab unable to tell the account's
      // list has moved on.
      await postChange('create_screen_size', {
        commandId: nextId(),
        issuedAt: '2026-09-08T10:00:00.000Z',
        workspaceId: WORKSPACE_ID,
        screenSizeId: nextId(),
        name: 'Wide',
        width: 1280,
      });

      const stored = await inTheStore((sql) =>
        sql.exec('SELECT workspace_id FROM commands ORDER BY received_at DESC LIMIT 1').toArray(),
      );
      expect(stored).toEqual([{ workspace_id: ACCOUNT_WIDE }]);
    });
  });

  describe('a screen size is only ever made deliberately', () => {
    it('takes the name and width typed in, and nothing else', async () => {
      const response = await postChange('create_screen_size', {
        ...envelope(),
        screenSizeId: nextId(),
        name: 'Phone',
        width: 430,
      });

      expect(response.status).toBe(200);
      expect(await named('Phone')).toMatchObject({ name: 'Phone', width: 430 });
    });

    it.each([
      { situation: 'a name another size already has', name: 'Wide', width: 1000, answers: 409 },
      { situation: 'that name in another capitalisation', name: 'WIDE', width: 1000, answers: 409 },
      { situation: 'no name at all', name: '', width: 1000, answers: 400 },
      { situation: 'a width of zero', name: 'Tiny', width: 0, answers: 400 },
    ])('refuses $situation', async ({ name, width, answers }) => {
      await postChange('create_screen_size', {
        ...envelope(),
        screenSizeId: nextId(),
        name: 'Wide',
        width: 1280,
      });

      const response = await postChange('create_screen_size', {
        ...envelope(),
        screenSizeId: nextId(),
        name,
        width,
      } as CommandPayload<'create_screen_size'>);

      expect(response.status).toBe(answers);
      expect((await theSizes()).map((s) => s.name)).toEqual(['Wide']);
    });

    it('never makes a second size for an id the account already has, whatever the second create asks', async () => {
      const screenSizeId = nextId();
      await postChange('create_screen_size', { ...envelope(), screenSizeId, name: 'Wide', width: 1280 });

      // A fresh command id each time, so neither of these is the ordinary
      // idempotent replay of one request - both are the same size id arriving
      // a second time, the way a retried request whose first answer was lost
      // would send it (R11). Asking for the name it already has collides on
      // the name first and is refused the same as any other name-taken create;
      // asking for a name nothing has still may not create a second row for an
      // id the account already has, so the id itself is what a bare
      // `onConflictDoNothing` guards.
      const sameName = await postChange('create_screen_size', {
        ...envelope(),
        screenSizeId,
        name: 'Wide',
        width: 1280,
      });
      const differentName = await postChange('create_screen_size', {
        ...envelope(),
        screenSizeId,
        name: 'Laptop',
        width: 1600,
      });

      expect(sameName.status).toBe(409);
      expect(differentName.status).toBe(200);
      expect(await theSizes()).toEqual([expect.objectContaining({ id: screenSizeId, name: 'Wide' })]);
    });
  });

  describe('renaming a screen size changes it wherever it is offered', () => {
    it('renames it, and gives its old name back', async () => {
      await alsoWorkspaces();
      const screenSizeId = nextId();
      await postChange('create_screen_size', { ...envelope(), screenSizeId, name: 'Wide', width: 1280 });

      expect(
        (await postChange('rename_screen_size', { ...envelope(), screenSizeId, name: 'Laptop' })).status,
      ).toBe(200);

      expect((await theSizes(WORKSPACE_ID)).map((s) => s.name)).toEqual(['Laptop']);
      expect((await theSizes('ws-atlas')).map((s) => s.name)).toEqual(['Laptop']);
      // The old name is free, which is what makes renaming reversible.
      expect(
        (
          await postChange('create_screen_size', {
            ...envelope(),
            screenSizeId: nextId(),
            name: 'Wide',
            width: 1000,
          })
        ).status,
      ).toBe(200);
    });

    it.each([
      { situation: 'a name another size already has', name: 'Phone', answers: 409 },
      { situation: 'its own name back', name: 'Wide', answers: 200 },
      { situation: 'a name nothing has', name: 'Laptop', answers: 200 },
    ])('renaming a size to $situation', async ({ name, answers }) => {
      const wide = nextId();
      await postChange('create_screen_size', { ...envelope(), screenSizeId: wide, name: 'Wide', width: 1280 });
      await postChange('create_screen_size', {
        ...envelope(),
        screenSizeId: nextId(),
        name: 'Phone',
        width: 430,
      });

      const response = await postChange('rename_screen_size', {
        ...envelope(),
        screenSizeId: wide,
        name,
      });

      expect(response.status).toBe(answers);
    });

    it('refuses a size that is not there, and stores nothing', async () => {
      const gone = nextId();
      const payload = { ...envelope(), screenSizeId: gone, name: 'Wide' };

      const response = await postChange('rename_screen_size', payload);

      expect(response.status).toBe(404);
      expect(
        await inTheStore((sql) =>
          sql.exec('SELECT * FROM commands WHERE command_id = ?', payload.commandId).toArray(),
        ),
      ).toHaveLength(0);
    });
  });

  describe('deleting a screen size takes every dashboard’s layout at it, and leaves everything else alone', () => {
    it('removes the layouts it arranges on every dashboard of every workspace, and only those', async () => {
      await alsoWorkspaces();
      const wide = nextId();
      const laptop = nextId();
      await postChange('create_screen_size', { ...envelope(), screenSizeId: wide, name: 'Wide', width: 1280 });
      await postChange('create_screen_size', { ...envelope(), screenSizeId: laptop, name: 'Laptop', width: 1600 });
      const panelId = nextId();
      const addPanel = await postChange('add_panel', {
        ...envelope(),
        workspaceId: WORKSPACE_ID,
        dashboardId: DASHBOARD_ID,
        panelId,
        name: 'Reading',
        kind: 'items',
      });
      expect(addPanel.status).toBe(200);
      const itemId = nextId();
      await postChange('capture_item', {
        ...envelope(),
        workspaceId: WORKSPACE_ID,
        itemId,
        message: 'Read the proposal',
        typeId: TASK_TYPE_ID,
      });
      const filed = await postChange('add_item_to_panel', {
        ...envelope(),
        workspaceId: WORKSPACE_ID,
        itemId,
        panelId,
        order: [itemId],
      });
      expect(filed.status).toBe(200);

      // Two dashboards' worth of Layouts at the size being deleted, one of
      // them carrying the arrangement above, plus one at a size that survives.
      await putLayoutAtSize({ id: 'lay-here-wide', dashboardId: DASHBOARD_ID, screenSizeId: wide, width: 1280 });
      await inTheStore((sql) => {
        sql.exec(
          `INSERT INTO panel_placements (tenant_id, layout_id, panel_id, row_index, position, span)
           VALUES (?, 'lay-here-wide', ?, 0, 0, 12)`,
          ACCOUNT_NAME,
          panelId,
        );
      });
      await putLayoutAtSize({
        id: 'lay-elsewhere-wide',
        dashboardId: 'ws-atlas-dashboard-1',
        screenSizeId: wide,
        width: 1300,
      });
      await putLayoutAtSize({
        id: 'lay-here-laptop',
        dashboardId: DASHBOARD_ID,
        screenSizeId: laptop,
        width: 1600,
      });

      const response = await postChange('delete_screen_size', { ...envelope(), screenSizeId: wide });

      expect(response.status).toBe(200);
      expect(await rowCount('layouts', 'id = ?', 'lay-here-wide')).toBe(0);
      expect(await rowCount('layouts', 'id = ?', 'lay-elsewhere-wide')).toBe(0);
      expect(await rowCount('layout_rows', 'layout_id = ?', 'lay-here-wide')).toBe(0);
      expect(await rowCount('panel_placements', 'layout_id = ?', 'lay-here-wide')).toBe(0);
      // The size itself, and only that size.
      expect((await theSizes()).map((s) => s.name)).toEqual(['Laptop']);
      // Untouched: a Layout at a size that was not deleted keeps its rows.
      expect(await rowCount('layouts', 'id = ?', 'lay-here-laptop')).toBe(1);
      // The Panel and the Item filed on it are untouched - `panel_placements`
      // is where a Panel sits in a Layout, `panel_items` is what is filed on
      // one, and deleting the first must never reach the second.
      expect(await rowCount('panels', 'id = ?', panelId)).toBe(1);
      expect(await rowCount('panel_items', 'panel_id = ? AND item_id = ?', panelId, itemId)).toBe(1);
    });

    it('is allowed to take the account’s last screen size', async () => {
      const only = nextId();
      await postChange('create_screen_size', { ...envelope(), screenSizeId: only, name: 'Wide', width: 1280 });

      const response = await postChange('delete_screen_size', { ...envelope(), screenSizeId: only });

      expect(response.status).toBe(200);
      expect(await theSizes()).toEqual([]);
    });

    it('refuses a size that is not there, and stores nothing', async () => {
      const gone = nextId();
      const payload = { ...envelope(), screenSizeId: gone };

      const response = await postChange('delete_screen_size', payload);

      expect(response.status).toBe(404);
      expect(
        await inTheStore((sql) =>
          sql.exec('SELECT * FROM commands WHERE command_id = ?', payload.commandId).toArray(),
        ),
      ).toHaveLength(0);
    });

    it('refuses the same delete sent again under a fresh request id', async () => {
      const wide = nextId();
      await postChange('create_screen_size', { ...envelope(), screenSizeId: wide, name: 'Wide', width: 1280 });
      await postChange('delete_screen_size', { ...envelope(), screenSizeId: wide });

      const again = await postChange('delete_screen_size', { ...envelope(), screenSizeId: wide });

      expect(again.status).toBe(404);
    });

    it('deletes every layout at the size across enough dashboards to cross one statement’s bound values', async () => {
      const wide = nextId();
      await postChange('create_screen_size', { ...envelope(), screenSizeId: wide, name: 'Wide', width: 1280 });
      const COUNT = 150;
      const dashboardIds = Array.from({ length: COUNT }, (_, i) => `dash-bulk-${i}`);
      await inTheStore((sql) => {
        for (const dashboardId of dashboardIds) {
          sql.exec(
            `INSERT INTO dashboards (id, tenant_id, workspace_id, name, folded_name, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
            dashboardId,
            ACCOUNT_NAME,
            WORKSPACE_ID,
            dashboardId,
            dashboardId,
            '2026-09-08T10:00:00.000Z',
          );
        }
      });
      for (const dashboardId of dashboardIds) {
        await putLayoutAtSize({ id: `lay-${dashboardId}`, dashboardId, screenSizeId: wide, width: 1280 });
      }

      const response = await postChange('delete_screen_size', { ...envelope(), screenSizeId: wide });

      expect(response.status).toBe(200);
      expect(await rowCount('layouts', "id LIKE 'lay-dash-bulk-%'")).toBe(0);
    });
  });
});
