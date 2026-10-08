import { beforeEach, describe, expect, inject, it } from 'vitest';
import { applyD1Migrations, env } from 'cloudflare:test';
import type { Layout, WorkspaceSnapshot } from '@cockpit/shared';
import { WORKSPACE_ID, asUser, seedRegister, startFromEmpty } from '../seed.js';

/**
 * A Section, a titled row of a Dashboard's arrangement holding no Panels ("Add,
 * rename and delete a titled Section on a Dashboard", issue 896). Integration
 * level, through the real Worker, because the arrangement is a stored list
 * read back through the snapshot, so where a Section comes back is only true
 * of the real store. Its title's own rules are
 * packages/shared/tests/unit/domain/panel.test.ts; where the board draws it is
 * apps/web/tests/unit/panels/arrangement.test.ts.
 *
 * A file of its own rather than more cases in panels.test.ts, which is at the
 * size where the workers pool runs out of stack (`aged-store.test.ts` says why).
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

type Cell = { panelId: string; span: number };
type Row = { height: number | null; title?: string; cells: Cell[] };

const section = (title: string): Row => ({ height: null, title, cells: [] });
const panelRow = (...panelIds: string[]): Row => ({
  height: null,
  cells: panelIds.map((panelId) => ({ panelId, span: 12 })),
});

/** A save from a tab that knows Sections, which says so. */
const KNOWS_SECTIONS = { carriesSections: true };

function saveRows(dashboardId: string, layoutId: string, rows: Row[], extra: Record<string, unknown> = {}) {
  return send('save_layout', { workspaceId: WORKSPACE_ID, dashboardId, layoutId, rows, ...extra });
}

/** A dashboard of its own, with the panel it arrives with taken back off (panels.test.ts, `aDashboard`). */
async function aDashboard(): Promise<string> {
  const dashboardId = nextId();
  const panelId = nextId();
  expect(
    (await send('add_dashboard', { workspaceId: WORKSPACE_ID, dashboardId, panelId, name: `Today ${seq}` }))
      .status,
  ).toBe(200);
  expect((await send('delete_panel', { workspaceId: WORKSPACE_ID, panelId })).status).toBe(200);
  return dashboardId;
}

/** A dashboard holding two panels, Falcon and Anna, nobody having arranged it. */
async function twoPanels() {
  const dashboardId = await aDashboard();
  const falcon = nextId();
  const anna = nextId();
  for (const [panelId, name] of [
    [falcon, 'Project Falcon'],
    [anna, 'Anna'],
  ] as const) {
    expect((await send('add_panel', { workspaceId: WORKSPACE_ID, dashboardId, panelId, name })).status).toBe(200);
  }
  return { dashboardId, falcon, anna };
}

async function layoutsOf(dashboardId: string): Promise<Layout[]> {
  const res = await asUser(`http://cockpit.test/v1/workspaces/${WORKSPACE_ID}/snapshot`);
  expect(res.status).toBe(200);
  return ((await res.json()) as WorkspaceSnapshot).layouts.filter((layout) => layout.dashboardId === dashboardId);
}

async function rowsOf(dashboardId: string): Promise<Row[]> {
  return ((await layoutsOf(dashboardId))[0]?.rows ?? []) as Row[];
}

beforeEach(async () => {
  await applyD1Migrations(env.DB, inject('migrations'));
  await startFromEmpty();
  await seedRegister();
  seq = 0;
});

describe('Layouts', () => {
  describe('a Section comes back where it was saved, on every read, until it is deleted', () => {
    it.each([
      { situation: 'above the first row', rows: (f: string, a: string) => [section('Now'), panelRow(f), panelRow(a)] },
      { situation: 'between two rows', rows: (f: string, a: string) => [panelRow(f), section('Now'), panelRow(a)] },
      {
        situation: 'beside another, with nothing between them',
        rows: (f: string, a: string) => [panelRow(f), section('Now'), section('Later'), panelRow(a)],
      },
      { situation: 'at the foot, with nothing under it', rows: (f: string, a: string) => [panelRow(f, a), section('Later')] },
    ])('keeps a Section $situation', async ({ rows }) => {
      const { dashboardId, falcon, anna } = await twoPanels();

      const saved = await saveRows(dashboardId, nextId(), rows(falcon, anna), KNOWS_SECTIONS);

      expect(saved.status).toBe(200);
      expect(await rowsOf(dashboardId)).toEqual(rows(falcon, anna));
    });

    it('keeps a Section on a dashboard with no panels at all', async () => {
      const dashboardId = await aDashboard();

      await saveRows(dashboardId, nextId(), [section('Soon')], KNOWS_SECTIONS);

      expect(await rowsOf(dashboardId)).toEqual([section('Soon')]);
    });

    it('makes the layout of a dashboard nobody has arranged, from the panels as drawn and the Section after them', async () => {
      const { dashboardId, falcon, anna } = await twoPanels();
      const layoutId = nextId();

      await saveRows(dashboardId, layoutId, [panelRow(falcon, anna), section('Next')], KNOWS_SECTIONS);

      expect(await layoutsOf(dashboardId)).toEqual([
        expect.objectContaining({ id: layoutId, rows: [panelRow(falcon, anna), section('Next')] }),
      ]);
    });

    it('still drops the row a deleted panel leaves empty, and keeps the Section above it', async () => {
      const { dashboardId, falcon, anna } = await twoPanels();
      await saveRows(dashboardId, nextId(), [panelRow(falcon), section('Now'), panelRow(anna)], KNOWS_SECTIONS);

      await send('delete_panel', { workspaceId: WORKSPACE_ID, panelId: anna });

      expect(await rowsOf(dashboardId)).toEqual([panelRow(falcon), section('Now')]);
    });

    it.each([
      {
        situation: 'saved again with a new title, carries the new title',
        again: (f: string, a: string) => [panelRow(f), section('Later'), panelRow(a)],
      },
      {
        situation: 'saved again without it, is gone and every panel is where it was',
        again: (f: string, a: string) => [panelRow(f), panelRow(a)],
      },
    ])('$situation', async ({ again }) => {
      const { dashboardId, falcon, anna } = await twoPanels();
      const layoutId = nextId();
      await saveRows(dashboardId, layoutId, [panelRow(falcon), section('Now'), panelRow(anna)], KNOWS_SECTIONS);

      await saveRows(dashboardId, layoutId, again(falcon, anna), KNOWS_SECTIONS);

      expect(await rowsOf(dashboardId)).toEqual(again(falcon, anna));
    });
  });

  describe('a Section’s title is refused where it is too long, and nothing is stored', () => {
    it('says why, and keeps the arrangement as it was', async () => {
      const { dashboardId, falcon } = await twoPanels();
      const layoutId = nextId();
      await saveRows(dashboardId, layoutId, [panelRow(falcon), section('Now')], KNOWS_SECTIONS);

      const refused = await saveRows(
        dashboardId,
        layoutId,
        [panelRow(falcon), section('x'.repeat(61))],
        KNOWS_SECTIONS,
      );

      expect(refused.status).toBe(400);
      expect(JSON.stringify(await refused.json())).toContain('a section title is at most 60 characters');
      expect(await rowsOf(dashboardId)).toEqual([panelRow(falcon), section('Now')]);
    });
  });

  /**
   * A tab opened before Sections existed sends its arrangement without them and
   * without saying it knows them, so its save keeps the stored ones.
   */
  describe('a save from a tab that predates Sections keeps them, each above the panel it headed', () => {
    it.each([
      {
        situation: 'the panels reordered, each Section above the panel it headed',
        stored: (f: string, a: string) => [section('Now'), panelRow(f), section('Later'), panelRow(a)],
        old: (f: string, a: string) => [panelRow(a), panelRow(f)],
        after: (f: string, a: string) => [section('Later'), panelRow(a), section('Now'), panelRow(f)],
      },
      {
        situation: 'the panel a Section headed left out, the Section at the end',
        stored: (f: string, a: string) => [section('Now'), panelRow(f), panelRow(a)],
        old: (_f: string, a: string) => [panelRow(a)],
        after: (_f: string, a: string) => [panelRow(a), section('Now')],
      },
      {
        situation: 'a Section that headed nothing, still last',
        stored: (f: string, a: string) => [panelRow(f, a), section('Later')],
        old: (f: string, a: string) => [panelRow(a), panelRow(f)],
        after: (f: string, a: string) => [panelRow(a), panelRow(f), section('Later')],
      },
    ])('$situation', async ({ stored, old, after }) => {
      const { dashboardId, falcon, anna } = await twoPanels();
      const layoutId = nextId();
      await saveRows(dashboardId, layoutId, stored(falcon, anna), KNOWS_SECTIONS);

      const saved = await saveRows(dashboardId, layoutId, old(falcon, anna));

      expect(saved.status).toBe(200);
      expect(await rowsOf(dashboardId)).toEqual(after(falcon, anna));
    });

    it('deletes every Section where the tab knows them and sends none', async () => {
      const { dashboardId, falcon, anna } = await twoPanels();
      const layoutId = nextId();
      await saveRows(dashboardId, layoutId, [section('Now'), panelRow(falcon), panelRow(anna)], KNOWS_SECTIONS);

      await saveRows(dashboardId, layoutId, [panelRow(anna), panelRow(falcon)], KNOWS_SECTIONS);

      expect(await rowsOf(dashboardId)).toEqual([panelRow(anna), panelRow(falcon)]);
    });
  });

  describe('Sections save and read back whole past what one statement can hold', () => {
    it('keeps every one of thirty Sections and the panels between them', async () => {
      // Thirty-two rows bind five values each, past the hundred a statement
      // takes, so the rows go in several inserts inside the one save.
      const { dashboardId, falcon, anna } = await twoPanels();
      const rows = [
        panelRow(falcon),
        ...Array.from({ length: 30 }, (_, at) => section(`Week ${at + 1}`)),
        panelRow(anna),
      ];

      const saved = await saveRows(dashboardId, nextId(), rows, KNOWS_SECTIONS);

      expect(saved.status).toBe(200);
      expect(await rowsOf(dashboardId)).toEqual(rows);
    });
  });
});
