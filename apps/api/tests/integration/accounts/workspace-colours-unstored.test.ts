import { beforeEach, describe, expect, inject, it } from 'vitest';
import { applyD1Migrations, env } from 'cloudflare:test';
import { WORKSPACE_THEMES } from '@cockpit/shared';
import type { Workspace } from '@cockpit/shared';
import { accountChanges } from '../../../src/accounts/changes.js';
import { GUEST_ACCOUNT_NAME } from '../../../src/accounts/new-user.js';
import { asUser, inStoreAsItIs, seedRegister, startFromEmpty, storeNamed } from '../seed.js';

/**
 * Integration level, because only a real schema shows that nothing the server
 * reads or writes names the `bar`, `ground` and `header` columns: an account
 * brought up to date no longer has them (`0090-drop-workspace-colours`), and
 * every Workspace path is driven against what is left.
 *
 * Its own file because, like workspace-reads.test.ts, it asks about the shape
 * of a deploy rather than a feature.
 */

const AT = '2026-10-18T10:00:00.000Z';

let seq = 0;
function nextId(): string {
  seq += 1;
  return `018f0000-0000-7000-8000-${String(seq).padStart(12, '0')}`;
}

async function send(command: string, body: Record<string, unknown>): Promise<Response> {
  return asUser(`http://cockpit.test/v1/commands/${command}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ commandId: nextId(), issuedAt: AT, ...body }),
  });
}

async function theWorkspaces(): Promise<Workspace[]> {
  const res = await asUser('http://cockpit.test/v1/workspaces');
  expect(res.status).toBe(200);
  return ((await res.json()) as { workspaces: Workspace[] }).workspaces;
}

function wearing(tint: string) {
  const theme = WORKSPACE_THEMES.find((one) => one.tint === tint)!;
  return { color: theme.tint, bar: theme.bar, ground: theme.ground, header: theme.header };
}

beforeEach(async () => {
  await applyD1Migrations(env.DB, inject('migrations'));
  await startFromEmpty();
  await seedRegister();
});

describe('Workspace management', () => {
  describe('with the band, top bar and page grey no longer stored, every Workspace path still works', () => {
    it('creates a Workspace and reads it back in its theme', async () => {
      const id = nextId();

      const res = await send('create_workspace', { workspaceId: id, panelId: nextId(), name: 'Unstored' });

      expect(res.status, await res.clone().text()).toBe(200);
      const made = (await theWorkspaces()).find((one) => one.id === id)!;
      expect(made).toMatchObject({ name: 'Unstored', ...wearing(made.color) });
      expect(WORKSPACE_THEMES.map((one) => one.tint)).toContain(made.color);
    });

    it('stores a theme pick and reads it back in its theme', async () => {
      const [first] = await theWorkspaces();
      const chosen = WORKSPACE_THEMES[4]!;

      const res = await send('set_workspace_theme', {
        workspaceId: first!.id,
        color: chosen.tint,
        bar: chosen.bar,
        ground: chosen.ground,
        header: chosen.header,
      });

      expect(res.status, await res.clone().text()).toBe(200);
      expect((await theWorkspaces()).find((one) => one.id === first!.id)).toMatchObject(wearing(chosen.tint));
    });

    it('lists every Workspace with all four colours', async () => {
      await send('create_workspace', { workspaceId: nextId(), panelId: nextId(), name: 'Another' });

      const listed = await theWorkspaces();

      expect(listed.length).toBeGreaterThan(1);
      for (const workspace of listed) {
        expect(workspace, workspace.name).toMatchObject(wearing(workspace.color));
      }
    });
  });

  describe('the guest demonstration’s nightly reset seeds its Workspaces without the three columns', () => {
    it('lands every Workspace of the demonstration', async () => {
      // A store as the reset leaves it just before the demonstration is seeded:
      // everything earlier applied and recorded, the drop of the three among it.
      const before = accountChanges(GUEST_ACCOUNT_NAME).findIndex(
        (change) => change.name === '0026-guest-demo-seed',
      );
      expect(before).toBeGreaterThan(0);
      await inStoreAsItIs(GUEST_ACCOUNT_NAME, (sql) => {
        sql.exec(
          `CREATE TABLE IF NOT EXISTS account_changes (
             name text PRIMARY KEY NOT NULL,
             applied_at text NOT NULL
           ) STRICT`,
        );
        for (const change of accountChanges(GUEST_ACCOUNT_NAME).slice(0, before)) {
          for (const statement of change.statements) {
            sql.exec(statement.sql, ...(statement.params ?? []));
          }
          sql.exec('INSERT INTO account_changes (name, applied_at) VALUES (?, ?)', change.name, AT);
        }
      });

      // Opening the store runs the seed, as the first request after a reset does.
      const opened = await storeNamed(GUEST_ACCOUNT_NAME).workspaces(GUEST_ACCOUNT_NAME);

      expect(opened).toMatchObject({ status: 'ok' });
      const seeded = await inStoreAsItIs(GUEST_ACCOUNT_NAME, (sql) =>
        sql.exec<{ name: string; color: string }>('SELECT name, color FROM workspaces').toArray(),
      );
      // The starter every account has, and the demonstration's own beside it.
      expect(seeded.length).toBeGreaterThan(1);
      for (const workspace of seeded) {
        expect(WORKSPACE_THEMES.map((one) => one.tint), workspace.name).toContain(workspace.color);
      }
    });
  });
});
