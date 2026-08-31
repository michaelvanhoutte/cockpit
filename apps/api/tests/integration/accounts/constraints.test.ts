import { beforeEach, describe, expect, inject, it } from 'vitest';
import { applyD1Migrations, env } from 'cloudflare:test';
import { ACCOUNT_NAME, WORKSPACE_ID, inTheStore, seedRegister, startFromEmpty } from '../seed.js';

/**
 * Integration level, and deliberately not through `SELF.fetch`. The rules below
 * are the store's own refusals, and nothing invalid can be driven at them
 * through the HTTP layer: the command handlers shape-validate with Zod and
 * check that what a change names actually exists. The whole point of these
 * constraints is to be the lock behind that one. An account's store is this
 * service's real infrastructure and this is what entering it directly looks
 * like.
 *
 * Where a handler's own refusal is the observable behaviour - an unknown
 * workspace is a 404, not a foreign-key error - that belongs at the HTTP tier
 * and lives in tests/integration/http/item-changes.test.ts. These cases are
 * only about what the store does when something gets past the handlers.
 *
 * They also stand in for a check the tooling cannot do. The statements that
 * create these tables are written out by hand in src/accounts/changes.ts, and
 * src/db/schema.ts's counterpart is only what queries are written against, so
 * nothing but this file would notice the two drifting apart.
 */

const AT = '2026-08-12T10:00:00.000Z';

const AN_ITEM: Record<string, unknown> = {
  id: 'placeholder',
  tenant_id: ACCOUNT_NAME,
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
  await inTheStore((sql) => {
    sql.exec(
      `INSERT INTO items (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
      ...Object.values(row),
    );
  });
}

async function linkItem(overrides: Record<string, unknown> = {}): Promise<void> {
  const row = {
    id: nextId(),
    tenant_id: ACCOUNT_NAME,
    item_id: 'placeholder',
    kind: 'person',
    label: 'Anna',
    created_at: AT,
    ...overrides,
  };
  const columns = Object.keys(row);
  await inTheStore((sql) => {
    sql.exec(
      `INSERT INTO associations (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
      ...Object.values(row),
    );
  });
}

beforeEach(async () => {
  await applyD1Migrations(env.DB, inject('migrations'));
  await startFromEmpty();
  await seedRegister();
  seq = 0;
});

describe('Capture', () => {
  describe('a captured thought is always filed in a workspace that exists', () => {
    it('is stored when the workspace is one the person has', async () => {
      await expect(fileItem()).resolves.toBeUndefined();
    });

    it('is refused against a workspace that was never created', async () => {
      await expect(fileItem({ workspace_id: 'ws-nope' })).rejects.toThrow();
    });
  });

  describe('what the product stores is what comes back', () => {
    it('refuses a value it would have to reshape to store', async () => {
      // No CHECK covers `title`, so STRICT is the only thing that can refuse
      // this - which is what makes it the case that fails if STRICT is lost.
      await expect(
        inTheStore((sql) => {
          sql.exec(
            `INSERT INTO items (id, tenant_id, workspace_id, source, title, status, unseen, created_at, updated_at)
             VALUES (?, ?, ?, 'internal', x'deadbeef', 'to_process', 0, ?, ?)`,
            nextId(),
            ACCOUNT_NAME,
            WORKSPACE_ID,
            AT,
            AT,
          );
        }),
      ).rejects.toThrow();
    });

    it('holds every table to it, so a rewritten schema cannot quietly drop it', async () => {
      // STRICT is a keyword no tool emits for us, so every statement in
      // changes.ts carries it by hand and a rewritten one silently would not.
      // This is that guard.
      const tables = await inTheStore((sql) =>
        sql
          .exec<{ name: string; strict: number }>(
            `SELECT name, strict FROM pragma_table_list
              WHERE schema = 'main'
                AND name IN ('workspaces', 'items', 'associations', 'commands')
              ORDER BY name`,
          )
          .toArray(),
      );

      expect(tables.map((t) => t.name)).toEqual([
        'associations',
        'commands',
        'items',
        'workspaces',
      ]);
      expect(tables.filter((t) => t.strict !== 1)).toEqual([]);
    });

    it('points every link at a real table', async () => {
      // SQLite accepts a FOREIGN KEY naming a table that does not exist and
      // only complains on the first write, so a typo in the hand-written DDL
      // would otherwise sit there until somebody captured something.
      const targets = await inTheStore((sql) =>
        sql
          .exec<{ target: string }>(
            `SELECT "table" AS target FROM pragma_foreign_key_list('items')
             UNION SELECT "table" FROM pragma_foreign_key_list('associations')
             ORDER BY target`,
          )
          .toArray()
          .map((r) => r.target),
      );

      expect(targets).toEqual(['items', 'workspaces']);
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
      // The wire contract is UTC-only (z.iso.datetime()). Both of these were
      // once let through: the day check converts an offset to UTC before
      // comparing, so it only caught the offsets that happened to land on
      // another day, and a string with no zone at all passed on length alone.
      { situation: 'a time told in somebody else’s clock', override: { source_timestamp: '2026-08-12T13:00:00.000+02:00' } },
      { situation: 'a time that never says which clock', override: { source_timestamp: '2026-08-12T01:00:00.000' } },
    ])('refuses $situation', async ({ override }) => {
      await expect(fileItem(override)).rejects.toThrow();
    });

    it('still accepts a moment on the far side of the day from UTC', async () => {
      // Late-evening UTC is the case a day-boundary bug shows up on first.
      await expect(
        fileItem({ source_timestamp: '2026-08-31T23:30:00.000Z' }),
      ).resolves.toBeUndefined();
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
