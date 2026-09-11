import { describe, expect, it } from 'vitest';
import { GRID_COLUMNS } from '@cockpit/shared';
import {
  accountChanges,
  checkedGuestDemo,
  noteTypeId,
  taskTypeId,
} from '../../../src/accounts/changes.js';
import { GUEST_DEMO, type SeedPanel, type SeedWorkspace } from '../../../src/accounts/guest-seed-data.js';
import { GUEST_ACCOUNT_NAME } from '../../../src/auth/register.js';
import type { Statement } from '../../../src/accounts/up-to-date.js';

/**
 * L1: which account gets the demonstration, and whether what is built for it
 * says what the content says, are both decisions about a list of values - no
 * storage, no clock and no account to open. Whether those statements actually
 * land is asked of a real store in
 * tests/integration/accounts/guest-demo.test.ts.
 */

const SEED = '0026-guest-demo-seed';

function seedFor(accountId: string): Statement[] {
  const change = accountChanges(accountId).find((one) => one.name === SEED);
  expect(change, `${SEED} is not in the list`).toBeDefined();
  return [...change!.statements];
}

/** Everything bound by the statements that write into `table`, flattened. */
function boundBy(statements: readonly Statement[], table: string): unknown[] {
  return statements
    .filter((statement) => statement.sql.includes(`INSERT INTO ${table} `))
    .flatMap((statement) => [...(statement.params ?? [])]);
}

describe('Accounts', () => {
  describe('only the guest account opens on work somebody has already done', () => {
    it('leaves every other account nothing to apply', () => {
      expect(seedFor('tenant-default')).toEqual([]);
      expect(seedFor('tenant-ada')).toEqual([]);
    });

    it('gives the guest account every workspace, dashboard and panel it opens on', () => {
      const statements = seedFor(GUEST_ACCOUNT_NAME);

      const workspaces = boundBy(statements, 'workspaces');
      const dashboards = boundBy(statements, 'dashboards');
      const panels = boundBy(statements, 'panels');
      for (const workspace of GUEST_DEMO) {
        expect(workspaces, `${workspace.name} is not seeded`).toContain(workspace.name);
        for (const dashboard of workspace.dashboards) {
          expect(dashboards, `${dashboard.name} is not seeded`).toContain(dashboard.name);
          for (const row of dashboard.rows) {
            for (const panel of row.panels) {
              expect(panels, `${panel.name} is not seeded`).toContain(panel.name);
            }
          }
        }
      }
    });

    it('files every item it writes onto a panel, and gives each one a type the account already has', () => {
      const statements = seedFor(GUEST_ACCOUNT_NAME);
      const authored = GUEST_DEMO.flatMap((workspace) =>
        workspace.dashboards.flatMap((dashboard) =>
          dashboard.rows.flatMap((row) => row.panels.flatMap((panel) => panel.items)),
        ),
      );

      const written = statements.filter((one) => one.sql.includes('INSERT INTO items '));
      const filed = statements.filter((one) => one.sql.includes('INSERT INTO panel_items '));

      expect(written).toHaveLength(authored.length);
      expect(filed).toHaveLength(authored.length);
      // The two standard types every account is given (`0008-item-types`,
      // renamed by `0012-standard-types`), and no third one invented here.
      expect(
        new Set(
          boundBy(statements, 'items').filter(
            (bound) => typeof bound === 'string' && bound.startsWith(`${GUEST_ACCOUNT_NAME}-type-`),
          ),
        ),
      ).toEqual(new Set([taskTypeId(GUEST_ACCOUNT_NAME), noteTypeId(GUEST_ACCOUNT_NAME)]));
    });

    it('leaves every seeded panel, item and association one a guest can go on to change', () => {
      const statements = seedFor(GUEST_ACCOUNT_NAME);
      // Renaming, deleting and filing all take their subject's id as a uuid
      // (`packages/shared`'s commands.ts), so a readable id here would be a
      // seeded row a guest could look at and never touch.
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

      // `layouts` is in this list because `save_layout` takes its `layoutId`
      // as a uuid too: a readable one here is a seeded Dashboard whose panels
      // cannot be dragged, refused before the handler ever runs.
      for (const table of ['layouts', 'panels', 'items', 'associations']) {
        const ids = statements
          .filter((one) => one.sql.includes(`INSERT INTO ${table} `))
          .map((one) => one.params?.[0]);
        expect(ids.length, table).toBeGreaterThan(0);
        for (const id of ids) expect(String(id), `${table} ${String(id)}`).toMatch(isUuid);
      }
    });

    it('puts its workspaces ahead of the empty starter every account is given', () => {
      const positions = seedFor(GUEST_ACCOUNT_NAME)
        .filter((one) => one.sql.includes('INSERT INTO workspaces '))
        .map((one) => one.params?.[8]);

      // `0015-first-workspace` holds 0 and anything a guest makes for
      // themselves goes above it, so the demonstration counts down from below
      // both - in the order it is written in, which is the order the tabs come
      // back in and therefore which one a guest lands on.
      expect(positions).toEqual(GUEST_DEMO.map((_, index) => index - GUEST_DEMO.length));
    });

    it('gives every panel of a row an equal share of a grid the row fits inside', () => {
      const placements = seedFor(GUEST_ACCOUNT_NAME).filter((one) =>
        one.sql.includes('INSERT INTO panel_placements '),
      );
      const shares = GUEST_DEMO.flatMap((workspace) =>
        workspace.dashboards.flatMap((dashboard) =>
          dashboard.rows.flatMap((row) =>
            row.panels.map(() => Math.floor(GRID_COLUMNS / row.panels.length)),
          ),
        ),
      );

      expect(placements.map((one) => one.params?.[5])).toEqual(shares);
      // What `panel_placements_span_fits_the_grid` refuses, and a refusal here
      // takes the whole change with it.
      for (const span of shares) expect(span).toBeGreaterThanOrEqual(1);
      for (const span of shares) expect(span).toBeLessThanOrEqual(GRID_COLUMNS);
    });
  });

  /**
   * What a later edit to guest-seed-data.ts may not do. Each of these is a
   * constraint the store enforces, and the change's statements commit as one
   * transaction - so an edit that broke one would not cost a Panel, it would
   * leave every guest unable to open the account at all.
   */
  describe('a demonstration the store would refuse is refused before it is turned into rows', () => {
    const panel = (name: string): SeedPanel => ({ name, items: [] });
    const workspace = (name: string, panels: SeedPanel[][]): SeedWorkspace => ({
      name,
      tint: '#3a72c8',
      dashboards: [{ name: 'Day to day', rows: panels.map((row) => ({ panels: row })) }],
    });

    it.each([
      {
        why: 'two panels of one dashboard share a name',
        // `panels_dashboard_live_folded_name` is unique on the folded name, so
        // a difference of case is not a difference.
        demo: [workspace('Personal', [[panel('This week'), panel('THIS WEEK')]])],
        says: 'two panels called',
      },
      {
        why: 'two workspace names fold to one id',
        demo: [workspace('Halcyon Health', [[panel('Today')]]), workspace('halcyon health!', [[panel('Today')]])],
        says: 'share the id',
      },
      {
        why: 'a row holds more panels than a row may hold',
        demo: [
          workspace('Personal', [
            [panel('One'), panel('Two'), panel('Three'), panel('Four'), panel('Five')],
          ]),
        ],
        says: 'holds 5 panels',
      },
      {
        why: 'a row holds no panel at all',
        demo: [workspace('Personal', [[]])],
        says: 'holds 0 panels',
      },
    ])('refuses a dataset where $why', ({ demo, says }) => {
      expect(() => checkedGuestDemo(demo)).toThrow(says);
    });

    it('accepts the demonstration that is actually shipped', () => {
      expect(() => checkedGuestDemo(GUEST_DEMO)).not.toThrow();
    });
  });
});
