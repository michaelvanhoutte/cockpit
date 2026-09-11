import { beforeEach, describe, expect, inject, it } from 'vitest';
import { SELF, applyD1Migrations, env } from 'cloudflare:test';
import { FIRST_WORKSPACE_NAME } from '@cockpit/shared';
import type { Workspace, WorkspaceSnapshot } from '@cockpit/shared';
import { accountChanges } from '../../../src/accounts/changes.js';
import { GUEST_ACCOUNT_NAME } from '../../../src/auth/register.js';
import { inStoreAsItIs, seedRegister, startFromEmpty } from '../seed.js';

/**
 * Integration level, and it could be nothing else: what is claimed is what a
 * guest finds in the account when they open it, which is a whole store's worth
 * of rows put there by statements and read back by queries. The list of
 * statements is a value and is asked about at L1
 * (tests/unit/accounts/guest-demo-seed.test.ts); nothing below re-proves it.
 *
 * **Entered the way a guest enters**, through the guest route and then the
 * ordinary reads the app makes, rather than by reaching into the store: the
 * account is created by that press, brought up to date by the first read, and
 * both halves are on the path being claimed.
 *
 * The seed never running twice is not asked here. That is the ledger's own
 * guarantee for every change there has ever been (up-to-date.ts, and
 * tests/unit/accounts/up-to-date.test.ts), and re-proving it per change is the
 * duplication the testing skill refuses.
 */

/** Pressing "Continue as guest", and the cookie it hands back. */
async function continueAsGuest(): Promise<string> {
  const back = await SELF.fetch('http://cockpit.test/v1/sign-in/guest', { redirect: 'manual' });
  expect(back.headers.get('location')).toBe('/');
  const cookie = back.headers
    .getSetCookie()
    .map((one) => one.split(';')[0]!)
    .find((one) => one.startsWith('cockpit_session='));
  expect(cookie, 'continuing as a guest set no session cookie').toBeDefined();
  return cookie!;
}

/** The body of a read that has to have worked, with what it said where it did not. */
async function read<T>(url: string, cookie: string): Promise<T> {
  const res = await SELF.fetch(url, { headers: { cookie } });
  const said = await res.text();
  expect(res.status, said).toBe(200);
  return JSON.parse(said) as T;
}

async function workspacesOf(cookie: string): Promise<Workspace[]> {
  return (await read<{ workspaces: Workspace[] }>('http://cockpit.test/v1/workspaces', cookie))
    .workspaces;
}

function snapshotOf(cookie: string, workspaceId: string): Promise<WorkspaceSnapshot> {
  return read<WorkspaceSnapshot>(
    `http://cockpit.test/v1/workspaces/${workspaceId}/snapshot`,
    cookie,
  );
}

/** A command issued the way the app issues one, as the guest who is holding this cookie. */
async function send(command: string, cookie: string, body: Record<string, unknown>) {
  return SELF.fetch(`http://cockpit.test/v1/commands/${command}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({
      commandId: '018f0000-0000-7000-8000-000000000001',
      issuedAt: '2026-09-11T10:00:00.000Z',
      ...body,
    }),
  });
}

const named = (workspaces: readonly Workspace[], name: string): Workspace => {
  const found = workspaces.find((one) => one.name === name);
  expect(found, `no workspace called ${name}: ${workspaces.map((w) => w.name).join(', ')}`).toBeDefined();
  return found!;
};

beforeEach(async () => {
  await applyD1Migrations(env.DB, inject('migrations'));
  await startFromEmpty();
  await seedRegister();
});

describe('Accounts', () => {
  describe('a guest opens on work somebody has already done, not on an empty starter', () => {
    it('holds several workspaces, and gives the ones with work in them more than one dashboard', async () => {
      const cookie = await continueAsGuest();

      const workspaces = await workspacesOf(cookie);

      expect(workspaces.map((one) => one.name)).toEqual(
        expect.arrayContaining(['Personal', 'Halcyon Health', 'Oakline Retail']),
      );
      const personal = await snapshotOf(cookie, named(workspaces, 'Personal').id);
      const halcyon = await snapshotOf(cookie, named(workspaces, 'Halcyon Health').id);
      expect(personal.dashboards.map((one) => one.name)).toEqual(['Day to day', 'Volleyball club']);
      expect(halcyon.dashboards.map((one) => one.name)).toEqual([
        'Day to day',
        'Platform migration',
        'ISO 27001 certification',
      ]);
    });

    it('arranges a dashboard with its panels across more than one row', async () => {
      const cookie = await continueAsGuest();
      const halcyon = await snapshotOf(cookie, named(await workspacesOf(cookie), 'Halcyon Health').id);

      const migration = halcyon.dashboards.find((one) => one.name === 'Platform migration')!;
      const layout = halcyon.layouts.find((one) => one.dashboardId === migration.id);

      expect(layout, 'the dashboard was seeded with no arrangement at all').toBeDefined();
      expect(layout!.rows).toHaveLength(2);
      expect(
        layout!.rows.map((row) =>
          row.cells.map((cell) => halcyon.panels.find((panel) => panel.id === cell.panelId)?.name),
        ),
      ).toEqual([
        ['Infrastructure & cloud', 'Data migration', 'API & service cutover'],
        ['Testing & QA', 'Rollout & communications'],
      ]);
    });

    /**
     * The point of the whole change, and the one claim a list of statements
     * cannot make: the app opens on the first workspace it is handed
     * (`somewhereThatWorks`, apps/web/src/router.tsx), so what is being asked
     * here is what the ordinary read puts first.
     */
    it('hands the demonstration back ahead of the empty starter, so that is where a guest lands', async () => {
      const cookie = await continueAsGuest();

      const workspaces = await workspacesOf(cookie);

      expect(workspaces.map((one) => one.name)).toEqual([
        'Personal',
        'Halcyon Health',
        'Oakline Retail',
        FIRST_WORKSPACE_NAME,
      ]);
    });

    /**
     * A seeded arrangement a guest cannot touch is a demonstration of a
     * read-only Cockpit. `save_layout` takes its `layoutId` as a uuid, so this
     * is what a readable one would have cost: a 400 before the handler ran,
     * on every drag of every seeded dashboard.
     */
    it('lets a guest rearrange a dashboard it seeded', async () => {
      const cookie = await continueAsGuest();
      const halcyon = await snapshotOf(cookie, named(await workspacesOf(cookie), 'Halcyon Health').id);
      const migration = halcyon.dashboards.find((one) => one.name === 'Platform migration')!;
      const layout = halcyon.layouts.find((one) => one.dashboardId === migration.id)!;
      // The first row's panels, the first two of them swapped - a drag, said
      // the way the client says it.
      const [first, ...rest] = layout.rows;
      const swapped = [
        { height: first!.height, cells: [first!.cells[1]!, first!.cells[0]!, ...first!.cells.slice(2)] },
        ...rest.map((row) => ({ height: row.height, cells: row.cells })),
      ];

      const saved = await send('save_layout', cookie, {
        workspaceId: halcyon.workspace.id,
        dashboardId: migration.id,
        layoutId: layout.id,
        screenWidth: 1440,
        rows: swapped,
      });

      expect(saved.status, await saved.clone().text()).toBe(200);
      const now = await snapshotOf(cookie, halcyon.workspace.id);
      const again = now.layouts.find((one) => one.dashboardId === migration.id)!;
      expect(again.rows[0]!.cells.map((cell) => cell.panelId)).toEqual(
        swapped[0]!.cells.map((cell) => cell.panelId),
      );
    });

    it('files items onto those panels, some due on a date at a priority and some tied to a person or a project', async () => {
      const cookie = await continueAsGuest();
      const halcyon = await snapshotOf(cookie, named(await workspacesOf(cookie), 'Halcyon Health').id);

      const filed = new Set(halcyon.filings.map((one) => one.itemId));
      expect(halcyon.items.length).toBeGreaterThan(10);
      expect(halcyon.items.every((item) => filed.has(item.id))).toBe(true);
      expect(halcyon.items.some((item) => item.dueDate !== null && item.priority !== null)).toBe(
        true,
      );
      expect(new Set(halcyon.associations.map((one) => one.kind))).toEqual(
        new Set(['person', 'project', 'topic']),
      );
      // The two the dates are there to show: one already past its date and one
      // still to come, both of them wanted.
      const dated = halcyon.items.flatMap((item) => (item.dueDate ? [item.dueDate] : []));
      expect(Math.min(...dated.map(Date.parse))).toBeLessThan(Date.parse('2026-09-10'));
      expect(Math.max(...dated.map(Date.parse))).toBeGreaterThan(Date.parse('2026-09-10'));
    });
  });

  /**
   * The one way this can go wrong, and the reason every insert is guarded on
   * its parent as well as on itself. The guest account is shared and was live
   * before this change existed, so a visitor may have made a Workspace of their
   * own called `Personal` - and `workspaces` is unique on the live folded name.
   * An unguarded seed would fail that insert, take the whole change down with
   * it, and leave guest sign-in broken for everybody rather than for that one
   * name.
   *
   * Arranged by applying every change but this one by hand, which is the only
   * way to be in the state this is about: an account already opened, already
   * used, and not yet seeded.
   */
  describe('a workspace name a guest has already taken costs that workspace and nothing else', () => {
    it('still opens the account, and still lands everything the taken name does not hold', async () => {
      const changes = accountChanges(GUEST_ACCOUNT_NAME);
      // Named rather than counted, so a change appended after this one does
      // not quietly turn the arrangement into "already seeded".
      const seedAt = changes.findIndex((one) => one.name === '0026-guest-demo-seed');
      expect(seedAt, 'the seed is not in the change list').toBeGreaterThan(-1);
      await inStoreAsItIs(GUEST_ACCOUNT_NAME, (sql) => {
        sql.exec(
          `CREATE TABLE IF NOT EXISTS account_changes (
             name text PRIMARY KEY NOT NULL,
             applied_at text NOT NULL
           ) STRICT`,
        );
        for (const change of changes.slice(0, seedAt)) {
          for (const statement of change.statements) sql.exec(statement.sql, ...(statement.params ?? []));
          sql.exec(
            'INSERT INTO account_changes (name, applied_at) VALUES (?, ?)',
            change.name,
            '2026-09-09T00:00:00.000Z',
          );
        }
        // What the guest before this one made for themselves.
        sql.exec(
          `INSERT INTO workspaces (id, tenant_id, name, folded_name, color, position, created_at)
           VALUES ('ws-theirs', ?, 'Personal', 'personal', '#3a72c8', 1, '2026-09-09T00:00:00.000Z')`,
          GUEST_ACCOUNT_NAME,
        );
      });

      const cookie = await continueAsGuest();
      const workspaces = await workspacesOf(cookie);

      // Theirs, kept, and not a second one beside it.
      expect(workspaces.filter((one) => one.name === 'Personal').map((one) => one.id)).toEqual([
        'ws-theirs',
      ]);
      // Everything that does not hang off the taken name is still there.
      expect(workspaces.map((one) => one.name)).toEqual(
        expect.arrayContaining(['Halcyon Health', 'Oakline Retail']),
      );
      const halcyon = await snapshotOf(cookie, named(workspaces, 'Halcyon Health').id);
      expect(halcyon.dashboards).toHaveLength(3);
      expect(halcyon.items.length).toBeGreaterThan(10);
      // And the workspace that was skipped took its whole subtree with it
      // rather than leaving dashboards nothing owns.
      const theirs = await snapshotOf(cookie, 'ws-theirs');
      expect(theirs.dashboards).toEqual([]);
      expect(theirs.items).toEqual([]);
    });
  });
});
