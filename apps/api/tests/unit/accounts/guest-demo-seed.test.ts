import { describe, expect, it } from 'vitest';
import { accountChanges } from '../../../src/accounts/changes.js';
import { GUEST_DEMO } from '../../../src/accounts/guest-seed-data.js';
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
      ).toEqual(
        new Set([`${GUEST_ACCOUNT_NAME}-type-action`, `${GUEST_ACCOUNT_NAME}-type-thought`]),
      );
    });

    it('leaves every seeded panel, item and association one a guest can go on to change', () => {
      const statements = seedFor(GUEST_ACCOUNT_NAME);
      // Renaming, deleting and filing all take their subject's id as a uuid
      // (`packages/shared`'s commands.ts), so a readable id here would be a
      // seeded row a guest could look at and never touch.
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

      for (const table of ['panels', 'items', 'associations']) {
        const ids = statements
          .filter((one) => one.sql.includes(`INSERT INTO ${table} `))
          .map((one) => one.params?.[0]);
        expect(ids.length, table).toBeGreaterThan(0);
        for (const id of ids) expect(String(id), `${table} ${String(id)}`).toMatch(isUuid);
      }
    });
  });
});
