import { beforeEach, describe, expect, inject, it } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { TENANT_ID, WORKSPACE_ID, seedWorkspaces } from '../seed.js';

/**
 * Integration level, and deliberately not through `SELF.fetch`. The rules
 * below are the database's own refusals, and nothing invalid can be driven at
 * them through the HTTP layer: the command handlers shape-validate with Zod
 * and check that what a command names actually exists. The whole point of
 * these constraints is to be the lock behind that one. The database is this
 * service's real infrastructure and this is what entering it directly looks
 * like.
 *
 * Where a handler's own refusal is the observable behaviour - an unknown
 * workspace is a 404, not a foreign-key error - that belongs at the HTTP tier
 * and lives in tests/integration/http/item-changes.test.ts. These cases are
 * only about what the database does when something gets past the handlers.
 */

const AT = '2026-08-12T10:00:00.000Z';

const AN_ITEM: Record<string, unknown> = {
  id: 'placeholder',
  tenant_id: TENANT_ID,
  workspace_id: WORKSPACE_ID,
  source: 'internal',
  title: 'Make appointment with Novy',
  status: 'to_process',
  unseen: 0,
  created_at: AT,
  updated_at: AT,
};

let seq = 0;
function nextId(): string {
  seq += 1;
  return `018f0000-0000-7000-8000-${String(seq).padStart(12, '0')}`;
}

/** Writes an item, valid except for whatever the case overrides. */
async function fileItem(overrides: Record<string, unknown> = {}): Promise<void> {
  const row = { ...AN_ITEM, ...overrides, id: overrides.id ?? nextId() };
  const columns = Object.keys(row);
  await env.DB.prepare(
    `INSERT INTO items (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
  )
    .bind(...Object.values(row))
    .run();
}

async function linkItem(overrides: Record<string, unknown> = {}): Promise<void> {
  const row = {
    id: nextId(),
    tenant_id: TENANT_ID,
    item_id: 'placeholder',
    kind: 'person',
    label: 'Anna',
    created_at: AT,
    ...overrides,
  };
  const columns = Object.keys(row);
  await env.DB.prepare(
    `INSERT INTO associations (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
  )
    .bind(...Object.values(row))
    .run();
}

beforeEach(async () => {
  await applyD1Migrations(env.DB, inject('migrations'));
  await seedWorkspaces();
});

describe('Capture', () => {
  describe('a captured thought is always filed in a workspace that exists', () => {
    it('is stored when the workspace is one the person has', async () => {
      await expect(fileItem()).resolves.toBeUndefined();
    });

    it.each([
      { situation: 'a workspace that was never created', override: { workspace_id: 'ws-nope' } },
      { situation: 'a person who was never created', override: { tenant_id: 'nobody' } },
    ])('is refused against $situation', async ({ override }) => {
      await expect(fileItem(override)).rejects.toThrow();
    });
  });

  describe('what the product stores is what comes back', () => {
    it('refuses a value it would have to reshape to store', async () => {
      // No CHECK covers `title`, so STRICT is the only thing that can refuse
      // this - which is what makes it the case that fails if STRICT is lost.
      await expect(
        env.DB.prepare(
          `INSERT INTO items (id, tenant_id, workspace_id, source, title, status, unseen, created_at, updated_at)
           VALUES (?, ?, ?, 'internal', x'deadbeef', 'to_process', 0, ?, ?)`,
        )
          .bind(nextId(), TENANT_ID, WORKSPACE_ID, AT, AT)
          .run(),
      ).rejects.toThrow();
    });

    it('holds every table to it, so a rebuilt schema cannot quietly drop it', async () => {
      // drizzle-kit cannot emit STRICT, so each migration adds it by hand and
      // a regenerated one silently would not. This is that guard.
      const { results } = await env.DB.prepare(
        `SELECT name, strict FROM pragma_table_list
          WHERE schema = 'main'
            AND name IN ('tenants', 'workspaces', 'items', 'associations', 'commands')
          ORDER BY name`,
      ).all<{ name: string; strict: number }>();

      expect(results.map((t) => t.name)).toEqual([
        'associations',
        'commands',
        'items',
        'tenants',
        'workspaces',
      ]);
      expect(results.filter((t) => t.strict !== 1)).toEqual([]);
    });

    it('points every link at a real table, not a leftover of the rebuild', async () => {
      // The constraints migration builds the tables under `__new_` names and
      // renames them last, relying on SQLite rewriting foreign keys to follow
      // a renamed table. If that ever stopped happening, the schema would
      // still load and every reference would point at a table that is gone.
      const { results } = await env.DB.prepare(
        `SELECT "table" AS target FROM pragma_foreign_key_list('items')
         UNION SELECT "table" FROM pragma_foreign_key_list('associations')
         UNION SELECT "table" FROM pragma_foreign_key_list('workspaces')
         ORDER BY target`,
      ).all<{ target: string }>();

      expect(results.map((r) => r.target)).toEqual(['items', 'tenants', 'workspaces']);
    });
  });
});

describe('Triage', () => {
  describe('an item only ever holds values the product defines', () => {
    it.each([
      { situation: 'a status that is not one of the triage outcomes', override: { status: 'banana' } },
      { situation: 'a priority that is not low, normal or high', override: { priority: 'urgent' } },
      { situation: 'a focus horizon that is not one of the horizons', override: { focus_horizon: 'someday' } },
      { situation: 'a source no connector produces', override: { source: 'carrier-pigeon' } },
      { situation: 'a seen-or-unseen flag that is neither', override: { unseen: 7 } },
      { situation: 'a due date that is not a calendar date', override: { due_date: '31-08-2026' } },
      { situation: 'a due date no calendar has', override: { due_date: '2026-02-31' } },
      { situation: 'a captured time that is not a moment', override: { created_at: 'yesterday' } },
    ])('refuses $situation', async ({ override }) => {
      await expect(fileItem(override)).rejects.toThrow();
    });

    it('still accepts the dates and times it is given nothing for', async () => {
      await expect(
        fileItem({ due_date: null, snoozed_until: null, deleted_at: null }),
      ).resolves.toBeUndefined();
    });
  });
});

describe('Associations', () => {
  describe('a link always points at an item that exists', () => {
    it('is stored when the item was captured', async () => {
      const itemId = nextId();
      await fileItem({ id: itemId });
      await expect(linkItem({ item_id: itemId })).resolves.toBeUndefined();
    });

    it('is refused when the item was never captured', async () => {
      await expect(linkItem({ item_id: nextId() })).rejects.toThrow();
    });

    it('is refused when the link is not to a person, project or topic', async () => {
      const itemId = nextId();
      await fileItem({ id: itemId });
      await expect(linkItem({ item_id: itemId, kind: 'sandwich' })).rejects.toThrow();
    });
  });
});
