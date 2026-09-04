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
                AND name IN ('workspaces', 'dashboards', 'panels', 'layouts',
                             'panel_placements', 'panel_items', 'items',
                             'item_types', 'associations', 'commands')
              ORDER BY name`,
          )
          .toArray(),
      );

      expect(tables.map((t) => t.name)).toEqual([
        'associations',
        'commands',
        'dashboards',
        'item_types',
        'items',
        'layouts',
        'panel_items',
        'panel_placements',
        'panels',
        'workspaces',
      ]);
      expect(tables.filter((t) => t.strict !== 1)).toEqual([]);
    });

    it('points every link at a real table', async () => {
      // SQLite accepts a FOREIGN KEY naming a table that does not exist and
      // only complains on the first write, so a typo in the hand-written DDL
      // would otherwise sit there until somebody captured something.
      // One query per table, gathered here rather than UNIONed in SQL: SQLite
      // caps a compound SELECT at a handful of terms and answers "too many
      // terms in compound SELECT" once there are more tables than that - which
      // there now are.
      const targets = await inTheStore((sql) => {
        const found = new Set<string>();
        for (const table of [
          'items',
          'associations',
          'dashboards',
          'panels',
          'layouts',
          'panel_placements',
          'panel_items',
        ]) {
          for (const row of sql
            .exec<{ target: string }>(`SELECT "table" AS target FROM pragma_foreign_key_list(?)`, table)
            .toArray()) {
            found.add(row.target);
          }
        }
        return [...found].sort();
      });

      expect(targets).toEqual([
        'dashboards',
        'item_types',
        'items',
        'layouts',
        'panels',
        'workspaces',
      ]);
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

describe('Workspace management', () => {
  describe('two workspaces never go by the same name', () => {
    async function makeWorkspaceRow(id: string, name: string): Promise<void> {
      await inTheStore((sql) => {
        sql.exec(
          'INSERT INTO workspaces (id, tenant_id, name, folded_name, color, created_at) VALUES (?, ?, ?, ?, ?, ?)',
          id,
          ACCOUNT_NAME,
          name,
          name.toLowerCase(),
          '#3f8f78',
          AT,
        );
      });
    }

    it.each([
      { situation: 'the same name', name: 'Work' },
      { situation: 'the same name in another case', name: 'work' },
    ])('is refused $situation', async ({ name }) => {
      // The workspace an account starts with is called Work. The handlers ask
      // first and answer with a message, so nothing invalid reaches here
      // through the interface - which is exactly why this rule is checked
      // against the store itself ("The database is the second lock"). It is
      // what still holds when two creates race past that check, and it has to
      // *refuse* rather than quietly drop the row, or the second one reports
      // success having written nothing.
      await expect(makeWorkspaceRow(nextId(), name)).rejects.toThrow();
    });

    it('is allowed once the workspace holding the name is gone', async () => {
      await inTheStore((sql) => {
        sql.exec('UPDATE workspaces SET deleted_at = ? WHERE id = ?', AT, WORKSPACE_ID);
      });

      await expect(makeWorkspaceRow(nextId(), 'Work')).resolves.toBeUndefined();
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

describe('Panels', () => {
  /** The dashboard every workspace is created with, which is what panels hang off. */
  const DASHBOARD_ID = `${WORKSPACE_ID}-dashboard-1`;

  async function putPanel(overrides: Record<string, unknown> = {}): Promise<void> {
    const row = {
      id: nextId(),
      tenant_id: ACCOUNT_NAME,
      dashboard_id: DASHBOARD_ID,
      name: 'Project Falcon',
      folded_name: 'project falcon',
      created_at: AT,
      ...overrides,
    };
    const columns = Object.keys(row);
    await inTheStore((sql) => {
      sql.exec(
        `INSERT INTO panels (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
        ...Object.values(row),
      );
    });
  }

  async function putLayout(overrides: Record<string, unknown> = {}): Promise<void> {
    const row = {
      id: nextId(),
      tenant_id: ACCOUNT_NAME,
      dashboard_id: DASHBOARD_ID,
      screen_width: 1280,
      created_at: AT,
      ...overrides,
    };
    const columns = Object.keys(row);
    await inTheStore((sql) => {
      sql.exec(
        `INSERT INTO layouts (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
        ...Object.values(row),
      );
    });
  }

  async function putFiling(overrides: Record<string, unknown> = {}): Promise<void> {
    const row = {
      tenant_id: ACCOUNT_NAME,
      panel_id: 'placeholder',
      item_id: 'placeholder',
      position: 0,
      created_at: AT,
      ...overrides,
    };
    const columns = Object.keys(row);
    await inTheStore((sql) => {
      sql.exec(
        `INSERT INTO panel_items (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
        ...Object.values(row),
      );
    });
  }

  async function putPlacement(overrides: Record<string, unknown> = {}): Promise<void> {
    const row = {
      tenant_id: ACCOUNT_NAME,
      layout_id: 'placeholder',
      panel_id: 'placeholder',
      position: 0,
      column_span: 4,
      row_span: 3,
      ...overrides,
    };
    const columns = Object.keys(row);
    await inTheStore((sql) => {
      sql.exec(
        `INSERT INTO panel_placements (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
        ...Object.values(row),
      );
    });
  }

  describe('two panels of one dashboard never go by the same name', () => {
    it.each([
      { situation: 'the same name', folded: 'project falcon' },
      { situation: 'the same name in another case', folded: 'project falcon' },
    ])('is refused $situation', async ({ folded }) => {
      // The handlers ask first and answer with a message, so nothing invalid
      // reaches here through the interface - which is exactly why this is
      // checked against the store itself ("The database is the second lock").
      // It has to *refuse* rather than quietly drop the row, or two adds racing
      // past the check would both report success having written one panel.
      await putPanel();
      await expect(putPanel({ folded_name: folded })).rejects.toThrow();
    });

    it('is allowed on another dashboard, which is what makes the scope the dashboard', async () => {
      const elsewhere = nextId();
      await inTheStore((sql) => {
        sql.exec(
          `INSERT INTO dashboards (id, tenant_id, workspace_id, name, folded_name, created_at)
           VALUES (?, ?, ?, 'Research', 'research', ?)`,
          elsewhere,
          ACCOUNT_NAME,
          WORKSPACE_ID,
          AT,
        );
      });
      await putPanel();

      await expect(putPanel({ dashboard_id: elsewhere })).resolves.toBeUndefined();
    });

    it('is allowed once the panel holding the name is gone', async () => {
      const doomed = nextId();
      await putPanel({ id: doomed });
      await inTheStore((sql) => {
        sql.exec('UPDATE panels SET deleted_at = ? WHERE id = ?', AT, doomed);
      });

      await expect(putPanel()).resolves.toBeUndefined();
    });
  });

  describe('a panel always sits on a dashboard that exists', () => {
    it('is refused against a dashboard that was never created', async () => {
      await expect(putPanel({ dashboard_id: 'db-nope' })).rejects.toThrow();
    });
  });

  describe('an arrangement only ever holds a place the grid can draw', () => {
    it.each([
      { situation: 'a panel wider than the grid', override: { column_span: 13 } },
      { situation: 'a panel of no width at all', override: { column_span: 0 } },
      { situation: 'a panel taller than anything could show', override: { row_span: 9 } },
      { situation: 'a panel of no height at all', override: { row_span: 0 } },
      { situation: 'a place before the first one', override: { position: -1 } },
      { situation: 'a screen of no width', override: { screenWidth: 0 } },
      { situation: 'a screen wider than any screen', override: { screenWidth: 100_001 } },
    ])('refuses $situation', async ({ override }) => {
      const { screenWidth, ...placement } = override as Record<string, number>;
      const layoutId = nextId();
      const panelId = nextId();
      if (screenWidth !== undefined) {
        await expect(putLayout({ id: layoutId, screen_width: screenWidth })).rejects.toThrow();
        return;
      }
      await putLayout({ id: layoutId });
      await putPanel({ id: panelId });

      await expect(
        putPlacement({ layout_id: layoutId, panel_id: panelId, ...placement }),
      ).rejects.toThrow();
    });

    it('is stored when the panel and the layout are both real', async () => {
      const layoutId = nextId();
      const panelId = nextId();
      await putLayout({ id: layoutId });
      await putPanel({ id: panelId });

      await expect(
        putPlacement({ layout_id: layoutId, panel_id: panelId }),
      ).resolves.toBeUndefined();
    });

    it.each([
      { situation: 'the layout was never made', which: 'layout' },
      { situation: 'the panel was never added', which: 'panel' },
    ])('is refused when $situation', async ({ which }) => {
      const layoutId = nextId();
      const panelId = nextId();
      if (which !== 'layout') await putLayout({ id: layoutId });
      if (which !== 'panel') await putPanel({ id: panelId });

      await expect(putPlacement({ layout_id: layoutId, panel_id: panelId })).rejects.toThrow();
    });

    it('refuses to put one panel in two places in the same layout', async () => {
      const layoutId = nextId();
      const panelId = nextId();
      await putLayout({ id: layoutId });
      await putPanel({ id: panelId });
      await putPlacement({ layout_id: layoutId, panel_id: panelId });

      await expect(
        putPlacement({ layout_id: layoutId, panel_id: panelId, position: 1 }),
      ).rejects.toThrow();
    });
  });

  describe('a filing only ever names a real panel and a real item, in a real place', () => {
    it.each([
      { situation: 'a place before the first one', override: { position: -1 } },
      { situation: 'a filing time that is not a moment', override: { created_at: 'yesterday' } },
    ])('refuses $situation', async ({ override }) => {
      const panelId = nextId();
      const itemId = nextId();
      await putPanel({ id: panelId });
      await fileItem({ id: itemId });

      await expect(
        putFiling({ panel_id: panelId, item_id: itemId, ...override }),
      ).rejects.toThrow();
    });

    it.each([
      { situation: 'the panel was never added', which: 'panel' },
      { situation: 'the item was never captured', which: 'item' },
    ])('is refused when $situation', async ({ which }) => {
      const panelId = nextId();
      const itemId = nextId();
      if (which !== 'panel') await putPanel({ id: panelId });
      if (which !== 'item') await fileItem({ id: itemId });

      await expect(putFiling({ panel_id: panelId, item_id: itemId })).rejects.toThrow();
    });

    it('refuses to file one item onto the same panel twice', async () => {
      const panelId = nextId();
      const itemId = nextId();
      await putPanel({ id: panelId });
      await fileItem({ id: itemId });
      await putFiling({ panel_id: panelId, item_id: itemId });

      await expect(putFiling({ panel_id: panelId, item_id: itemId, position: 1 })).rejects.toThrow();
    });

    it('files one item onto as many panels as there are, which is what the table is for', async () => {
      // The shape the whole change rests on: nothing constrains `item_id`, so
      // an item has a row per panel it is filed on. A unique index on it — the
      // table the one command that ships would have needed — would fail here.
      const first = nextId();
      const second = nextId();
      const itemId = nextId();
      await putPanel({ id: first });
      await putPanel({ id: second, name: 'Anna', folded_name: 'anna' });
      await fileItem({ id: itemId });

      await putFiling({ panel_id: first, item_id: itemId });

      await expect(putFiling({ panel_id: second, item_id: itemId })).resolves.toBeUndefined();
    });
  });
});
