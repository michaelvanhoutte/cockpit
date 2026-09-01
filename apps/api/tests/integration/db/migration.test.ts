import { beforeAll, describe, expect, inject, it } from 'vitest';
import { env, applyD1Migrations, SELF } from 'cloudflare:test';
import { foldName } from '../../../src/domain/workspaces.js';

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

/**
 * Asks for a workspace the way a person does, through the real Worker, because
 * whether the migration folded the rows it found is only visible in what the
 * next create is allowed to do.
 */
let seq = 0;
async function makeWorkspace(name: string): Promise<Response> {
  seq += 1;
  const id = `018f0000-0000-7000-8000-${String(seq).padStart(12, '0')}`;
  return SELF.fetch('http://cockpit.test/v1/commands/create_workspace', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ commandId: id, issuedAt: AT, workspaceId: id, name }),
  });
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
    // Three workspaces, because the colour backfill has three answers: the
    // tint that is a theme's, the tint that is nobody's, and - in `ws-work` -
    // the one the defaults already happen to match.
    env.DB.prepare(
      `INSERT INTO workspaces (id, tenant_id, name, slug, color, created_at) VALUES
         ('ws-work', ?, 'Work', 'work', '#6f62b5', ?),
         ('ws-atlas', ?, 'Atlas Copco', 'atlas', '#3a72c8', ?),
         ('ws-oddity', ?, 'Oddity', 'oddity', '#123456', ?)`,
    ).bind(TENANT_ID, AT, TENANT_ID, AT, TENANT_ID, AT),
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
      expect(await countOf('workspaces')).toBe(3);
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

describe('Workspace management', () => {
  describe('a workspace that was there before an update keeps its name and holds on to it', () => {
    it('is still called what it was called, and still looks the same', async () => {
      // The colour as well as the name, because an update that drops a column
      // carries every other one across, and getting one of them wrong is
      // exactly how that goes wrong quietly.
      expect(
        await env.DB.prepare('SELECT name, color FROM workspaces WHERE id = ?')
          .bind('ws-work')
          .first<{ name: string; color: string }>(),
      ).toMatchObject({ name: 'Work', color: '#6f62b5' });
    });

    it('still holds the thoughts that were filed in it', async () => {
      expect(
        await env.DB.prepare(
          `SELECT items.id FROM items
             JOIN workspaces ON workspaces.id = items.workspace_id
            WHERE items.id = ?`,
        )
          .bind('kept')
          .first<{ id: string }>(),
      ).toMatchObject({ id: 'kept' });
    });

    it('will not let a second workspace take its name, even written straight to the database', async () => {
      // Straight to the database on purpose, and this is the only way to ask
      // the question. The handler folds the *names* it reads, so it would
      // refuse a second Work whether or not the update ever touched this row;
      // going around it is what asks whether the row itself was folded, which
      // is the half of the update nothing else can see.
      await expect(
        env.DB.prepare(
          'INSERT INTO workspaces (id, tenant_id, name, folded_name, color, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        )
          .bind('ws-work-again', TENANT_ID, 'work', foldName('work'), '#3f8f78', AT)
          .run(),
      ).rejects.toThrow();
    });

    it.each([
      {
        situation: 'a workspace whose colour is one of the palette’s',
        id: 'ws-atlas',
        wearing: { color: '#3a72c8', ground: '#d8e5f7', header: '#bed6f2' },
      },
      {
        // Plausible in a database that has been running a while, impossible in
        // the seed. It keeps its own tint - the one thing about it a person
        // already recognises in the tabs - and takes the default page, which
        // leaves it looking slightly wrong rather than not looking at all.
        situation: 'a workspace whose colour is nobody’s',
        id: 'ws-oddity',
        wearing: { color: '#123456', ground: '#e3e1f2', header: '#d2cdea' },
      },
    ])('ends up wearing a whole theme: $situation', async ({ id, wearing }) => {
      expect(
        await env.DB.prepare('SELECT color, ground, header FROM workspaces WHERE id = ?')
          .bind(id)
          .first(),
      ).toEqual(wearing);
    });

    it('still lets a new workspace be made beside it', async () => {
      // Against a database the update ran over rows it found, rather than the
      // empty one every other test starts from.
      expect((await makeWorkspace('Bookkeeping')).status).toBe(200);
    });
  });
});
