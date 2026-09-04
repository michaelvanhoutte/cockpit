import { beforeEach, describe, expect, inject, it } from 'vitest';
import { applyD1Migrations, env } from 'cloudflare:test';
import type { Layout, Panel, WorkspaceSnapshot } from '@cockpit/shared';
import { WORKSPACE_ID, asUser, seedRegister, startFromEmpty } from '../seed.js';

/**
 * Integration level, through the real Worker (`asUser`), because every rule
 * below is about what a query returns or what an index refuses - none of it
 * holds anywhere but against a real store. Where a new panel lands in a layout
 * and which panels an arrangement may name are pure decisions and are settled
 * in apps/api/tests/unit/domain/panels.test.ts; what is asked here is the scope
 * those decisions are applied in, and what actually ends up stored.
 *
 * What these cases write survives into the next one, so every case makes its
 * own dashboard and names its own panels rather than reusing a fixed one.
 */

let seq = 0;
function nextId(): string {
  seq += 1;
  return `018f0000-0000-7000-8000-${String(seq).padStart(12, '0')}`;
}
function aName(): string {
  seq += 1;
  return `Reading list ${seq}`;
}

const AT = '2026-09-01T10:00:00.000Z';

async function send(command: string, body: Record<string, unknown>) {
  return asUser(`http://cockpit.test/v1/commands/${command}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ commandId: nextId(), issuedAt: AT, ...body }),
  });
}

/** A dashboard of the seeded workspace, so a case cannot disturb another's. */
async function aDashboard(): Promise<string> {
  const dashboardId = nextId();
  const made = await send('add_dashboard', {
    workspaceId: WORKSPACE_ID,
    dashboardId,
    name: `Today ${seq}`,
  });
  expect(made.status).toBe(200);
  return dashboardId;
}

async function addPanel(
  dashboardId: string,
  name: string,
  overrides: { panelId?: string; commandId?: string; workspaceId?: string } = {},
) {
  return send('add_panel', {
    workspaceId: overrides.workspaceId ?? WORKSPACE_ID,
    dashboardId,
    panelId: overrides.panelId ?? nextId(),
    name,
    ...(overrides.commandId ? { commandId: overrides.commandId } : {}),
  });
}

async function saveLayout(
  dashboardId: string,
  layoutId: string,
  screenWidth: number,
  placements: { panelId: string; columns: number; rows: number }[],
) {
  return send('save_layout', {
    workspaceId: WORKSPACE_ID,
    dashboardId,
    layoutId,
    screenWidth,
    placements,
  });
}

async function snapshot(workspaceId: string = WORKSPACE_ID): Promise<WorkspaceSnapshot> {
  const res = await asUser(`http://cockpit.test/v1/workspaces/${workspaceId}/snapshot`);
  expect(res.status).toBe(200);
  return (await res.json()) as WorkspaceSnapshot;
}

async function panelsOn(dashboardId: string): Promise<Panel[]> {
  return (await snapshot()).panels.filter((panel) => panel.dashboardId === dashboardId);
}

async function layoutsOf(dashboardId: string): Promise<Layout[]> {
  return (await snapshot()).layouts.filter((layout) => layout.dashboardId === dashboardId);
}

/** What a case has already arranged before the change under test is made. */
interface Context {
  dashboardId: string;
  panelId: string;
}

beforeEach(async () => {
  await applyD1Migrations(env.DB, inject('migrations'));
  await startFromEmpty();
  await seedRegister();
  seq = 0;
});

describe('Panels', () => {
  describe('a dashboard shows the panels put on it, and nothing from another dashboard', () => {
    it('lists each dashboard’s own, oldest first, and leaves a deleted one out', async () => {
      const today = await aDashboard();
      const research = await aDashboard();
      const first = nextId();
      const second = nextId();
      const doomed = nextId();
      await addPanel(today, 'Project Falcon', { panelId: first });
      await addPanel(today, 'People to talk to', { panelId: second });
      await addPanel(today, 'Gone by lunchtime', { panelId: doomed });
      await addPanel(research, 'To read', { panelId: nextId() });

      await send('delete_panel', { workspaceId: WORKSPACE_ID, panelId: doomed });

      expect((await panelsOn(today)).map((panel) => panel.name)).toEqual([
        'Project Falcon',
        'People to talk to',
      ]);
      expect((await panelsOn(research)).map((panel) => panel.name)).toEqual(['To read']);
    });

    it('takes them off every screen when the dashboard itself goes', async () => {
      // Nothing in the delete touches the panels; every read of one joins to a
      // live dashboard, which is what makes tombstoning the dashboard enough.
      const doomed = await aDashboard();
      await addPanel(doomed, 'Project Falcon');

      await send('delete_dashboard', { workspaceId: WORKSPACE_ID, dashboardId: doomed });

      expect(await panelsOn(doomed)).toEqual([]);
    });
  });

  describe('two panels of one dashboard never go by the same name, and two dashboards may each have a Reading list', () => {
    it.each([
      { situation: 'the same name', as: (name: string) => name, refused: true },
      { situation: 'the same name in another case', as: (name: string) => name.toUpperCase(), refused: true },
      { situation: 'the same name with blanks around it', as: (name: string) => `  ${name}  `, refused: true },
      { situation: 'a name nothing else on the dashboard holds', as: () => 'Something else', refused: false },
    ])('$situation', async ({ as, refused }) => {
      const today = await aDashboard();
      const name = aName();
      await addPanel(today, name);

      const again = await addPanel(today, as(name));

      expect(again.status).toBe(refused ? 409 : 200);
    });

    it('is allowed on another dashboard of the same workspace', async () => {
      const today = await aDashboard();
      const research = await aDashboard();
      const name = aName();
      await addPanel(today, name);

      expect((await addPanel(research, name)).status).toBe(200);
    });

    it('is allowed again once the panel holding the name is deleted', async () => {
      const today = await aDashboard();
      const name = aName();
      const panelId = nextId();
      await addPanel(today, name, { panelId });

      await send('delete_panel', { workspaceId: WORKSPACE_ID, panelId });

      expect((await addPanel(today, name)).status).toBe(200);
    });

    it('lets a panel keep its own name in another capitalization', async () => {
      const today = await aDashboard();
      const panelId = nextId();
      await addPanel(today, 'Project Falcon', { panelId });

      const renamed = await send('rename_panel', {
        workspaceId: WORKSPACE_ID,
        panelId,
        name: 'PROJECT FALCON',
      });

      expect(renamed.status).toBe(200);
      expect((await panelsOn(today)).map((panel) => panel.name)).toEqual(['PROJECT FALCON']);
    });

    it('stores the name without the blanks around it', async () => {
      const today = await aDashboard();
      await addPanel(today, '  Project Falcon  ');

      expect((await panelsOn(today)).map((panel) => panel.name)).toEqual(['Project Falcon']);
    });
  });

  describe('a change to something that is no longer there is refused and nothing is stored', () => {
    it.each([
      {
        situation: 'a panel added to a dashboard that does not exist',
        change: (ctx: Context) =>
          addPanel('018f0000-0000-7000-8000-999999999999', 'Project Falcon'),
      },
      {
        situation: 'a panel added to a dashboard of a workspace that does not exist',
        change: (ctx: Context) =>
          addPanel(ctx.dashboardId, 'Project Falcon', { workspaceId: 'ws-nope' }),
      },
      {
        situation: 'a panel renamed after it was deleted',
        change: async (ctx: Context) => {
          await send('delete_panel', { workspaceId: WORKSPACE_ID, panelId: ctx.panelId });
          return send('rename_panel', {
            workspaceId: WORKSPACE_ID,
            panelId: ctx.panelId,
            name: 'Too late',
          });
        },
      },
      {
        situation: 'a panel deleted a second time',
        change: async (ctx: Context) => {
          await send('delete_panel', { workspaceId: WORKSPACE_ID, panelId: ctx.panelId });
          return send('delete_panel', { workspaceId: WORKSPACE_ID, panelId: ctx.panelId });
        },
      },
      {
        situation: 'an arrangement naming a panel of another dashboard',
        change: async (ctx: Context) => {
          const elsewhere = await aDashboard();
          const stranger = nextId();
          await addPanel(elsewhere, 'Somewhere else', { panelId: stranger });
          return saveLayout(ctx.dashboardId, nextId(), 1280, [
            { panelId: stranger, columns: 4, rows: 3 },
          ]);
        },
      },
      {
        situation: 'an arrangement of a layout that belongs to another dashboard',
        change: async (ctx: Context) => {
          const elsewhere = await aDashboard();
          const layoutId = nextId();
          await saveLayout(elsewhere, layoutId, 1280, []);
          return saveLayout(ctx.dashboardId, layoutId, 1280, []);
        },
      },
      {
        situation: 'a layout deleted a second time',
        change: async (ctx: Context) => {
          const layoutId = nextId();
          await saveLayout(ctx.dashboardId, layoutId, 1280, []);
          await send('delete_layout', { workspaceId: WORKSPACE_ID, layoutId });
          return send('delete_layout', { workspaceId: WORKSPACE_ID, layoutId });
        },
      },
    ])('$situation', async ({ change }) => {
      const dashboardId = await aDashboard();
      const panelId = nextId();
      await addPanel(dashboardId, aName(), { panelId });

      const refused = await change({ dashboardId, panelId });

      expect(refused.status).toBe(404);
    });

    it.each([
      { situation: 'a panel wider than the grid', columns: 13, rows: 3 },
      { situation: 'a panel of no width at all', columns: 0, rows: 3 },
      { situation: 'a panel taller than anything could show', columns: 4, rows: 99 },
      { situation: 'a panel measured in half columns', columns: 4.5, rows: 3 },
    ])('refuses an arrangement with $situation', async ({ columns, rows }) => {
      const dashboardId = await aDashboard();
      const panelId = nextId();
      await addPanel(dashboardId, aName(), { panelId });

      const refused = await saveLayout(dashboardId, nextId(), 1280, [{ panelId, columns, rows }]);

      expect(refused.status).toBe(400);
      expect(await layoutsOf(dashboardId)).toEqual([]);
    });

    it('refuses an arrangement that puts one panel in two places', async () => {
      const dashboardId = await aDashboard();
      const panelId = nextId();
      await addPanel(dashboardId, aName(), { panelId });

      const refused = await saveLayout(dashboardId, nextId(), 1280, [
        { panelId, columns: 4, rows: 3 },
        { panelId, columns: 8, rows: 3 },
      ]);

      expect(refused.status).toBe(400);
      expect(await layoutsOf(dashboardId)).toEqual([]);
    });
  });

  describe('the same change sent twice changes one thing', () => {
    it('adds one panel however many times the request is repeated', async () => {
      const dashboardId = await aDashboard();
      const commandId = nextId();
      const panelId = nextId();
      await addPanel(dashboardId, 'Project Falcon', { commandId, panelId });

      const again = await addPanel(dashboardId, 'Project Falcon', { commandId, panelId });

      expect(await again.json()).toEqual({ ok: true, applied: false });
      expect(await panelsOn(dashboardId)).toHaveLength(1);
    });
  });

  describe('a dashboard remembers one arrangement per screen size, and arranging it again replaces what it held', () => {
    it('stores the panels in the order given, at the sizes given', async () => {
      const dashboardId = await aDashboard();
      const falcon = nextId();
      const reading = nextId();
      await addPanel(dashboardId, 'Project Falcon', { panelId: falcon });
      await addPanel(dashboardId, 'To read', { panelId: reading });

      await saveLayout(dashboardId, nextId(), 1280, [
        { panelId: reading, columns: 8, rows: 2 },
        { panelId: falcon, columns: 4, rows: 5 },
      ]);

      expect(await layoutsOf(dashboardId)).toEqual([
        expect.objectContaining({
          screenWidth: 1280,
          placements: [
            { panelId: reading, columns: 8, rows: 2 },
            { panelId: falcon, columns: 4, rows: 5 },
          ],
        }),
      ]);
    });

    it('replaces what the layout held rather than adding to it', async () => {
      const dashboardId = await aDashboard();
      const falcon = nextId();
      const reading = nextId();
      await addPanel(dashboardId, 'Project Falcon', { panelId: falcon });
      await addPanel(dashboardId, 'To read', { panelId: reading });
      const layoutId = nextId();
      await saveLayout(dashboardId, layoutId, 1280, [
        { panelId: falcon, columns: 4, rows: 3 },
        { panelId: reading, columns: 4, rows: 3 },
      ]);

      await saveLayout(dashboardId, layoutId, 1280, [{ panelId: falcon, columns: 12, rows: 3 }]);

      expect((await layoutsOf(dashboardId))[0]?.placements).toEqual([
        { panelId: falcon, columns: 12, rows: 3 },
      ]);
    });

    it('keeps the width a layout was made at, even when it is changed from another screen', async () => {
      // The whole point of asking which layout to change: changing the wide
      // one from a laptop must not quietly turn it into the laptop's.
      const dashboardId = await aDashboard();
      const falcon = nextId();
      await addPanel(dashboardId, 'Project Falcon', { panelId: falcon });
      const layoutId = nextId();
      await saveLayout(dashboardId, layoutId, 2560, [{ panelId: falcon, columns: 3, rows: 3 }]);

      await saveLayout(dashboardId, layoutId, 480, [{ panelId: falcon, columns: 6, rows: 3 }]);

      expect((await layoutsOf(dashboardId))[0]).toMatchObject({ screenWidth: 2560 });
    });

    it('keeps one layout per screen size side by side', async () => {
      const dashboardId = await aDashboard();
      const falcon = nextId();
      await addPanel(dashboardId, 'Project Falcon', { panelId: falcon });

      await saveLayout(dashboardId, nextId(), 2560, [{ panelId: falcon, columns: 3, rows: 3 }]);
      await saveLayout(dashboardId, nextId(), 480, [{ panelId: falcon, columns: 12, rows: 3 }]);

      expect((await layoutsOf(dashboardId)).map((layout) => layout.screenWidth)).toEqual([480, 2560]);
    });

    // Given longer than the file's other cases, and it is the arrangement that
    // needs it: a hundred and twenty layouts are a hundred and twenty changes,
    // and they are made the way a person makes them rather than written into
    // the store, so that what is under test is a workspace somebody could
    // actually have. About four seconds here and slower on a shared runner,
    // where the default five would be a coin toss.
    it('still reads the workspace when it holds more layouts than a statement can name', { timeout: 30_000 }, async () => {
      // A workspace accumulates a layout per dashboard per screen, and the read
      // that paints it once named every one of them in a single statement -
      // which SQLite refuses past a limit, failing the *whole* workspace read
      // rather than a part of it. So the workspace stopped painting at all, and
      // did so at a size a person reaches by using the product normally.
      const dashboardId = await aDashboard();
      const falcon = nextId();
      await addPanel(dashboardId, 'Project Falcon', { panelId: falcon });
      // Comfortably past the limit rather than exactly on it, so the case goes
      // on being about the limit if the limit ever moves. Sent together rather
      // than one after another: the store serialises them anyway, and a hundred
      // and twenty round trips in a row is the difference between a case that
      // runs in a moment and one that outlasts the runner's patience.
      const widths = Array.from({ length: 120 }, (_, at) => 320 + at);
      const saved = await Promise.all(
        widths.map((screenWidth) =>
          saveLayout(dashboardId, nextId(), screenWidth, [
            { panelId: falcon, columns: 3, rows: 3 },
          ]),
        ),
      );
      expect(saved.every((res) => res.status === 200)).toBe(true);

      const its = await layoutsOf(dashboardId);

      expect(its).toHaveLength(widths.length);
      // Every one of them arrives with its arrangement, rather than the read
      // coming back short or empty.
      expect(its.every((layout) => layout.placements.length === 1)).toBe(true);
    });
  });

  describe('a panel added later joins every layout, and a deleted one leaves them all', () => {
    it('appends the new panel to each of them, at the size of what is already there', async () => {
      const dashboardId = await aDashboard();
      const falcon = nextId();
      await addPanel(dashboardId, 'Project Falcon', { panelId: falcon });
      await saveLayout(dashboardId, nextId(), 2560, [{ panelId: falcon, columns: 3, rows: 3 }]);
      await saveLayout(dashboardId, nextId(), 480, [{ panelId: falcon, columns: 12, rows: 4 }]);

      const reading = nextId();
      await addPanel(dashboardId, 'To read', { panelId: reading });

      expect((await layoutsOf(dashboardId)).map((layout) => layout.placements)).toEqual([
        [
          { panelId: falcon, columns: 12, rows: 4 },
          { panelId: reading, columns: 12, rows: 4 },
        ],
        [
          { panelId: falcon, columns: 3, rows: 3 },
          { panelId: reading, columns: 3, rows: 3 },
        ],
      ]);
    });

    it('leaves every layout when the panel is deleted', async () => {
      const dashboardId = await aDashboard();
      const falcon = nextId();
      const doomed = nextId();
      await addPanel(dashboardId, 'Project Falcon', { panelId: falcon });
      await addPanel(dashboardId, 'Gone by lunchtime', { panelId: doomed });
      await saveLayout(dashboardId, nextId(), 2560, [
        { panelId: falcon, columns: 3, rows: 3 },
        { panelId: doomed, columns: 3, rows: 3 },
      ]);
      await saveLayout(dashboardId, nextId(), 480, [
        { panelId: doomed, columns: 12, rows: 3 },
        { panelId: falcon, columns: 12, rows: 3 },
      ]);

      await send('delete_panel', { workspaceId: WORKSPACE_ID, panelId: doomed });

      expect((await layoutsOf(dashboardId)).map((layout) => layout.placements)).toEqual([
        [{ panelId: falcon, columns: 12, rows: 3 }],
        [{ panelId: falcon, columns: 3, rows: 3 }],
      ]);
    });
  });

  describe('deleting a layout takes only itself', () => {
    it('leaves the panels and the other layouts exactly as they were', async () => {
      const dashboardId = await aDashboard();
      const falcon = nextId();
      await addPanel(dashboardId, 'Project Falcon', { panelId: falcon });
      const doomed = nextId();
      await saveLayout(dashboardId, doomed, 2560, [{ panelId: falcon, columns: 3, rows: 3 }]);
      await saveLayout(dashboardId, nextId(), 480, [{ panelId: falcon, columns: 12, rows: 3 }]);

      const gone = await send('delete_layout', { workspaceId: WORKSPACE_ID, layoutId: doomed });

      expect(gone.status).toBe(200);
      expect(await layoutsOf(dashboardId)).toEqual([
        expect.objectContaining({
          screenWidth: 480,
          placements: [{ panelId: falcon, columns: 12, rows: 3 }],
        }),
      ]);
      expect((await panelsOn(dashboardId)).map((panel) => panel.name)).toEqual(['Project Falcon']);
    });
  });
});
