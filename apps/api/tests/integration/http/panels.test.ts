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

type Cell = { panelId: string; span: number };

/**
 * An arrangement of one row, which is what most cases here want: they are about
 * what the store does with an arrangement rather than about which line a panel
 * is on. `saveRows` is for the cases that are about the lines.
 */
async function saveLayout(
  dashboardId: string,
  layoutId: string,
  screenWidth: number,
  cells: Cell[],
  name?: string,
) {
  return saveRows(
    dashboardId,
    layoutId,
    screenWidth,
    cells.length ? [{ height: null, cells }] : [],
    name,
  );
}

async function saveRows(
  dashboardId: string,
  layoutId: string,
  screenWidth: number,
  rows: { height: number | null; cells: Cell[] }[],
  name?: string,
) {
  return send('save_layout', {
    workspaceId: WORKSPACE_ID,
    dashboardId,
    layoutId,
    // Read only when the save is the one creating the layout, so every case
    // that does not care what it is called gets a name free on its dashboard.
    name: name ?? `Layout ${(seq += 1)}`,
    screenWidth,
    rows,
  });
}

/** The cells of a layout's rows, flattened - what most cases assert against. */
function cellsOf(layout: Layout | undefined): Cell[] {
  return (layout?.rows ?? []).flatMap((row) => row.cells);
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
            { panelId: stranger, span: 4 },
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
          // A second one, so the first delete is not the one the dashboard
          // keeps ("a dashboard keeps at least one layout") - that refusal is a
          // 409 and would hide the 404 this case is about.
          await saveLayout(ctx.dashboardId, nextId(), 480, []);
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
      { situation: 'a share bigger than a whole row', span: 13 },
      { situation: 'a share of nothing at all', span: 0 },
      { situation: 'a share measured in half columns', span: 4.5 },
    ])('refuses an arrangement with $situation', async ({ span }) => {
      const dashboardId = await aDashboard();
      const panelId = nextId();
      await addPanel(dashboardId, aName(), { panelId });

      const refused = await saveLayout(dashboardId, nextId(), 1280, [{ panelId, span }]);

      expect(refused.status).toBe(400);
      expect(await layoutsOf(dashboardId)).toEqual([]);
    });

    it('refuses an arrangement that puts one panel in two places', async () => {
      const dashboardId = await aDashboard();
      const panelId = nextId();
      await addPanel(dashboardId, aName(), { panelId });

      const refused = await saveLayout(dashboardId, nextId(), 1280, [
        { panelId, span: 4 },
        { panelId, span: 8 },
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

  describe('a dashboard remembers an arrangement per layout, and arranging it again replaces what it held', () => {
    it('stores the panels in the order given, at the sizes given', async () => {
      const dashboardId = await aDashboard();
      const falcon = nextId();
      const reading = nextId();
      await addPanel(dashboardId, 'Project Falcon', { panelId: falcon });
      await addPanel(dashboardId, 'To read', { panelId: reading });

      await saveLayout(dashboardId, nextId(), 1280, [
        { panelId: reading, span: 8 },
        { panelId: falcon, span: 4 },
      ]);

      expect(await layoutsOf(dashboardId)).toEqual([
        expect.objectContaining({
          screenWidth: 1280,
          rows: [
            {
              height: null,
              cells: [
                { panelId: reading, span: 8 },
                { panelId: falcon, span: 4 },
              ],
            },
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
        { panelId: falcon, span: 4 },
        { panelId: reading, span: 4 },
      ]);

      await saveLayout(dashboardId, layoutId, 1280, [{ panelId: falcon, span: 12 }]);

      expect(cellsOf((await layoutsOf(dashboardId))[0])).toEqual([
        { panelId: falcon, span: 12 },
      ]);
    });

    it('keeps the width a layout was made at, even when it is changed from another screen', async () => {
      // The whole point of asking which layout to change: changing the wide
      // one from a laptop must not quietly turn it into the laptop's.
      const dashboardId = await aDashboard();
      const falcon = nextId();
      await addPanel(dashboardId, 'Project Falcon', { panelId: falcon });
      const layoutId = nextId();
      await saveLayout(dashboardId, layoutId, 2560, [{ panelId: falcon, span: 3 }]);

      await saveLayout(dashboardId, layoutId, 480, [{ panelId: falcon, span: 6 }]);

      expect((await layoutsOf(dashboardId))[0]).toMatchObject({ screenWidth: 2560 });
    });

    it('keeps one layout per screen size side by side', async () => {
      const dashboardId = await aDashboard();
      const falcon = nextId();
      await addPanel(dashboardId, 'Project Falcon', { panelId: falcon });

      await saveLayout(dashboardId, nextId(), 2560, [{ panelId: falcon, span: 3 }]);
      await saveLayout(dashboardId, nextId(), 480, [{ panelId: falcon, span: 12 }]);

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
            { panelId: falcon, span: 3 },
          ]),
        ),
      );
      expect(saved.every((res) => res.status === 200)).toBe(true);

      const its = await layoutsOf(dashboardId);

      expect(its).toHaveLength(widths.length);
      // Every one of them arrives with its arrangement, rather than the read
      // coming back short or empty.
      expect(its.every((layout) => cellsOf(layout).length === 1)).toBe(true);
    });
  });

  describe('a panel added later joins every layout, and a deleted one leaves them all', () => {
    it('gives it a row of its own under each of them, rather than a place beside something', async () => {
      // A row is a decision about what belongs side by side, and adding a panel
      // says nothing about which panels it belongs beside - so it gets a line,
      // full width, in every layout of the dashboard. Adding one on a laptop
      // must not leave it missing from the phone layout until somebody
      // rearranges that too.
      const dashboardId = await aDashboard();
      const falcon = nextId();
      await addPanel(dashboardId, 'Project Falcon', { panelId: falcon });
      await saveLayout(dashboardId, nextId(), 2560, [{ panelId: falcon, span: 3 }]);
      await saveLayout(dashboardId, nextId(), 480, [{ panelId: falcon, span: 12 }]);

      const reading = nextId();
      await addPanel(dashboardId, 'To read', { panelId: reading });

      expect((await layoutsOf(dashboardId)).map((layout) => layout.rows)).toEqual([
        [
          { height: null, cells: [{ panelId: falcon, span: 12 }] },
          { height: null, cells: [{ panelId: reading, span: 12 }] },
        ],
        [
          { height: null, cells: [{ panelId: falcon, span: 3 }] },
          { height: null, cells: [{ panelId: reading, span: 12 }] },
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
        { panelId: falcon, span: 3 },
        { panelId: doomed, span: 3 },
      ]);
      await saveLayout(dashboardId, nextId(), 480, [
        { panelId: doomed, span: 12 },
        { panelId: falcon, span: 12 },
      ]);

      await send('delete_panel', { workspaceId: WORKSPACE_ID, panelId: doomed });

      expect((await layoutsOf(dashboardId)).map(cellsOf)).toEqual([
        [{ panelId: falcon, span: 12 }],
        [{ panelId: falcon, span: 3 }],
      ]);
    });
  });

  describe('deleting a layout takes only itself', () => {
    it('leaves the panels and the other layouts exactly as they were', async () => {
      const dashboardId = await aDashboard();
      const falcon = nextId();
      await addPanel(dashboardId, 'Project Falcon', { panelId: falcon });
      const doomed = nextId();
      await saveLayout(dashboardId, doomed, 2560, [{ panelId: falcon, span: 3 }]);
      await saveLayout(dashboardId, nextId(), 480, [{ panelId: falcon, span: 12 }]);

      const gone = await send('delete_layout', { workspaceId: WORKSPACE_ID, layoutId: doomed });

      expect(gone.status).toBe(200);
      expect(await layoutsOf(dashboardId)).toEqual([
        expect.objectContaining({
          screenWidth: 480,
          rows: [{ height: null, cells: [{ panelId: falcon, span: 12 }] }],
        }),
      ]);
      expect((await panelsOn(dashboardId)).map((panel) => panel.name)).toEqual(['Project Falcon']);
    });
  });

  /**
   * The write half of the ceiling the read hit above ("still reads the
   * workspace when it holds more layouts than a statement can name"): a store
   * binds 100 values per statement (architecture, "No statement's parameter
   * count grows with the data") and a placement is six of them, so an
   * arrangement used to fail at seventeen panels. Forty rather than seventeen,
   * so the case goes on being about the limit if the batch size moves.
   */
  describe('a dashboard is arranged however many panels are on it', () => {
    it('stores all forty in the order given, at the sizes given', async () => {
      const dashboardId = await aDashboard();
      const wanted: Cell[] = [];
      for (let n = 0; n < 40; n += 1) {
        const panelId = nextId();
        expect((await addPanel(dashboardId, `Panel ${n}`, { panelId })).status).toBe(200);
        // Shares that differ per panel, so a cell landing under another's
        // place would show up as the wrong share rather than passing quietly.
        wanted.push({ panelId, span: (n % 12) + 1 });
      }

      const saved = await saveLayout(dashboardId, nextId(), 1280, wanted);

      expect(saved.status).toBe(200);
      expect(cellsOf((await layoutsOf(dashboardId))[0])).toEqual(wanted);
      // Forty panels is forty-two round trips, which is past the default five
      // seconds on its own - `startFromEmpty` empties the store before every
      // case, so this is the cost of the requests and not of what ran before.
    }, 30_000);
  });

});

describe('Layouts', () => {
  /** A dashboard with one panel and one layout arranging it, which is the shape most rules need. */
  async function arranged(name: string, screenWidth = 1280) {
    const dashboardId = await aDashboard();
    const panelId = nextId();
    expect((await addPanel(dashboardId, aName(), { panelId })).status).toBe(200);
    const layoutId = nextId();
    const saved = await saveLayout(
      dashboardId,
      layoutId,
      screenWidth,
      [{ panelId, span: 4 }],
      name,
    );
    expect(saved.status).toBe(200);
    return { dashboardId, panelId, layoutId };
  }

  describe('two layouts of one dashboard never go by the same name, and two dashboards may each have a Wide', () => {
    it('stores the name without the blanks around it', async () => {
      const { dashboardId } = await arranged('  Wide  ');

      expect((await layoutsOf(dashboardId))[0]!.name).toBe('Wide');
    });

    it.each([
      { situation: 'the same name', name: 'Wide' },
      { situation: 'the same name in another capitalization', name: 'WIDE' },
    ])('refuses a layout going by $situation, saying which', async ({ name }) => {
      const { dashboardId, panelId } = await arranged('Wide');

      const again = await saveLayout(
        dashboardId,
        nextId(),
        2560,
        [{ panelId, span: 12 }],
        name,
      );

      expect(again.status).toBe(409);
      expect(await again.json()).toMatchObject({
        error: 'a layout called Wide already arranges this dashboard',
      });
      expect(await layoutsOf(dashboardId)).toHaveLength(1);
    });

    it('lets another dashboard have a layout of the same name', async () => {
      // One level further down than a dashboard's own name: the scope is the
      // dashboard, the way a panel's title is.
      await arranged('Wide');
      const { dashboardId } = await arranged('Wide');

      expect((await layoutsOf(dashboardId))[0]!.name).toBe('Wide');
    });

    it('leaves the name alone when an arrangement is saved onto a layout that exists', async () => {
      // A board holding a name from before a rename must not put the old one
      // back as a side effect of a drag, which is why renaming is its own
      // command.
      const { dashboardId, panelId, layoutId } = await arranged('Wide');
      expect(
        (await send('rename_layout', { workspaceId: WORKSPACE_ID, layoutId, name: 'The big one' }))
          .status,
      ).toBe(200);

      const saved = await saveLayout(
        dashboardId,
        layoutId,
        1280,
        [{ panelId, span: 6 }],
        'Wide',
      );

      expect(saved.status).toBe(200);
      const [layout] = await layoutsOf(dashboardId);
      expect(layout!.name).toBe('The big one');
      expect(cellsOf(layout)).toEqual([{ panelId, span: 6 }]);
    });
  });

  describe('renaming a layout changes its name and nothing else', () => {
    it('keeps the arrangement and the width it was made at', async () => {
      const { dashboardId, panelId, layoutId } = await arranged('Wide', 2560);

      const renamed = await send('rename_layout', {
        workspaceId: WORKSPACE_ID,
        layoutId,
        name: '  The big one  ',
      });

      expect(renamed.status).toBe(200);
      expect((await layoutsOf(dashboardId))[0]).toMatchObject({
        name: 'The big one',
        screenWidth: 2560,
        rows: [{ height: null, cells: [{ panelId, span: 4 }] }],
      });
    });

    it('keeps a rename to the name it already has, recapitalized', async () => {
      // The only row the new name folds onto is this layout's own, so it
      // collides with nothing.
      const { dashboardId, layoutId } = await arranged('Wide');

      const renamed = await send('rename_layout', {
        workspaceId: WORKSPACE_ID,
        layoutId,
        name: 'WIDE',
      });

      expect(renamed.status).toBe(200);
      expect((await layoutsOf(dashboardId))[0]!.name).toBe('WIDE');
    });

    it('refuses a name another layout of the dashboard holds', async () => {
      const { dashboardId, panelId } = await arranged('Wide');
      const second = nextId();
      expect(
        (await saveLayout(dashboardId, second, 480, [{ panelId, span: 12 }], 'Phone'))
          .status,
      ).toBe(200);

      const renamed = await send('rename_layout', {
        workspaceId: WORKSPACE_ID,
        layoutId: second,
        name: 'wide',
      });

      expect(renamed.status).toBe(409);
      expect((await layoutsOf(dashboardId)).map((l) => l.name).sort()).toEqual(['Phone', 'Wide']);
    });

    it('renames once when the same rename is sent twice', async () => {
      const { dashboardId, layoutId } = await arranged('Wide');
      const commandId = nextId();
      const once = { workspaceId: WORKSPACE_ID, layoutId, name: 'The big one', commandId };

      expect(
        (
          await asUser('http://cockpit.test/v1/commands/rename_layout', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ issuedAt: AT, ...once }),
          })
        ).status,
      ).toBe(200);
      const replay = await asUser('http://cockpit.test/v1/commands/rename_layout', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ issuedAt: AT, ...once }),
      });

      expect(replay.status).toBe(200);
      expect((await layoutsOf(dashboardId))[0]!.name).toBe('The big one');
    });

    it('refuses to rename a layout of another workspace’s dashboard', async () => {
      // The id alone says nothing about who may address it.
      const { layoutId } = await arranged('Wide');

      const renamed = await send('rename_layout', {
        workspaceId: '018f0000-0000-7000-8000-999999999999',
        layoutId,
        name: 'Mine now',
      });

      expect(renamed.status).toBe(404);
    });
  });

  describe('a dashboard that has a layout keeps one', () => {
    it('refuses to delete the only one, saying why', async () => {
      const { dashboardId, layoutId } = await arranged('Wide');

      const gone = await send('delete_layout', { workspaceId: WORKSPACE_ID, layoutId });

      expect(gone.status).toBe(409);
      expect(await gone.json()).toMatchObject({
        error: 'a dashboard keeps at least one layout',
      });
      expect(await layoutsOf(dashboardId)).toHaveLength(1);
    });

    it('deletes one of two, leaving the other to fall back to', async () => {
      const { dashboardId, panelId, layoutId } = await arranged('Wide');
      const phone = nextId();
      expect(
        (await saveLayout(dashboardId, phone, 480, [{ panelId, span: 12 }], 'Phone'))
          .status,
      ).toBe(200);

      const gone = await send('delete_layout', { workspaceId: WORKSPACE_ID, layoutId });

      expect(gone.status).toBe(200);
      expect((await layoutsOf(dashboardId)).map((l) => l.name)).toEqual(['Phone']);
    });
  });
});

describe('Layouts', () => {
  describe('an arrangement is a list of rows, and which panels share a line is what it stores', () => {
    it('keeps the panels on the lines they were put on', async () => {
      // The whole of what rows add over the old flat list: three panels can be
      // two-then-one or one-then-two, and nothing about the widths says which.
      const dashboardId = await aDashboard();
      const falcon = nextId();
      const anna = nextId();
      const reading = nextId();
      await addPanel(dashboardId, 'Project Falcon', { panelId: falcon });
      await addPanel(dashboardId, 'Anna', { panelId: anna });
      await addPanel(dashboardId, 'To read', { panelId: reading });

      const saved = await saveRows(dashboardId, nextId(), 1280, [
        { height: 300, cells: [{ panelId: falcon, span: 8 }, { panelId: anna, span: 4 }] },
        { height: null, cells: [{ panelId: reading, span: 12 }] },
      ]);

      expect(saved.status).toBe(200);
      expect((await layoutsOf(dashboardId))[0]?.rows).toEqual([
        { height: 300, cells: [{ panelId: falcon, span: 8 }, { panelId: anna, span: 4 }] },
        { height: null, cells: [{ panelId: reading, span: 12 }] },
      ]);
    });

    it('replaces the rows whole, so one taken away is gone rather than merged', async () => {
      const dashboardId = await aDashboard();
      const falcon = nextId();
      const anna = nextId();
      await addPanel(dashboardId, 'Project Falcon', { panelId: falcon });
      await addPanel(dashboardId, 'Anna', { panelId: anna });
      const layoutId = nextId();
      await saveRows(dashboardId, layoutId, 1280, [
        { height: null, cells: [{ panelId: falcon, span: 12 }] },
        { height: 200, cells: [{ panelId: anna, span: 12 }] },
      ]);

      // The two of them on one line now, which is one row where there were two.
      await saveRows(dashboardId, layoutId, 1280, [
        { height: null, cells: [{ panelId: falcon, span: 6 }, { panelId: anna, span: 6 }] },
      ]);

      expect((await layoutsOf(dashboardId))[0]?.rows).toEqual([
        { height: null, cells: [{ panelId: falcon, span: 6 }, { panelId: anna, span: 6 }] },
      ]);
    });

    it('refuses a row with no panels on it, which is a line nothing draws', async () => {
      const dashboardId = await aDashboard();
      const panelId = nextId();
      await addPanel(dashboardId, aName(), { panelId });

      const refused = await saveRows(dashboardId, nextId(), 1280, [
        { height: null, cells: [{ panelId, span: 12 }] },
        { height: null, cells: [] },
      ]);

      expect(refused.status).toBe(400);
      expect(await layoutsOf(dashboardId)).toEqual([]);
    });

    it('refuses one panel in two rows, which is one panel in two places', async () => {
      const dashboardId = await aDashboard();
      const panelId = nextId();
      await addPanel(dashboardId, aName(), { panelId });

      const refused = await saveRows(dashboardId, nextId(), 1280, [
        { height: null, cells: [{ panelId, span: 12 }] },
        { height: null, cells: [{ panelId, span: 12 }] },
      ]);

      expect(refused.status).toBe(400);
      expect(await layoutsOf(dashboardId)).toEqual([]);
    });

    it.each([
      { situation: 'taller than any screen could show', height: 721 },
      { situation: 'too short to see what is on it', height: 109 },
    ])('refuses a row $situation', async ({ height }) => {
      const dashboardId = await aDashboard();
      const panelId = nextId();
      await addPanel(dashboardId, aName(), { panelId });

      const refused = await saveRows(dashboardId, nextId(), 1280, [
        { height, cells: [{ panelId, span: 12 }] },
      ]);

      expect(refused.status).toBe(400);
    });

    it('keeps a row a deleted panel shared, and drops the one it had to itself', async () => {
      // Deleting a panel takes its cell out of every layout. A row that held
      // others keeps them; a row that held only that panel is a line with
      // nothing on it, and a blank line is not what a deleted panel should look
      // like.
      const dashboardId = await aDashboard();
      const falcon = nextId();
      const shared = nextId();
      const alone = nextId();
      await addPanel(dashboardId, 'Project Falcon', { panelId: falcon });
      await addPanel(dashboardId, 'Beside Falcon', { panelId: shared });
      await addPanel(dashboardId, 'On its own line', { panelId: alone });
      await saveRows(dashboardId, nextId(), 1280, [
        { height: null, cells: [{ panelId: falcon, span: 6 }, { panelId: shared, span: 6 }] },
        { height: null, cells: [{ panelId: alone, span: 12 }] },
      ]);

      await send('delete_panel', { workspaceId: WORKSPACE_ID, panelId: shared });
      await send('delete_panel', { workspaceId: WORKSPACE_ID, panelId: alone });

      expect((await layoutsOf(dashboardId))[0]?.rows).toEqual([
        { height: null, cells: [{ panelId: falcon, span: 6 }] },
      ]);
    });

    /**
     * A store binds 100 values per statement (architecture, "No statement's
     * parameter count grows with the data"), and dropping the emptied rows has
     * to reach this dashboard's layouts without naming them one by one. A
     * workspace that stopped painting at a hundred layouts is one of the
     * instances that rule was written for, so this is the same limit again, one
     * command along.
     *
     * A hundred and twenty rather than a hundred and one, so the case goes on
     * being about the limit if the binding count per row moves.
     */
    it('drops the emptied rows on a dashboard with more layouts than a statement can name', async () => {
      const dashboardId = await aDashboard();
      const falcon = nextId();
      const alone = nextId();
      await addPanel(dashboardId, 'Project Falcon', { panelId: falcon });
      await addPanel(dashboardId, 'On its own line', { panelId: alone });
      for (let n = 0; n < 120; n += 1) {
        expect(
          (
            await saveRows(dashboardId, nextId(), 1280 + n, [
              { height: null, cells: [{ panelId: falcon, span: 12 }] },
              { height: null, cells: [{ panelId: alone, span: 12 }] },
            ])
          ).status,
        ).toBe(200);
      }

      expect(
        (await send('delete_panel', { workspaceId: WORKSPACE_ID, panelId: alone })).status,
      ).toBe(200);

      const its = await layoutsOf(dashboardId);
      expect(its).toHaveLength(120);
      expect(its.every((layout) => layout.rows.length === 1)).toBe(true);
      // A hundred and twenty saves against the workers pool, past the default
      // five seconds on requests alone.
    }, 60_000);
  });
});
