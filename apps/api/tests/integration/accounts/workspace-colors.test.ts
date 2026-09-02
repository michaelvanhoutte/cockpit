import { beforeEach, describe, expect, inject, it } from 'vitest';
import { applyD1Migrations, env } from 'cloudflare:test';
import { WORKSPACE_THEMES, themeOf } from '@cockpit/shared';
import { accountChanges } from '../../../src/accounts/changes.js';
import { inStoreAsItIs, startFromEmpty, storeNamed } from '../seed.js';

/**
 * What an account's workspaces are wearing once the fourth color exists
 * ("Modernise the app shell: a fourth workspace colour, connected tabs, and
 * Inbox rows you can read at a glance", issue 125).
 *
 * **What this adds over the tests that already exist.**
 * apps/api/tests/integration/accounts/aged-store.test.ts proves every update
 * *applies* to a store that already has rows, and it covers this one for free
 * by being parameterised over the list. It does not look at what the update
 * computed, and the whole risk of a backfill is there: a column added to every
 * row with one default is wrong for seven of the eight themes until the update
 * that follows it corrects them.
 */

const AT = '2026-08-12T10:00:00.000Z';

/** The changes before the one under test, so a fixture can be a store that predates it. */
const BEFORE_THE_BAR = accountChanges('any-account-would-do').length - 1;

function fixtureName(suffix: string): string {
  return `workspace-colors-${suffix}`;
}

/**
 * A store as it stood before the bar existed: everything up to that point
 * applied and recorded, with the workspaces given.
 *
 * The columns are named out loud and `bar` is not among them, which is the
 * point of the fixture - this is the shape a real account was left in.
 */
async function storeBeforeTheBar(
  name: string,
  workspaces: { id: string; color: string }[],
): Promise<void> {
  await inStoreAsItIs(name, (sql) => {
    sql.exec(
      `CREATE TABLE IF NOT EXISTS account_changes (
         name text PRIMARY KEY NOT NULL,
         applied_at text NOT NULL
       ) STRICT`,
    );
    for (const change of accountChanges(name).slice(0, BEFORE_THE_BAR)) {
      for (const statement of change.statements) {
        sql.exec(statement.sql, ...(statement.params ?? []));
      }
      sql.exec('INSERT INTO account_changes (name, applied_at) VALUES (?, ?)', change.name, AT);
    }
    // The starting workspaces are already in there from the change above, and
    // these are extra: one per case, so a case cannot read another's row.
    for (const workspace of workspaces) {
      const theme = themeOf(workspace.color);
      sql.exec(
        `INSERT INTO workspaces (id, tenant_id, name, folded_name, color, ground, header, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        workspace.id,
        name,
        workspace.id,
        workspace.id,
        workspace.color,
        theme.ground,
        theme.header,
        AT,
      );
    }
  });
}

/** The bar every workspace of a store ended up with, by workspace id. */
async function barsIn(name: string): Promise<Record<string, string>> {
  const rows = await inStoreAsItIs(name, (sql) =>
    sql.exec<{ id: string; bar: string }>('SELECT id, bar FROM workspaces').toArray(),
  );
  return Object.fromEntries(rows.map((row) => [row.id, row.bar]));
}

beforeEach(async () => {
  await applyD1Migrations(env.DB, inject('migrations'));
  await startFromEmpty();
});

describe('Workspace management', () => {
  describe('an account opened after the bar exists wears the bar its theme was designed with', () => {
    // L2: this is a change list applied to a real store, and what the SQL
    // computed only exists once it has run against real rows.
    it('gives a workspace of every theme the bar of that theme', async () => {
      const name = fixtureName('every-theme');
      await storeBeforeTheBar(
        name,
        WORKSPACE_THEMES.map((theme) => ({ id: `ws-${theme.name.toLowerCase()}`, color: theme.tint })),
      );

      // Opening the store is what brings it up to date, exactly as the first
      // request of the day does for a real account.
      expect(await storeNamed(name).workspaces(name)).toMatchObject({ status: 'ok' });

      const bars = await barsIn(name);
      for (const theme of WORKSPACE_THEMES) {
        expect(bars[`ws-${theme.name.toLowerCase()}`], theme.name).toBe(theme.bar);
      }
    });

    it('leaves a workspace whose color is not the palette’s on the default bar, and still opens', async () => {
      const name = fixtureName('unfamiliar');
      await storeBeforeTheBar(name, [{ id: 'ws-stranger', color: '#123456' }]);

      expect(await storeNamed(name).workspaces(name)).toMatchObject({ status: 'ok' });

      expect((await barsIn(name))['ws-stranger']).toBe(WORKSPACE_THEMES[0]!.bar);
    });

    it('gives the workspaces a brand new account starts with their own bars', async () => {
      const name = fixtureName('brand-new');

      expect(await storeNamed(name).workspaces(name)).toMatchObject({ status: 'ok' });

      const bars = await barsIn(name);
      // The three an account starts with, wearing the first three themes.
      expect(bars).toEqual({
        'ws-work': WORKSPACE_THEMES[0]!.bar,
        'ws-atlas': WORKSPACE_THEMES[1]!.bar,
        'ws-personal': WORKSPACE_THEMES[2]!.bar,
      });
    });
  });
});
