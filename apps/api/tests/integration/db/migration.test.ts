import { beforeAll, describe, expect, inject, it } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';

/**
 * Integration level: a migration only exists against a real database, and what
 * this pins is what happens to rows that were already there. The other tests
 * in this folder start from an empty database with every migration applied, so
 * none of them ever exercises the copy at all.
 *
 * The constraints migration adds foreign keys to tables that never had them,
 * so it has to rebuild every table. An earlier version dropped them and let
 * the seed put things back - which is wrong, because staging is deliberately
 * never re-seeded and production is seeded once by hand.
 */

const AT = '2026-08-12T10:00:00.000Z';
const TENANT_ID = 'tenant-default';

/** Everything up to, but not including, the constraints migration. */
function before() {
  return inject('migrations').filter((m) => m.name.startsWith('0000'));
}
function andTheRest() {
  return inject('migrations').filter((m) => !m.name.startsWith('0000'));
}

async function countOf(table: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT count(*) AS n FROM ${table}`).first<{ n: number }>();
  return row?.n ?? 0;
}

// `beforeAll`, not `beforeEach`: applying the migration is the single event
// every case below asks a question about, and it can only happen once - a
// second run would be arranging against the schema it just produced.
beforeAll(async () => {
  await applyD1Migrations(env.DB, before());

  // The state a real database is in beforehand: a tenant, a workspace, an item
  // with a link and a logged change - plus two rows the old schema allowed and
  // the new foreign keys will not, because nothing stopped them being written.
  await env.DB.batch([
    env.DB.prepare('INSERT INTO tenants (id, name, created_at) VALUES (?, ?, ?)').bind(
      TENANT_ID,
      'Michael',
      AT,
    ),
    env.DB.prepare(
      'INSERT INTO workspaces (id, tenant_id, name, slug, color, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).bind('ws-work', TENANT_ID, 'Work', 'work', '#6f62b5', AT),
    env.DB.prepare(
      `INSERT INTO items (id, tenant_id, workspace_id, source, title, status, unseen, created_at, updated_at)
       VALUES ('kept', ?, 'ws-work', 'internal', 'Make appointment with Novy', 'task', 0, ?, ?),
              ('filed-nowhere', ?, 'ws-that-never-existed', 'internal', 'Orphan', 'task', 0, ?, ?)`,
    ).bind(TENANT_ID, AT, AT, TENANT_ID, AT, AT),
    env.DB.prepare(
      `INSERT INTO associations (id, tenant_id, item_id, kind, label, created_at)
       VALUES ('link-kept', ?, 'kept', 'person', 'Anna', ?),
              ('link-to-nothing', ?, 'never-captured', 'person', 'Ghost', ?)`,
    ).bind(TENANT_ID, AT, TENANT_ID, AT),
    env.DB.prepare(
      `INSERT INTO commands (command_id, tenant_id, workspace_id, name, payload, issued_at, received_at)
       VALUES ('change-1', ?, 'ws-work', 'capture_item', '{}', ?, ?)`,
    ).bind(TENANT_ID, AT, AT),
  ]);

  await applyD1Migrations(env.DB, andTheRest());
});

describe('Capture', () => {
  describe('a thought captured before an update is still there afterwards', () => {
    it('keeps the thought, what it was linked to, and what was done to it', async () => {
      expect(
        await env.DB.prepare('SELECT title FROM items WHERE id = ?').bind('kept').first<{
          title: string;
        }>(),
      ).toMatchObject({ title: 'Make appointment with Novy' });

      expect(await countOf('tenants')).toBe(1);
      expect(await countOf('workspaces')).toBe(1);
      expect(await countOf('commands')).toBe(1);
      expect(
        await env.DB.prepare('SELECT label FROM associations WHERE id = ?')
          .bind('link-kept')
          .first<{ label: string }>(),
      ).toMatchObject({ label: 'Anna' });
    });

    it.each([
      { situation: 'filed in a workspace that never existed', table: 'items', id: 'filed-nowhere' },
      { situation: 'linked to a thought never captured', table: 'associations', id: 'link-to-nothing' },
    ])('drops only what was already broken: $situation', async ({ table, id }) => {
      // Nowhere to put these: the new foreign keys are the statement that they
      // should never have existed, so carrying them over is not an option.
      expect(
        await env.DB.prepare(`SELECT id FROM ${table} WHERE id = ?`).bind(id).first(),
      ).toBeNull();
    });

    it('leaves no half-finished copy behind', async () => {
      const { results } = await env.DB.prepare(
        "SELECT name FROM sqlite_master WHERE name LIKE '__new_%' OR name LIKE '_migrate_%'",
      ).all<{ name: string }>();
      expect(results).toEqual([]);
    });
  });
});
