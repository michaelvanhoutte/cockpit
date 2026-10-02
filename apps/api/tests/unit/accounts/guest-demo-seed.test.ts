import { afterEach, describe, expect, it, vi } from 'vitest';
import { GRID_COLUMNS } from '@cockpit/shared';
import {
  accountChanges,
  checkedGuestDemo,
  guestDemoStatements,
  noteTypeId,
  taskTypeId,
} from '../../../src/accounts/changes.js';
import {
  GUEST_DEMO,
  isFilter,
  type SeedInboxItem,
  type SeedItem,
  type SeedPanel,
  type SeedWorkspace,
} from '../../../src/accounts/guest-seed-data.js';
import { GUEST_ACCOUNT_NAME } from '../../../src/auth/register.js';
import type { Statement } from '../../../src/accounts/up-to-date.js';

/**
 * L1: which account gets the demonstration, and whether what is built for it
 * says what the content says, are both decisions about a list of values - no
 * storage and no account to open, and the day it is written is handed in
 * rather than read off a clock. Whether those statements actually land is
 * asked of a real store in tests/integration/accounts/guest-demo.test.ts.
 */

const SEED = '0026-guest-demo-seed';
/** The day these statements are written on: a Wednesday, so a week runs either side of it. */
const DAY = '2026-10-07';
const MIDNIGHT = Date.parse(`${DAY}T00:00:00.000Z`);

function seedFor(accountId: string): Statement[] {
  const change = accountChanges(accountId).find((one) => one.name === SEED);
  expect(change, `${SEED} is not in the list`).toBeDefined();
  return [...change!.statements];
}

const guestSeed = () => [...guestDemoStatements(GUEST_ACCOUNT_NAME, DAY)];

/** Everything bound by the statements that write into `table`, flattened. */
function boundBy(statements: readonly Statement[], table: string): unknown[] {
  return statements
    .filter((statement) => statement.sql.includes(`INSERT INTO ${table} `))
    .flatMap((statement) => [...(statement.params ?? [])]);
}

/** What one written Item was bound with, by name rather than by position. */
interface WrittenItem {
  id: string;
  title: string;
  dueDate: unknown;
  startedAt: unknown;
  createdAt: string;
}

function itemsWritten(statements: readonly Statement[]): WrittenItem[] {
  return statements
    .filter((one) => one.sql.includes('INSERT INTO items '))
    .map((one) => {
      const p = one.params!;
      return {
        id: String(p[0]),
        title: String(p[4]),
        dueDate: p[8],
        startedAt: p[9],
        createdAt: String(p[15]),
      };
    });
}

const panelsOf = (workspace: SeedWorkspace): SeedPanel[] =>
  workspace.dashboards.flatMap((dashboard) => dashboard.rows.flatMap((row) => row.panels));

const filedItems: SeedItem[] = GUEST_DEMO.flatMap((workspace) =>
  panelsOf(workspace).flatMap((panel) => (isFilter(panel) ? [] : panel.items)),
);
const inboxItems: SeedInboxItem[] = GUEST_DEMO.flatMap((workspace) => workspace.inbox);

const dayIn = (days: number) => new Date(MIDNIGHT + days * 86_400_000).toISOString().slice(0, 10);

describe('Accounts', () => {
  describe('only the guest account opens on work somebody has already done', () => {
    it('leaves every other account nothing to apply', () => {
      expect(seedFor('tenant-default')).toEqual([]);
      expect(seedFor('tenant-ada')).toEqual([]);
    });

    it('is written last, into every column the changes before it leave', () => {
      expect(accountChanges(GUEST_ACCOUNT_NAME).at(-1)?.name).toBe(SEED);
    });

    it('gives the guest account every workspace, dashboard and panel it opens on', () => {
      const statements = guestSeed();

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

    it('files every item written on a panel onto it, leaves every inbox item on none, and gives each a type the account already has', () => {
      const statements = guestSeed();
      // Every check below finds an Item by its title.
      const titles = [...filedItems, ...inboxItems].map((item) => item.title);
      expect(new Set(titles).size, 'two seeded items share a title').toBe(titles.length);

      const written = itemsWritten(statements);
      const filed = new Set(boundBy(statements, 'panel_items'));

      expect(written).toHaveLength(filedItems.length + inboxItems.length);
      for (const item of filedItems) {
        const one = written.find((w) => w.title === item.title)!;
        expect(filed.has(one.id), `${item.title} is not filed`).toBe(true);
      }
      for (const item of inboxItems) {
        const one = written.find((w) => w.title === item.title)!;
        expect(filed.has(one.id), `${item.title} is filed`).toBe(false);
      }
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
      const statements = guestSeed();
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
      const positions = guestSeed()
        .filter((one) => one.sql.includes('INSERT INTO workspaces '))
        .map((one) => one.params?.[8]);

      // `0015-first-workspace` holds 0 and anything a guest makes for
      // themselves goes above it, so the demonstration counts down from below
      // both - in the order it is written in, which is the order the tabs come
      // back in and therefore which one a guest lands on.
      expect(positions).toEqual(GUEST_DEMO.map((_, index) => index - GUEST_DEMO.length));
    });

    it('gives every panel of a row an equal share of a grid the row fits inside', () => {
      const placements = guestSeed().filter((one) => one.sql.includes('INSERT INTO panel_placements '));
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

    /** What made the first version read as invented: every Panel six Items long. */
    it('fills its panels as unevenly as a real list is', () => {
      const sizes = GUEST_DEMO.flatMap(panelsOf).flatMap((panel) =>
        isFilter(panel) ? [] : [panel.items.length],
      );

      expect(Math.min(...sizes)).toBeLessThanOrEqual(2);
      expect(Math.max(...sizes)).toBeGreaterThanOrEqual(10);
      expect(new Set(sizes).size).toBeGreaterThanOrEqual(6);
    });
  });

  /**
   * The guest account is rebuilt every night, so these hold on whatever day a
   * visitor opens it - which is what lets a Filter on this week have something
   * to show.
   */
  describe('the demonstration is dated from the day it is written', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('puts every due date that many days from that day', () => {
      const written = itemsWritten(guestSeed());

      for (const item of [...filedItems, ...inboxItems]) {
        const one = written.find((w) => w.title === item.title)!;
        expect(one.dueDate, item.title).toBe(item.due === undefined ? null : dayIn(item.due));
      }
    });

    it('makes and starts every item before that day begins, and starts none before it was made', () => {
      const written = itemsWritten(guestSeed());

      for (const one of written) {
        expect(Date.parse(one.createdAt), one.title).toBeLessThan(MIDNIGHT);
        if (one.startedAt === null) continue;
        expect(Date.parse(String(one.startedAt)), one.title).toBeLessThan(MIDNIGHT);
        expect(Date.parse(String(one.startedAt)), one.title).toBeGreaterThan(Date.parse(one.createdAt));
      }
      // Spread back over weeks, so how long each has waited differs.
      expect(new Set(written.map((one) => one.createdAt.slice(0, 10))).size).toBeGreaterThan(20);
    });

    it('writes the next day with that day’s dates rather than the day before’s', () => {
      const dueDates = () =>
        itemsWritten(seedFor(GUEST_ACCOUNT_NAME)).flatMap((one) => (one.dueDate ? [one.dueDate] : []));

      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date(`${DAY}T03:00:00.000Z`));
      const first = dueDates();
      vi.setSystemTime(new Date(`${dayIn(1)}T03:00:00.000Z`));
      const second = dueDates();

      expect(second).toEqual(
        first.map((date) => new Date(Date.parse(String(date)) + 86_400_000).toISOString().slice(0, 10)),
      );
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
    const workspace = (
      name: string,
      panels: SeedPanel[][],
      inbox: SeedInboxItem[] = [],
    ): SeedWorkspace => ({
      name,
      tint: '#3a72c8',
      inbox,
      dashboards: [{ name: 'Day to day', rows: panels.map((row) => ({ panels: row })) }],
    });
    const filter = (name: string, conditions: unknown[], match = 'all'): SeedPanel =>
      ({ name, filter: { match, conditions } }) as SeedPanel;

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
      {
        why: 'an inbox item suggests a panel its workspace does not have',
        demo: [workspace('Personal', [[panel('Errands')]], [{ title: 'x', suggest: { panel: 'Chores', why: 'y' } }])],
        says: 'suggests "Chores"',
      },
      {
        why: 'an inbox item suggests a filter, which nothing can be filed on',
        demo: [
          workspace(
            'Personal',
            [[filter('Due soon', [{ field: 'dueDate', window: 'week', orOverdue: true }])]],
            [{ title: 'x', suggest: { panel: 'Due soon', why: 'y' } }],
          ),
        ],
        says: 'suggests "Due soon"',
      },
      {
        why: 'a filter has no conditions',
        demo: [workspace('Personal', [[filter('Everything', [])]])],
        says: 'the Filter "Everything"',
      },
      {
        why: 'a filter has a condition the app cannot read',
        demo: [workspace('Personal', [[filter('Soon', [{ field: 'dueDate', window: 'fortnight' }])]])],
        says: 'the Filter "Soon"',
      },
      {
        why: 'a filter says how its conditions combine in a way the app would read as All',
        demo: [
          workspace('Personal', [
            [filter('Either', [{ field: 'dueDate', window: 'week', orOverdue: true }], 'anyy')],
          ]),
        ],
        says: 'the Filter "Either"',
      },
    ])('refuses a dataset where $why', ({ demo, says }) => {
      expect(() => checkedGuestDemo(demo)).toThrow(says);
    });

    it('accepts the demonstration that is actually shipped', () => {
      expect(() => checkedGuestDemo(GUEST_DEMO)).not.toThrow();
    });
  });
});
