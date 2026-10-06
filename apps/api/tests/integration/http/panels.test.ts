import { beforeEach, describe, expect, inject, it } from 'vitest';
import { applyD1Migrations, env } from 'cloudflare:test';
import { CONDITIONS_LIMIT, PANEL_TEXT_LIMIT } from '@cockpit/shared';
import type { Layout, Panel, WorkspaceSnapshot } from '@cockpit/shared';
import {
  TASK_TYPE_ID,
  WORKSPACE_ID,
  alsoWorkspaces,
  asUser,
  inTheStore,
  seedRegister,
  startFromEmpty,
} from '../seed.js';

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

/**
 * A dashboard of the seeded workspace, so a case cannot disturb another's, with
 * **the panel it arrives with taken back off**.
 *
 * Every dashboard arrives with one (src/domain/panels.ts, `firstPanelFor`), and
 * every case below is about the panels *it* puts on a dashboard - so leaving it
 * there would put a `Panel 1` at the head of five expectations that are not
 * about it, and turn "adds one panel however many times the request is
 * repeated" into a case about two. That the panel arrives at all is proved
 * where it belongs, in tests/integration/http/dashboards.test.ts.
 */
async function aDashboard(): Promise<string> {
  const dashboardId = nextId();
  const panelId = nextId();
  const made = await send('add_dashboard', {
    workspaceId: WORKSPACE_ID,
    dashboardId,
    panelId,
    name: `Today ${seq}`,
  });
  expect(made.status).toBe(200);
  expect((await send('delete_panel', { workspaceId: WORKSPACE_ID, panelId })).status).toBe(200);
  return dashboardId;
}

async function addPanel(
  dashboardId: string,
  name: string,
  overrides: {
    panelId?: string;
    commandId?: string;
    workspaceId?: string;
    /** Left out on purpose by most cases: a panel holds items unless asked. */
    kind?: string;
  } = {},
) {
  return send('add_panel', {
    workspaceId: overrides.workspaceId ?? WORKSPACE_ID,
    dashboardId,
    panelId: overrides.panelId ?? nextId(),
    name,
    ...(overrides.commandId ? { commandId: overrides.commandId } : {}),
    ...(overrides.kind ? { kind: overrides.kind } : {}),
  });
}

/** A panel of text on a dashboard of its own, which is what most cases below want. */
async function aPanelOfText(name = 'What matters'): Promise<{ dashboardId: string; panelId: string }> {
  const dashboardId = await aDashboard();
  const panelId = nextId();
  expect((await addPanel(dashboardId, name, { panelId, kind: 'text' })).status).toBe(200);
  return { dashboardId, panelId };
}

/** A panel of items on a dashboard of its own, for the cases that need one beside a filter. */
async function aPanelOfItems(name = 'Reading list'): Promise<{ dashboardId: string; panelId: string }> {
  const dashboardId = await aDashboard();
  const panelId = nextId();
  expect((await addPanel(dashboardId, name, { panelId })).status).toBe(200);
  return { dashboardId, panelId };
}

/** A panel that gathers what it shows, on a dashboard of its own, with nothing chosen yet. */
async function aFilter(name = 'Due soon'): Promise<{ dashboardId: string; panelId: string }> {
  const dashboardId = await aDashboard();
  const panelId = nextId();
  expect((await addPanel(dashboardId, `${name} ${seq}`, { panelId, kind: 'filter' })).status).toBe(200);
  return { dashboardId, panelId };
}

/** A Due date condition: due today, or already past. */
const DUE_TODAY = { field: 'dueDate', window: 'today', orOverdue: true };

/** A Priority condition: matches an item holding either level ("Filter a Filter panel by priority and type", issue 464). */
const PRIORITY_HIGH_OR_NORMAL = { field: 'priority', values: ['high', 'normal'] };

/** A Type condition: matches an item of the seeded workspace's Task type. */
const TYPE_TASK = { field: 'type', values: [TASK_TYPE_ID] };

/** A save carrying `match` and `groupBy` only where given: leaving them out is what a client from before they existed sends. */
function setFilter(panelId: string, conditions: unknown[], match?: unknown, groupBy?: unknown) {
  return send('set_panel_filter', {
    workspaceId: WORKSPACE_ID,
    panelId,
    conditions,
    ...(match === undefined ? {} : { match }),
    ...(groupBy === undefined ? {} : { groupBy }),
  });
}

/** One panel as the snapshot hands it back. */
async function panelNow(panelId: string): Promise<Panel> {
  const found = (await snapshot()).panels.find((panel) => panel.id === panelId);
  expect(found).toBeDefined();
  return found!;
}

function setText(panelId: string, body: string, commandId?: string) {
  return send('set_panel_text', {
    workspaceId: WORKSPACE_ID,
    panelId,
    body,
    ...(commandId ? { commandId } : {}),
  });
}

function setReadOnly(panelId: string, readOnly: boolean) {
  return send('set_panel_read_only', { workspaceId: WORKSPACE_ID, panelId, readOnly });
}

function setFormat(panelId: string, format: string) {
  return send('set_panel_format', { workspaceId: WORKSPACE_ID, panelId, format });
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
  cells: Cell[],
  /** Whatever else the change carries, for the case about a tab on an older version. */
  extra: Record<string, unknown> = {},
) {
  return saveRows(dashboardId, layoutId, cells.length ? [{ height: null, cells }] : [], extra);
}

async function saveRows(
  dashboardId: string,
  layoutId: string,
  rows: { height: number | null; cells: Cell[] }[],
  extra: Record<string, unknown> = {},
) {
  return send('save_layout', { workspaceId: WORKSPACE_ID, dashboardId, layoutId, rows, ...extra });
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

function move(panelId: string, dashboardId: string, workspaceId: string = WORKSPACE_ID) {
  return send('move_panel_to_dashboard', { workspaceId, panelId, dashboardId });
}

async function anItem(message: string): Promise<string> {
  const itemId = nextId();
  expect(
    (await send('capture_item', { workspaceId: WORKSPACE_ID, itemId, message, typeId: TASK_TYPE_ID }))
      .status,
  ).toBe(200);
  return itemId;
}

/**
 * Files an item onto a panel by writing the row, rather than through
 * `move_item_to_panel` - the same reasoning `panel-items.test.ts` gives its
 * own `alsoFileOn`: a case about what a *move* carries with it should not
 * depend on the command that put the filing there in the first place.
 */
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
  const held = await snapshot();
  return held.filings
    .filter((filing) => filing.panelId === panelId)
    .sort((a, b) => a.position - b.position)
    .map((filing) => filing.itemId);
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
          return saveLayout(ctx.dashboardId, nextId(), [
            { panelId: stranger, span: 4 },
          ]);
        },
      },
      {
        situation: 'an arrangement of a layout that belongs to another dashboard',
        change: async (ctx: Context) => {
          const elsewhere = await aDashboard();
          const layoutId = nextId();
          await saveLayout(elsewhere, layoutId, []);
          return saveLayout(ctx.dashboardId, layoutId, []);
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

      const refused = await saveLayout(dashboardId, nextId(), [{ panelId, span }]);

      expect(refused.status).toBe(400);
      expect(await layoutsOf(dashboardId)).toEqual([]);
    });

    it('refuses an arrangement that puts one panel in two places', async () => {
      const dashboardId = await aDashboard();
      const panelId = nextId();
      await addPanel(dashboardId, aName(), { panelId });

      const refused = await saveLayout(dashboardId, nextId(), [
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

  describe('a dashboard remembers its arrangement, and arranging it again replaces what it held', () => {
    it('stores the panels in the order given, at the sizes given', async () => {
      const dashboardId = await aDashboard();
      const falcon = nextId();
      const reading = nextId();
      await addPanel(dashboardId, 'Project Falcon', { panelId: falcon });
      await addPanel(dashboardId, 'To read', { panelId: reading });

      await saveLayout(dashboardId, nextId(), [
        { panelId: reading, span: 8 },
        { panelId: falcon, span: 4 },
      ]);

      expect(await layoutsOf(dashboardId)).toEqual([
        expect.objectContaining({
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
      await saveLayout(dashboardId, layoutId, [
        { panelId: falcon, span: 4 },
        { panelId: reading, span: 4 },
      ]);

      await saveLayout(dashboardId, layoutId, [{ panelId: falcon, span: 12 }]);

      expect(cellsOf((await layoutsOf(dashboardId))[0])).toEqual([
        { panelId: falcon, span: 12 },
      ]);
    });

    // Given longer than the file's other cases, and it is the arrangement that
    // needs it: a hundred and twenty layouts are a hundred and twenty
    // dashboards arranged, made the way a person makes them rather than
    // written into the store, so that what is under test is a workspace
    // somebody could actually have. Slower on a shared runner, where the
    // default five seconds would be a coin toss.
    it('still reads the workspace when it holds more layouts than a statement can name', { timeout: 60_000 }, async () => {
      // A workspace accumulates a layout per dashboard, and the read that
      // paints it once named every one of them in a single statement - which
      // SQLite refuses past a limit, failing the *whole* workspace read rather
      // than a part of it. Comfortably past the limit rather than exactly on
      // it, so the case goes on being about the limit if the limit ever moves.
      //
      // Each dashboard keeps the panel it arrives with, which is what gets
      // arranged. Sent together rather than one after another: the store
      // serialises them anyway, and two hundred and forty round trips in a row
      // is the difference between a case that runs in a moment and one that
      // outlasts the runner's patience.
      const made = Array.from({ length: 120 }, (_, at) => ({
        dashboardId: nextId(),
        panelId: nextId(),
        name: `Arranged ${at}`,
      }));
      const added = await Promise.all(
        made.map(({ dashboardId, panelId, name }) =>
          send('add_dashboard', { workspaceId: WORKSPACE_ID, dashboardId, panelId, name }),
        ),
      );
      expect(added.every((res) => res.status === 200)).toBe(true);
      const saved = await Promise.all(
        made.map(({ dashboardId, panelId }) => saveLayout(dashboardId, nextId(), [{ panelId, span: 3 }])),
      );
      expect(saved.every((res) => res.status === 200)).toBe(true);

      const ids = new Set(made.map((one) => one.dashboardId));
      const its = (await snapshot()).layouts.filter((layout) => ids.has(layout.dashboardId));

      expect(its).toHaveLength(made.length);
      // Every one of them arrives with its arrangement, rather than the read
      // coming back short or empty.
      expect(its.every((layout) => cellsOf(layout).length === 1)).toBe(true);
    });
  });

  describe('a panel added later joins the arrangement in a row of its own, and a deleted one leaves it', () => {
    it('gives it a row of its own under everything there, rather than a place beside something', async () => {
      // A row is a decision about what belongs side by side, and adding a panel
      // says nothing about which panels it belongs beside - so it gets a line,
      // full width, under the rest.
      const dashboardId = await aDashboard();
      const falcon = nextId();
      await addPanel(dashboardId, 'Project Falcon', { panelId: falcon });
      await saveLayout(dashboardId, nextId(), [{ panelId: falcon, span: 3 }]);

      const reading = nextId();
      await addPanel(dashboardId, 'To read', { panelId: reading });

      expect((await layoutsOf(dashboardId)).map((layout) => layout.rows)).toEqual([
        [
          { height: null, cells: [{ panelId: falcon, span: 3 }] },
          { height: null, cells: [{ panelId: reading, span: 12 }] },
        ],
      ]);
    });

    it('leaves the arrangement when the panel is deleted', async () => {
      const dashboardId = await aDashboard();
      const falcon = nextId();
      const doomed = nextId();
      await addPanel(dashboardId, 'Project Falcon', { panelId: falcon });
      await addPanel(dashboardId, 'Gone by lunchtime', { panelId: doomed });
      await saveLayout(dashboardId, nextId(), [
        { panelId: falcon, span: 3 },
        { panelId: doomed, span: 3 },
      ]);

      await send('delete_panel', { workspaceId: WORKSPACE_ID, panelId: doomed });

      expect((await layoutsOf(dashboardId)).map(cellsOf)).toEqual([[{ panelId: falcon, span: 3 }]]);
    });
  });

  describe('a panel moved to another dashboard belongs to it, and only it', () => {
    it('is taken off the dashboard it left and put on the one it landed on', async () => {
      const from = await aDashboard();
      const to = await aDashboard();
      const panelId = nextId();
      await addPanel(from, 'Project Falcon', { panelId });

      const moved = await move(panelId, to);

      expect(moved.status).toBe(200);
      expect((await panelNow(panelId)).dashboardId).toBe(to);
      expect(await panelsOn(from)).toEqual([]);
      expect((await panelsOn(to)).map((panel) => panel.name)).toEqual(['Project Falcon']);
    });

    it('does not go with the dashboard it left, and does go with the one it landed on', async () => {
      const from = await aDashboard();
      const to = await aDashboard();
      const panelId = nextId();
      await addPanel(from, 'Project Falcon', { panelId });
      await move(panelId, to);

      await send('delete_dashboard', { workspaceId: WORKSPACE_ID, dashboardId: from });
      expect((await panelNow(panelId)).dashboardId).toBe(to);

      await send('delete_dashboard', { workspaceId: WORKSPACE_ID, dashboardId: to });
      expect(await panelsOn(to)).toEqual([]);
    });
  });

  describe('a moved panel takes its placement with it', () => {
    it('leaves the arrangement it came from and joins the one it lands on, in a row of its own', async () => {
      const from = await aDashboard();
      const to = await aDashboard();
      const moving = nextId();
      const stayed = nextId();
      const alreadyThere = nextId();
      await addPanel(from, 'Moving', { panelId: moving });
      await addPanel(from, 'Stayed behind', { panelId: stayed });
      await addPanel(to, 'Already there', { panelId: alreadyThere });
      await saveLayout(from, nextId(), [
        { panelId: moving, span: 6 },
        { panelId: stayed, span: 6 },
      ]);
      await saveLayout(to, nextId(), [{ panelId: alreadyThere, span: 12 }]);

      await move(moving, to);

      expect(cellsOf((await layoutsOf(from))[0])).toEqual([{ panelId: stayed, span: 6 }]);
      expect((await layoutsOf(to))[0]?.rows).toEqual([
        { height: null, cells: [{ panelId: alreadyThere, span: 12 }] },
        { height: null, cells: [{ panelId: moving, span: 12 }] },
      ]);
    });

    it('drops a row it had to itself, in the layout it left', async () => {
      const from = await aDashboard();
      const to = await aDashboard();
      const alone = nextId();
      const other = nextId();
      await addPanel(from, 'Alone on its line', { panelId: alone });
      await addPanel(from, 'Elsewhere', { panelId: other });
      await saveRows(from, nextId(), [
        { height: null, cells: [{ panelId: other, span: 12 }] },
        { height: null, cells: [{ panelId: alone, span: 12 }] },
      ]);

      await move(alone, to);

      expect((await layoutsOf(from))[0]?.rows).toEqual([
        { height: null, cells: [{ panelId: other, span: 12 }] },
      ]);
    });

    it('joins a dashboard with no layout yet, arranging itself the way any panel added to one does', async () => {
      const from = await aDashboard();
      const to = await aDashboard();
      const panelId = nextId();
      await addPanel(from, 'Project Falcon', { panelId });

      const moved = await move(panelId, to);

      expect(moved.status).toBe(200);
      expect(await layoutsOf(to)).toEqual([]);
    });
  });

  describe('a name already on the target dashboard is not a name the move can keep', () => {
    it('is renamed rather than refused where the target already has one going by it', async () => {
      const from = await aDashboard();
      const to = await aDashboard();
      const panelId = nextId();
      await addPanel(from, 'Reading list', { panelId });
      await addPanel(to, 'Reading list', { panelId: nextId() });

      const moved = await move(panelId, to);

      expect(moved.status).toBe(200);
      expect((await panelNow(panelId)).name).toBe('Reading list (2)');
    });

    it('keeps its own name where nothing on the target already holds it', async () => {
      const from = await aDashboard();
      const to = await aDashboard();
      const panelId = nextId();
      await addPanel(from, 'Reading list', { panelId });

      await move(panelId, to);

      expect((await panelNow(panelId)).name).toBe('Reading list');
    });
  });

  describe('nothing else about a moved panel changes', () => {
    it('carries its kind, format, body and read-only state across untouched', async () => {
      const { panelId } = await aPanelOfText('What matters');
      await setText(panelId, 'Standing agenda');
      await setFormat(panelId, 'rich');
      await setReadOnly(panelId, true);
      const to = await aDashboard();

      await move(panelId, to);

      expect(await panelNow(panelId)).toMatchObject({
        dashboardId: to,
        kind: 'text',
        format: 'rich',
        body: 'Standing agenda',
        readOnly: true,
      });
    });

    it('carries what is filed on it, in the order it was filed', async () => {
      const from = await aDashboard();
      const to = await aDashboard();
      const panelId = nextId();
      await addPanel(from, 'Project Falcon', { panelId });
      const first = await anItem('First');
      const second = await anItem('Second');
      await fileOn(panelId, first, 0);
      await fileOn(panelId, second, 1);

      await move(panelId, to);

      expect(await filingsOn(panelId)).toEqual([first, second]);
    });
  });

  describe('a move is refused rather than half-applied, wherever what it names is not there to move to', () => {
    it('refuses naming the panel’s own current dashboard', async () => {
      const dashboardId = await aDashboard();
      const panelId = nextId();
      await addPanel(dashboardId, 'Project Falcon', { panelId });

      const refused = await move(panelId, dashboardId);

      expect(refused.status).toBe(400);
      expect((await panelNow(panelId)).dashboardId).toBe(dashboardId);
    });

    it('refuses a dashboard that does not exist, and moves nothing', async () => {
      const from = await aDashboard();
      const panelId = nextId();
      await addPanel(from, 'Project Falcon', { panelId });

      const refused = await move(panelId, '018f0000-0000-7000-8000-999999999999');

      expect(refused.status).toBe(404);
      expect((await panelNow(panelId)).dashboardId).toBe(from);
    });

    it('refuses a dashboard that belongs to another workspace, and moves nothing', async () => {
      await alsoWorkspaces();
      const from = await aDashboard();
      const panelId = nextId();
      await addPanel(from, 'Project Falcon', { panelId });

      const refused = await move(panelId, 'ws-atlas-dashboard-1');

      expect(refused.status).toBe(404);
      expect((await panelNow(panelId)).dashboardId).toBe(from);
    });

    it('refuses moving a panel that has already been deleted', async () => {
      const from = await aDashboard();
      const to = await aDashboard();
      const panelId = nextId();
      await addPanel(from, 'Project Falcon', { panelId });
      await send('delete_panel', { workspaceId: WORKSPACE_ID, panelId });

      const refused = await move(panelId, to);

      expect(refused.status).toBe(404);
    });

    it('leaves the panel and its placement exactly where they were when the target was deleted a moment before', async () => {
      const from = await aDashboard();
      const to = await aDashboard();
      const panelId = nextId();
      await addPanel(from, 'Project Falcon', { panelId });
      await saveLayout(from, nextId(), [{ panelId, span: 12 }]);
      await send('delete_dashboard', { workspaceId: WORKSPACE_ID, dashboardId: to });

      const refused = await move(panelId, to);

      expect(refused.status).toBe(404);
      expect((await panelNow(panelId)).dashboardId).toBe(from);
      expect(cellsOf((await layoutsOf(from))[0])).toEqual([{ panelId, span: 12 }]);
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
  describe('a panel holds the items filed into it, the text written in it, or what a rule gathers', () => {
    /**
     * Decided when the panel is made and never after, so this is the only place
     * it is read. The first row is what a client that has never heard of kinds
     * sends, which is every client that existed before this and every one
     * serving requests during the deploy.
     */
    it.each([
      { situation: 'nothing said about what it holds', kind: undefined, holds: 'items' },
      { situation: 'asked for a panel of items', kind: 'items', holds: 'items' },
      { situation: 'asked for a panel of text', kind: 'text', holds: 'text' },
      { situation: 'asked for a panel that gathers what it shows', kind: 'filter', holds: 'filter' },
    ])('$situation', async ({ kind, holds }) => {
      const dashboardId = await aDashboard();
      const panelId = nextId();

      // Spread rather than passed, so "nothing said about what it holds" is a
      // request with no `kind` in it at all rather than one saying undefined.
      expect(
        (await addPanel(dashboardId, aName(), { panelId, ...(kind ? { kind } : {}) })).status,
      ).toBe(200);

      expect(await panelNow(panelId)).toMatchObject({ kind: holds });
    });

    it('refuses a kind nothing knows about, and stores no panel', async () => {
      const dashboardId = await aDashboard();
      const panelId = nextId();

      expect((await addPanel(dashboardId, aName(), { panelId, kind: 'spreadsheet' })).status).toBe(
        400,
      );

      expect(await panelsOn(dashboardId)).toHaveLength(0);
    });

    it('keeps a panel’s kind through every change there is a command for', async () => {
      // There is no command that changes a kind, so what this holds is that the
      // ones that exist do not change it by accident: the stored kind of a
      // filter is `items` (STORED_PANEL_KINDS), and it would be a panel of items
      // from here on if any of these wrote it back.
      const { panelId } = await aFilter();

      expect((await send('rename_panel', { workspaceId: WORKSPACE_ID, panelId, name: aName() })).status).toBe(200);
      expect((await setFilter(panelId, [DUE_TODAY])).status).toBe(200);

      expect(await panelNow(panelId)).toMatchObject({ kind: 'filter' });
    });
  });

  describe('a panel that gathers what it shows says so until somebody chooses what that is', () => {
    it('arrives with nothing chosen, and keeps what was chosen for it', async () => {
      const { panelId } = await aFilter();

      expect(await panelNow(panelId)).toMatchObject({ kind: 'filter', filter: { conditions: [], match: 'all', groupBy: 'none' } });

      expect((await setFilter(panelId, [DUE_TODAY])).status).toBe(200);
      expect((await panelNow(panelId)).filter).toEqual({ conditions: [DUE_TODAY], match: 'all', groupBy: 'none' });

      // Saved whole, so taking the last one out puts it back to saying nothing
      // has been chosen rather than leaving the old answer standing.
      expect((await setFilter(panelId, [])).status).toBe(200);
      expect((await panelNow(panelId)).filter).toEqual({ conditions: [], match: 'all', groupBy: 'none' });
    });

    it('accepts a Priority, a Type and a Panel condition beside a Due date one', async () => {
      // The four fields together, each carrying its own value shape - what
      // extends `filterConditionSchema` from a Due date alone to a union
      // ("Filter a Filter panel by priority and type", issue 464; "Filter a
      // Filter panel by panel, and name the Filters a panel's deletion
      // affects", issue 465).
      const { panelId: itemsPanelId } = await aPanelOfItems();
      const { panelId } = await aFilter();
      const conditions = [
        DUE_TODAY,
        PRIORITY_HIGH_OR_NORMAL,
        TYPE_TASK,
        { field: 'panel', values: [itemsPanelId] },
      ];

      expect((await setFilter(panelId, conditions)).status).toBe(200);
      expect((await panelNow(panelId)).filter).toEqual({ conditions, match: 'all', groupBy: 'none' });
    });

    it('keeps whether an item has to meet all of its conditions or any one, and a save without it means all', async () => {
      const { panelId } = await aFilter();
      const conditions = [DUE_TODAY, PRIORITY_HIGH_OR_NORMAL];

      expect((await setFilter(panelId, conditions, 'any')).status).toBe(200);
      expect((await panelNow(panelId)).filter).toEqual({ conditions, match: 'any', groupBy: 'none' });

      // A stale tab or a queued change saves the whole Filter without the
      // setting: the later whole save stands, and it stands as all.
      expect((await setFilter(panelId, conditions)).status).toBe(200);
      expect((await panelNow(panelId)).filter).toEqual({ conditions, match: 'all', groupBy: 'none' });
    });

    it('refuses a setting that is neither all nor any, and stores nothing of it', async () => {
      const { panelId } = await aFilter();

      expect((await setFilter(panelId, [DUE_TODAY], 'either')).status).toBe(400);

      expect((await panelNow(panelId)).filter).toEqual({ conditions: [], match: 'all', groupBy: 'none' });
    });

    it.each([
      { situation: 'saved grouped by Dashboard', save: ['dashboard'], reads: 'dashboard' },
      { situation: 'saved grouped by Panel, then saved again with none given by a stale tab', save: ['panel', undefined], reads: 'none' },
    ])('keeps the grouping it was $situation, for every device', async ({ save, reads }) => {
      const { panelId } = await aFilter();
      const conditions = [DUE_TODAY];

      for (const groupBy of save) {
        expect((await setFilter(panelId, conditions, 'any', groupBy)).status).toBe(200);
      }

      expect((await panelNow(panelId)).filter).toEqual({ conditions, match: 'any', groupBy: reads });
    });

    it('refuses a grouping nothing knows about, and the stored grouping stays as it was', async () => {
      const { panelId } = await aFilter();
      expect((await setFilter(panelId, [DUE_TODAY], 'all', 'panel')).status).toBe(200);

      expect((await setFilter(panelId, [DUE_TODAY], 'all', 'priority')).status).toBe(400);

      expect((await panelNow(panelId)).filter).toEqual({ conditions: [DUE_TODAY], match: 'all', groupBy: 'panel' });
    });

    it('still refuses a field twice where the filter is set to any', async () => {
      const { panelId } = await aFilter();

      expect(
        (await setFilter(panelId, [DUE_TODAY, { ...DUE_TODAY, window: 'week' }], 'any')).status,
      ).toBe(400);
    });

    it('reads a filter stored before there was a setting as all, conditions intact', async () => {
      // Written straight into the store: the only way to hold what an older
      // release wrote, which no request here can produce.
      const { panelId } = await aFilter();
      await inTheStore((sql) =>
        sql.exec(
          'UPDATE panels SET filter_conditions = ? WHERE id = ?',
          JSON.stringify({ conditions: [DUE_TODAY] }),
          panelId,
        ),
      );

      expect((await panelNow(panelId)).filter).toEqual({ conditions: [DUE_TODAY], match: 'all', groupBy: 'none' });
    });

    it('shows nothing chosen where what is stored cannot be read, and the workspace still opens', async () => {
      // The only way to store one is a release this one does not have; written
      // straight into the store, because no request can drive it here.
      const { panelId } = await aFilter();
      await inTheStore((sql) =>
        sql.exec('UPDATE panels SET filter_conditions = ? WHERE id = ?', '{not json', panelId),
      );

      expect(await panelNow(panelId)).toMatchObject({ kind: 'filter', filter: { conditions: [], match: 'all', groupBy: 'none' } });
    });

    it.each([
      {
        situation: 'a panel of items, which gathers nothing',
        panel: async () => (await aPanelOfItems()).panelId,
        conditions: [DUE_TODAY],
        status: 400,
      },
      {
        situation: 'a panel of text, which gathers nothing either',
        panel: async () => (await aPanelOfText()).panelId,
        conditions: [DUE_TODAY],
        status: 400,
      },
      {
        situation: 'a window nothing knows about',
        panel: async () => (await aFilter()).panelId,
        conditions: [{ field: 'dueDate', window: 'fortnight', orOverdue: true }],
        status: 400,
      },
      {
        situation: 'a condition about nothing the product has',
        panel: async () => (await aFilter()).panelId,
        conditions: [{ field: 'weather', window: 'today', orOverdue: true }],
        status: 400,
      },
      {
        situation: 'a priority level nothing knows about',
        panel: async () => (await aFilter()).panelId,
        conditions: [{ field: 'priority', values: ['urgent'] }],
        status: 400,
      },
      {
        situation: 'a Type condition naming nothing at all',
        panel: async () => (await aFilter()).panelId,
        conditions: [{ field: 'type', values: [''] }],
        status: 400,
      },
      {
        situation: 'a Panel condition naming nothing at all',
        panel: async () => (await aFilter()).panelId,
        conditions: [{ field: 'panel', values: [''] }],
        status: 400,
      },
      {
        // "A field already on the filter is not offered a second time" (issue
        // 464) refused server-side too, not only left off the add menu: two
        // Due date conditions in the one list this sends.
        situation: 'a field already on the filter',
        panel: async () => (await aFilter()).panelId,
        conditions: [DUE_TODAY, { field: 'dueDate', window: 'week', orOverdue: false }],
        status: 400,
      },
      {
        // The column is read and shipped on every snapshot of the workspace,
        // so what one command may put in it is bounded here rather than left
        // to whatever a caller sends.
        situation: 'more conditions than the command will take',
        panel: async () => (await aFilter()).panelId,
        conditions: Array.from({ length: CONDITIONS_LIMIT + 1 }, () => DUE_TODAY),
        status: 400,
      },
    ])('refuses what it shows being set against $situation', async ({ panel, conditions, status }) => {
      const panelId = await panel();

      expect((await setFilter(panelId, conditions)).status).toBe(status);

      // And nothing of it is stored: a refusal that half-landed would leave a
      // panel gathering something nobody asked for.
      expect((await panelNow(panelId)).filter).toEqual(
        (await panelNow(panelId)).kind === 'filter' ? { conditions: [], match: 'all', groupBy: 'none' } : null,
      );
    });

    it('refuses what a panel that has been deleted shows', async () => {
      const { panelId } = await aFilter();
      expect((await send('delete_panel', { workspaceId: WORKSPACE_ID, panelId })).status).toBe(200);

      expect((await setFilter(panelId, [DUE_TODAY])).status).toBe(404);
    });
  });

  describe('what is written in a panel of text is kept, and is what everybody sees', () => {
    it('is read back as it was written, however many times it is written', async () => {
      const { panelId } = await aPanelOfText();

      expect((await setText(panelId, 'Standing agenda')).status).toBe(200);
      expect((await panelNow(panelId)).body).toBe('Standing agenda');

      // The whole text, over what was there: the later write stands, which is
      // what makes two people typing at once an answer rather than a merge.
      const twoParagraphs = ['Standing agenda', '', 'Pricing'].join('\n');
      expect((await setText(panelId, twoParagraphs)).status).toBe(200);
      expect((await panelNow(panelId)).body).toBe(twoParagraphs);
    });

    it('is written once however often the same change arrives', async () => {
      const { panelId } = await aPanelOfText();
      const twice = nextId();

      expect((await setText(panelId, 'Sent twice', twice)).status).toBe(200);
      expect((await setText(panelId, 'Sent twice', twice)).status).toBe(200);

      expect((await panelNow(panelId)).body).toBe('Sent twice');
    });

    it.each([
      { situation: 'as much as a panel of text holds', length: PANEL_TEXT_LIMIT, status: 200 },
      { situation: 'one character more than it holds', length: PANEL_TEXT_LIMIT + 1, status: 400 },
    ])('$situation', async ({ length, status }) => {
      const { panelId } = await aPanelOfText();

      expect((await setText(panelId, 'x'.repeat(length))).status).toBe(status);
    });

    it('is never written through a workspace that does not hold the panel', async () => {
      const { panelId } = await aPanelOfText();

      const res = await send('set_panel_text', {
        workspaceId: 'ws-nobody-has',
        panelId,
        body: 'from somewhere else',
      });

      expect(res.status).toBe(404);
      expect((await panelNow(panelId)).body).toBe('');
    });
  });

  describe('a panel of text is read-only until somebody says otherwise, except the one just made', () => {
    it('arrives open, and afterwards is whatever it was last set to', async () => {
      const { panelId } = await aPanelOfText();
      expect(await panelNow(panelId)).toMatchObject({ readOnly: false, body: '' });

      expect((await setReadOnly(panelId, true)).status).toBe(200);
      expect((await panelNow(panelId)).readOnly).toBe(true);

      expect((await setReadOnly(panelId, false)).status).toBe(200);
      expect((await panelNow(panelId)).readOnly).toBe(false);
    });

    /**
     * A panel of items has no text to lock and none to write, so both are
     * refused rather than quietly filling columns nothing draws. Refused rather
     * than not found: the panel is real and on this dashboard, and what is
     * wrong is what is being asked of it.
     */
    it.each([
      { situation: 'asked to hold text', send: (id: string) => setText(id, 'words') },
      { situation: 'asked to be read-only', send: (id: string) => setReadOnly(id, true) },
    ])('a panel of items, $situation', async ({ send: ask }) => {
      const dashboardId = await aDashboard();
      const panelId = nextId();
      expect((await addPanel(dashboardId, aName(), { panelId })).status).toBe(200);

      expect((await ask(panelId)).status).toBe(400);

      expect(await panelNow(panelId)).toMatchObject({ body: '', readOnly: false });
    });
  });

  describe('a panel of text shows the characters that were typed until somebody asks for formatting', () => {
    it('starts plain, takes either answer, and never touches the words', async () => {
      const { panelId } = await aPanelOfText();
      // Markdown that says one thing as characters and another as meaning, so a
      // conversion in either direction would be visible in the stored text.
      const written = ['# Standing agenda', '', '**Pricing** for Atlas Copco'].join('\n');
      expect((await setText(panelId, written)).status).toBe(200);
      expect((await panelNow(panelId)).format).toBe('plain');

      expect((await setFormat(panelId, 'rich')).status).toBe(200);
      expect(await panelNow(panelId)).toMatchObject({ format: 'rich', body: written });

      expect((await setFormat(panelId, 'plain')).status).toBe(200);
      // To the character: how it is drawn is not what it is, so switching back
      // and forth is not a conversion and cannot normalise anything.
      expect(await panelNow(panelId)).toMatchObject({ format: 'plain', body: written });
    });

    it('refuses a way of drawing that nothing knows about, and changes nothing', async () => {
      const { panelId } = await aPanelOfText();

      expect(
        (await send('set_panel_format', { workspaceId: WORKSPACE_ID, panelId, format: 'html' }))
          .status,
      ).toBe(400);

      expect((await panelNow(panelId)).format).toBe('plain');
    });

    it('is not something a panel of items is asked', async () => {
      const dashboardId = await aDashboard();
      const panelId = nextId();
      expect((await addPanel(dashboardId, aName(), { panelId })).status).toBe(200);

      expect((await setFormat(panelId, 'rich')).status).toBe(400);

      expect((await panelNow(panelId)).format).toBe('plain');
    });
  });

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

      const saved = await saveLayout(dashboardId, nextId(), wanted);

      expect(saved.status).toBe(200);
      expect(cellsOf((await layoutsOf(dashboardId))[0])).toEqual(wanted);
      // Forty panels is forty-two round trips, which is past the default five
      // seconds on its own - `startFromEmpty` empties the store before every
      // case, so this is the cost of the requests and not of what ran before.
    }, 30_000);
  });

});

describe('Layouts', () => {
  /** A dashboard with one panel on it, nobody having arranged it yet. */
  async function unarranged() {
    const dashboardId = await aDashboard();
    const panelId = nextId();
    expect((await addPanel(dashboardId, aName(), { panelId })).status).toBe(200);
    return { dashboardId, panelId };
  }

  describe('a dashboard’s first arrangement makes its one layout, and every later one changes that layout', () => {
    it('makes one the first time a dashboard is arranged, and the account keeps no list of screen sizes', async () => {
      const { dashboardId, panelId } = await unarranged();
      const layoutId = nextId();

      const saved = await saveLayout(dashboardId, layoutId, [{ panelId, span: 4 }]);

      expect(saved.status).toBe(200);
      const now = await snapshot();
      expect(now.layouts.filter((layout) => layout.dashboardId === dashboardId)).toEqual([
        {
          id: layoutId,
          tenantId: 'tenant-default',
          dashboardId,
          rows: [{ height: null, cells: [{ panelId, span: 4 }] }],
        },
      ]);
      expect(now).not.toHaveProperty('screenSizes');
    });

    it.each([
      { situation: 'the layout it has', again: (first: string) => first },
      // Two tabs that both found the dashboard unarranged, or one that has not
      // read the layout another made yet.
      { situation: 'a layout of its own it has never seen', again: () => nextId() },
    ])('arranges the same layout again when the change names $situation, and makes no second', async ({ again }) => {
      const { dashboardId, panelId } = await unarranged();
      const first = nextId();
      await saveLayout(dashboardId, first, [{ panelId, span: 4 }]);

      const saved = await saveLayout(dashboardId, again(first), [{ panelId, span: 12 }]);

      expect(saved.status).toBe(200);
      expect(await layoutsOf(dashboardId)).toEqual([
        expect.objectContaining({ id: first, rows: [{ height: null, cells: [{ panelId, span: 12 }] }] }),
      ]);
    });

    it('arranges the dashboard from a tab on the version that still named a screen size, and ignores the size', async () => {
      const { dashboardId, panelId } = await unarranged();

      const saved = await saveLayout(dashboardId, nextId(), [{ panelId, span: 6 }], {
        screenWidth: 1280,
        screenSizeId: '018f0000-0000-7000-8000-999999999999',
      });

      expect(saved.status).toBe(200);
      expect((await layoutsOf(dashboardId)).map(cellsOf)).toEqual([[{ panelId, span: 6 }]]);
    });
  });

  describe('what used to define screen sizes or remove a layout is no longer taken, and says it is retired', () => {
    /**
     * `410` rather than `404` or `400`, so a tab still on the previous version
     * is told it is behind and fetches the new one (`auth/gate.ts`,
     * `RETIRED_PATHS`), rather than landing on a refusal it can do nothing
     * about.
     */
    it.each([
      { situation: 'defining a screen size', command: 'create_screen_size', body: { name: 'Wide', width: 2560 } },
      { situation: 'renaming a screen size', command: 'rename_screen_size', body: { name: 'Big' } },
      { situation: 'removing a screen size', command: 'delete_screen_size', body: {} },
      { situation: 'removing a layout', command: 'delete_layout', body: {} },
    ])('refuses $situation and leaves the arrangement alone', async ({ command, body }) => {
      const { dashboardId, panelId } = await unarranged();
      const layoutId = nextId();
      await saveLayout(dashboardId, layoutId, [{ panelId, span: 4 }]);

      const refused = await send(command, {
        workspaceId: WORKSPACE_ID,
        screenSizeId: nextId(),
        layoutId,
        ...body,
      });

      expect(refused.status).toBe(410);
      expect((await layoutsOf(dashboardId)).map(cellsOf)).toEqual([[{ panelId, span: 4 }]]);
    });

    it('has no route left for the retired rename_layout, rather than a 500', async () => {
      // Retired before Screen sizes were ("Take the width and the name off a
      // layout, now that its size carries them", issue 264), and never added
      // to the addresses that answer as retired: every command is its own
      // static route ("one POST endpoint per change", app.ts), so retiring one
      // takes the route with it and the app never reaches command-service.ts.
      const { dashboardId, panelId } = await unarranged();
      const layoutId = nextId();
      await saveLayout(dashboardId, layoutId, [{ panelId, span: 4 }]);

      const renamed = await send('rename_layout', { workspaceId: WORKSPACE_ID, layoutId, name: 'Mine now' });

      expect(renamed.status).toBe(404);
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

      const saved = await saveRows(dashboardId, nextId(), [
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
      await saveRows(dashboardId, layoutId, [
        { height: null, cells: [{ panelId: falcon, span: 12 }] },
        { height: 200, cells: [{ panelId: anna, span: 12 }] },
      ]);

      // The two of them on one line now, which is one row where there were two.
      await saveRows(dashboardId, layoutId, [
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

      const refused = await saveRows(dashboardId, nextId(), [
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

      const refused = await saveRows(dashboardId, nextId(), [
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

      const refused = await saveRows(dashboardId, nextId(), [
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
      await saveRows(dashboardId, nextId(), [
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
     * A case at this scale used to prove the write half of "still reads the
     * workspace when it holds more layouts than a statement can name"
     * (above): that dropping the emptied rows across a hundred and twenty
     * layouts works at that scale too, not only at the small scale the cases
     * above already prove it at.
     *
     * **Removed, not quarantined** ("Delete a user, and the account they
     * owned with them", issue 234): 240 real round trips against the workers
     * pool cost ~95s on a clean run, and under heavier CI contention ran past
     * its own 120s timeout and failed outright - passing and failing
     * intermittently with no code change, which is testing-strategy.md's own
     * "Flakiness policy" definition of a suite bug that normally asks for
     * quarantine before a decision to delete. Skipped here on purpose: the
     * owner made the call directly rather than deferring it, the same way
     * "Delete the two summary-job tests that fail at random" (pull request
     * 365) did for two other cases the same week.
     *
     * **The accepted gap**: `delete_panel`'s cleanup (`command-service.ts`)
     * is a join - `exists`/`notExists` subqueries rather than an `IN` list of
     * ids, chosen specifically to avoid the statement-size ceiling this
     * scale was proving against. Nothing now catches a regression back to a
     * bound `IN` list, or any other scale-dependent behaviour in that join,
     * past a hundred layouts on one dashboard.
     */
  });
});
