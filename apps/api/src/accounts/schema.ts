import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
import {
  associationKindSchema,
  GRID_COLUMNS,
  ITEM_TYPE_COLORS,
  MAX_PANEL_ROWS,
  prioritySchema,
  sourceSchema,
} from '@cockpit/shared';
import type { AssociationKind, Priority, Source } from '@cockpit/shared';

/**
 * The values the three dead columns on `items` are allowed to hold.
 *
 * They are here rather than in the wire contract because the product no longer
 * has a status, a snooze or a focus horizon ("An item is either yours to deal
 * with or finished with", issue 154) - so the rule that a CHECK is built from
 * the same enum the contract uses (architecture, "The database is the second
 * lock") has nothing left to hold these in step with. The columns stay because
 * SQLite refuses `DROP COLUMN` for a column named in a CHECK, and `items`
 * cannot be rebuilt while `panel_items` and `associations` point at it under
 * RESTRICT.
 */
const DEAD_STATUSES = [
  'to_process',
  'task',
  'waiting',
  'snoozed',
  'delegated',
  'reference',
  'done',
  'dismissed',
] as const;
const DEAD_FOCUS_HORIZONS = ['today', 'week', 'month', 'quarter'] as const;

/**
 * What every new item's dead `status` column is written with. It is NOT NULL
 * with a CHECK, so something has to satisfy both; nothing ever reads it.
 */
export const DEAD_STATUS_VALUE = 'to_process';

/**
 * The tables inside one account's store (architecture, "One store per account,
 * and `tenant_id` stays"): its workspaces, dashboards, panels, layouts, items,
 * associations and change log.
 * They live in the account's own Durable Object, never in D1, which holds only
 * the register of which accounts exist (src/db/schema.ts).
 *
 * These definitions are what queries are written against. What actually creates
 * the tables is `changes.ts`, statement for statement, because a Durable Object
 * brings itself up to date at runtime and there is no `wrangler d1 migrations
 * apply` to run against it. The two are kept in step by
 * apps/api/tests/integration/accounts/constraints.test.ts, which asserts the
 * conventions below against the schema an account actually ends up with.
 *
 * Schema conventions (architecture, "Schema conventions"), binding from the
 * first change:
 * - tenant_id on every row, non-null - redundant now that a store *is* an
 *   account, and exactly what makes a mis-routed request match no row instead
 *   of somebody else's;
 * - client-generated IDs (UUIDv7) as text primary keys;
 * - tombstones, not deletes (deleted_at / source_resolved_at);
 * - source-owned, app-owned and write-once columns are separate groups on
 *   items: re-syncs overwrite source-owned columns unconditionally, never
 *   app-owned, and never reach `captured_message`, which is written when the
 *   item is made and not again.
 * Timestamps are ISO-8601 text; dates are YYYY-MM-DD text.
 *
 * The database enforces those conventions rather than trusting its callers to,
 * per "The database is the second lock" in the architecture's schema
 * conventions:
 *
 * - **STRICT tables.** SQLite's default is dynamic typing with affinity: a
 *   TEXT column will happily store an integer. STRICT (SQLite 3.37+, which a
 *   Durable Object's SQLite runs) makes declared types enforced. Drizzle
 *   cannot express it, so every statement in `changes.ts` carries it by hand.
 * - **CHECK constraints for every closed set**, built from the same Zod enums
 *   the wire contract uses, so the two cannot drift.
 * - **Foreign keys**, ON DELETE RESTRICT throughout, so that removing anything
 *   has to decide what happens to what points at it rather than inheriting a
 *   silent cascade: deleting a workspace ("Rename and delete a workspace",
 *   issue 77) tombstones it and leaves its items where they are, and deleting a
 *   layout ("Panels on a dashboard, with per-screen-size layouts", issue 33)
 *   says out loud that its placements go first.
 *
 * `tenant_id` carries no foreign key here, and cannot: the register it would
 * point at is in D1, and SQLite has no way to reference a table in another
 * database. That is the trade the account storage decision records — the store
 * *is* the account, so `tenant_id` stops being a lookup and becomes the check
 * behind the routing: a request that reaches the wrong store matches no row
 * rather than returning somebody else's items.
 *
 * A CHECK passes when it evaluates to NULL, so the constraints below hold for
 * nullable columns without repeating `IS NULL OR` on every one.
 */

/** `col IN ('a','b')`, built from the Zod enum so the two cannot drift apart. */
function oneOf(column: string, values: readonly string[]) {
  return sql.raw(`${column} IN (${values.map((v) => `'${v}'`).join(', ')})`);
}

/**
 * An ISO-8601 instant: 2026-08-31T09:26:28.000Z, matching z.iso.datetime().
 *
 * `datetime()` rather than a GLOB of the shape: a GLOB spelling out fourteen
 * `[0-9]` classes exceeds SQLite's pattern-complexity limit and fails at
 * runtime with "LIKE or GLOB pattern too complex".
 *
 * `datetime()` alone is not enough, though, and it fails in a way worth
 * spelling out. It returns NULL for a month or an hour that could not exist,
 * but the day of month is only range-checked as 1..31 and then *normalised*:
 * `datetime('2026-02-31T10:00:00.000Z')` is `2026-03-03 10:00:00`, not NULL.
 * So the date part is round-tripped the same way isDate does it below - a
 * valid day is the only one that comes back unchanged.
 *
 * That round-trip is why the trailing `Z` is asserted rather than assumed.
 * `date()` converts an offset like `+02:00` to UTC before taking the date,
 * while `substr` takes the characters as written, so on an offset timestamp
 * the two disagree whenever the local time falls on the other side of the UTC
 * day boundary - rejecting a perfectly valid instant, and only sometimes.
 * Requiring `Z` (which is what z.iso.datetime() accepts) removes the
 * conversion entirely, and incidentally closes the other end: without it a
 * string carrying no zone at all passed on length alone.
 *
 * The `IS NULL` branch is load-bearing on nullable columns and written on
 * every one for uniformity: a CHECK passes when it evaluates to NULL, but
 * `datetime(NULL) IS NOT NULL` is FALSE rather than NULL, so without it the
 * constraint would reject the NULLs it is supposed to allow.
 */
function isTimestamp(column: string) {
  return sql.raw(
    `${column} IS NULL OR (datetime(${column}) IS NOT NULL` +
      ` AND substr(${column}, 11, 1) = 'T' AND substr(${column}, -1) = 'Z'` +
      ` AND length(${column}) >= 20` +
      ` AND date(${column}) = substr(${column}, 1, 10))`,
  );
}

/**
 * A calendar date: 2026-09-01, matching z.iso.date(). Round-tripping through
 * `date()` is what rejects an impossible day: SQLite normalises 2026-02-31 to
 * 2026-03-03, so a valid date is the only input that comes back unchanged.
 *
 * The `IS NOT NULL` is not redundant with the round-trip. `date()` returns
 * NULL for input it cannot parse at all, and `NULL = '31-08-2026'` is NULL,
 * which a CHECK treats as passing - so the round-trip alone catches a date
 * that was normalised but waves through one that is not a date at all.
 */
function isDate(column: string) {
  return sql.raw(
    `${column} IS NULL OR (date(${column}) IS NOT NULL AND date(${column}) = ${column})`,
  );
}

export const workspaces = sqliteTable(
  'workspaces',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    name: text('name').notNull(),
    /**
     * The name with its case folded away, written beside the name itself. The
     * unique index below is its only reader: the handler that asks whether a
     * name is taken folds the *names* it already has in hand instead, because a
     * row can hold a stale folded copy or none at all.
     *
     * It exists because SQLite's `lower()` folds `A`-`Z` and nothing else, so
     * `Réunions` and `réunions` were two different workspaces you could not
     * tell apart in the tabs ("Workspace names are only case-insensitive in
     * ASCII", issue 91). Folding happens in the application, where the whole of
     * Unicode is available; `foldName` in src/domain/names.ts is the one
     * function that does it, for this table, for dashboards and for panels
     * alike.
     *
     * `NOT NULL DEFAULT ''` matches the D1 copy, where the default was
     * load-bearing across the deploy that added it. A store creates the column
     * with the table, so nothing here ever wrote a row without it - the default
     * is kept so the two schemas do not differ in a way nobody meant.
     */
    foldedName: text('folded_name').notNull().default(''),
    /**
     * The workspace's four colors, chosen together from the palette in
     * `@cockpit/shared`'s domain/workspace-themes.ts: `color` is the saturated
     * tint on the tab dot and the selected tab, `header` is the bar across the
     * top, `bar` is the strip the dashboard tabs sit on one step lighter than
     * it, and `ground` is the page behind the panels.
     *
     * All four are stored rather than the name of a theme, so the palette is a
     * picker and not a storage format - mixing your own colors later writes the
     * same four columns instead of needing a migration.
     *
     * The defaults are the first theme's, and they are what a workspace whose
     * tint is not in the palette keeps: an unfamiliar color is one thing that
     * looks slightly wrong, not a corrupt row. (The D1 copy needed them for a
     * second reason this store does not have - old code writing rows across a
     * deploy that had added the columns.)
     *
     * **None of them carries a format CHECK**, and `bar` follows the two it
     * joins rather than introducing one for itself. A CHECK cannot be added to
     * an existing table in SQLite, so constraining only the new column would
     * mean rebuilding the table to make three columns disagree about their own
     * rules. Worth revisiting for all four together if it is ever wanted.
     */
    color: text('color').notNull(),
    bar: text('bar').notNull().default('#dbd7ee'),
    ground: text('ground').notNull().default('#e3e1f2'),
    header: text('header').notNull().default('#d2cdea'),
    /**
     * Where this workspace sits in the tabs, left to right ("Reorder
     * workspaces", issue 31). Lower is further left; `created_at` breaks a tie,
     * so the order every read produces is total whatever is in the column.
     *
     * **A number rather than a chain of "after this one".** The whole order is
     * rewritten by every move (`reorder_workspaces` in packages/shared's
     * commands.ts), so the numbers are dense and start at zero after one; there
     * is nothing to keep consistent between rows, and a row that somehow gets a
     * duplicate is one pair of tabs in an arbitrary but stable order rather
     * than a list that cannot be sorted at all.
     *
     * **Tombstoned workspaces keep theirs**, unread, because every read filters
     * them out anyway and dropping the value would be work for nothing.
     * A new workspace takes one past the highest there is, deleted rows
     * included, so nothing has to reason about a number coming back.
     *
     * `NOT NULL DEFAULT 0` because the column was added to a table that already
     * had rows in it (change `0004-workspace-order` in changes.ts), which SQLite
     * allows only with a default; the same change then gives every existing row
     * its real position. The default is what a workspace written by an older
     * version during a deploy would get - first in the tabs, which is wrong but
     * is one workspace in an unexpected place rather than a row that cannot be
     * written.
     */
    position: integer('position').notNull().default(0),
    createdAt: text('created_at').notNull(),
    /**
     * Tombstone, written by "Rename and delete a workspace" (issue 77) and
     * unread until then.
     *
     * It carries its `is_timestamp` CHECK like every other timestamp column
     * here, which the D1 copy of this table does not - see the note on
     * `deletedAt` in the D1 migration that added it. That gap was a measured
     * limitation of *altering* a live table: SQLite cannot ALTER a CHECK in,
     * and D1 will not drop a table with children under ON DELETE RESTRICT, so
     * attaching one meant a whole-schema rebuild for a single constraint. A
     * store creates this table whole on its first change, so the limitation
     * does not apply and the convention holds.
     */
    deletedAt: text('deleted_at'),
  },
  (t) => [
    /**
     * Uniqueness is on the *name*, because the name is what a person types and
     * reads.
     *
     * Partial and folded, which is two decisions:
     * - on `folded_name`, so `Personal` and `personal` are the same name - and
     *   so are `ÉTÉ` and `été`, which `lower(name)` in SQL could not manage
     *   (see the column). Names arrive already trimmed, from the wire schema.
     * - `WHERE deleted_at IS NULL`, so deleting a workspace gives its name
     *   back. A tombstoned workspace keeps its name for the record without
     *   holding it hostage.
     *
     * This index is the lock behind the check, not the answer itself: nothing
     * reads `folded_name` to decide whether a name is taken. Both writers of a
     * name - creating and renaming - fold through the same `foldName`, and this
     * index is what keeps a race between them from producing two rows with the
     * same folded name.
     */
    uniqueIndex('workspaces_tenant_live_folded_name')
      .on(t.tenantId, t.foldedName)
      .where(sql`${t.deletedAt} IS NULL`),
    check('workspaces_created_at_is_timestamp', isTimestamp('created_at')),
    check('workspaces_deleted_at_is_timestamp', isTimestamp('deleted_at')),
  ],
);

/**
 * A dashboard: a named view inside a workspace, switched between like tabs
 * (functional definition, "Container hierarchy"). It holds panels, arranged by
 * one layout per screen size ("Panels on a dashboard, with per-screen-size
 * layouts", issue 33); both hang off this table rather than off the workspace,
 * because a panel belongs to the view it was put on.
 *
 * The Inbox is not here and never will be. It is a fixture of the screen - a
 * column beside the dashboards where there is room, a view of its own where
 * there is not - rather than a row of this table, so nothing can rename,
 * delete or move it. That is a fact of the schema rather than a rule somebody
 * has to remember, which is why where it is drawn can change without anything
 * here changing.
 */
export const dashboards = sqliteTable(
  'dashboards',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    /**
     * The name with its case folded away, exactly as a workspace carries one
     * and for exactly the same reason: SQL's `lower()` folds `A`-`Z` and
     * nothing else, so `Été` and `été` would be two dashboards nobody could
     * tell apart in the bar. `foldName` in src/domain/names.ts is the one
     * function that folds, for both tables ("Add and switch dashboards", issue
     * 32, which says in as many words not to copy `lower(name)` into a second
     * table).
     */
    foldedName: text('folded_name').notNull(),
    createdAt: text('created_at').notNull(),
    /**
     * Tombstone, written by "Rename and delete a dashboard from a dashboard
     * settings page" (issue 90) and unread until then. It is here from the
     * first change rather than added later because a column costs nothing in a
     * table being created, and adding one to a live table is what `workspaces`
     * had to spend two migrations on.
     */
    deletedAt: text('deleted_at'),
  },
  (t) => [
    /**
     * Unique within the *workspace*, not the account: two workspaces may each
     * have a Research, and neither knows about the other's. That is the one
     * thing this differs from the workspaces index in, and it is why the
     * workspace id is part of the key.
     *
     * Partial on the tombstone like that one, so a deleted dashboard gives its
     * name back to the workspace it was in.
     */
    uniqueIndex('dashboards_workspace_live_folded_name')
      .on(t.tenantId, t.workspaceId, t.foldedName)
      .where(sql`${t.deletedAt} IS NULL`),
    index('dashboards_tenant_workspace').on(t.tenantId, t.workspaceId),
    check('dashboards_created_at_is_timestamp', isTimestamp('created_at')),
    check('dashboards_deleted_at_is_timestamp', isTimestamp('deleted_at')),
  ],
);

/**
 * A panel: a movable, resizable, titled box on one dashboard (functional
 * definition, "Container hierarchy"). What it *shows* is configuration it grows
 * later; today a panel is its title and its place on the grid ("Panels on a
 * dashboard, with per-screen-size layouts", issue 33).
 *
 * Tombstoned rather than deleted, like a workspace and a dashboard, and for the
 * same reason: the title is something a person wrote, and the partial index
 * below is what gives it back to the dashboard once the panel has gone.
 */
export const panels = sqliteTable(
  'panels',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    dashboardId: text('dashboard_id')
      .notNull()
      .references(() => dashboards.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    /**
     * The title with its case folded away, exactly as a workspace and a
     * dashboard carry one and for exactly the same reason: SQL's `lower()`
     * folds `A`-`Z` and nothing else. `foldName` in src/domain/names.ts is the
     * one function that folds, for all three tables.
     */
    foldedName: text('folded_name').notNull(),
    createdAt: text('created_at').notNull(),
    deletedAt: text('deleted_at'),
  },
  (t) => [
    /**
     * Unique within the *dashboard*, which is one level further down than the
     * dashboards index: two dashboards of one workspace may each have a Reading
     * list, and neither knows about the other's. Partial on the tombstone like
     * the other two, so a deleted panel gives its title back.
     */
    uniqueIndex('panels_dashboard_live_folded_name')
      .on(t.tenantId, t.dashboardId, t.foldedName)
      .where(sql`${t.deletedAt} IS NULL`),
    index('panels_tenant_dashboard').on(t.tenantId, t.dashboardId),
    check('panels_created_at_is_timestamp', isTimestamp('created_at')),
    check('panels_deleted_at_is_timestamp', isTimestamp('deleted_at')),
  ],
);

/**
 * A layout: one arrangement of a dashboard's panels, and the screen width it
 * was made at.
 *
 * **`screen_width` is a width, not a breakpoint.** The issue asks for arbitrary
 * widths on purpose, so there is no fixed set of sizes to belong to and the
 * question "which layout is this screen's" is answered by distance rather than
 * by membership.
 *
 * **Deleted for real, not tombstoned**, which is the one place this store
 * departs from "tombstones, not deletes" and is deliberate. A tombstone exists
 * to keep a record of something that happened; a layout records nothing that
 * happened, only how a screen was once arranged. Keeping it would mean
 * filtering it out of every read, and would leave its id able to bring it back
 * - `save_layout` is an upsert, and an upsert onto a tombstone is a resurrection
 * nobody asked for. Its placements go first, which is what the RESTRICT below
 * makes explicit rather than silent.
 */
export const layouts = sqliteTable(
  'layouts',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    dashboardId: text('dashboard_id')
      .notNull()
      .references(() => dashboards.id, { onDelete: 'restrict' }),
    screenWidth: integer('screen_width').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    index('layouts_tenant_dashboard').on(t.tenantId, t.dashboardId),
    // Bounded, because the automatic choice is "the layout closest to this
    // screen": one absurd width would win that comparison everywhere or never.
    check('layouts_screen_width_is_a_width', sql.raw('screen_width BETWEEN 1 AND 100000')),
    check('layouts_created_at_is_timestamp', isTimestamp('created_at')),
  ],
);

/**
 * Where one panel sits in one layout.
 *
 * **`position` is the whole of the arrangement, and there are no coordinates.**
 * Panels flow left to right and wrap, so what a layout stores is an order and a
 * size each - which is exactly what the issue describes: dragging one panel
 * past another reorders them, and the automatic rearrangement "keeps the
 * existing panel order and fills them left to right". A grid of free
 * coordinates would also permit holes, and a hole is a thing no gesture in the
 * issue can make.
 *
 * **A composite primary key**, where every other table here has a
 * client-generated id. The convention is about entities somebody creates and
 * can name; this row is the relationship between two of those, it has no
 * identity of its own, and `(layout_id, panel_id)` is the thing that must be
 * unique anyway - a panel appears once in a layout. Giving it a second,
 * generated key would mean guarding that with an index as well.
 *
 * **Deleted for real, like the layouts they belong to**, and like an
 * association, which is the other row here that is a link rather than a record.
 */
export const panelPlacements = sqliteTable(
  'panel_placements',
  {
    tenantId: text('tenant_id').notNull(),
    layoutId: text('layout_id')
      .notNull()
      .references(() => layouts.id, { onDelete: 'restrict' }),
    panelId: text('panel_id')
      .notNull()
      .references(() => panels.id, { onDelete: 'restrict' }),
    position: integer('position').notNull(),
    /**
     * `column_span` and `row_span`, not `columns` and `rows`: `ROWS` is a
     * keyword in SQLite's window-function grammar, and a column that only works
     * while every statement remembers to quote it is a trap for the next
     * hand-written one - and every statement in changes.ts is hand-written.
     */
    columnSpan: integer('column_span').notNull(),
    rowSpan: integer('row_span').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.layoutId, t.panelId] }),
    index('panel_placements_tenant_layout').on(t.tenantId, t.layoutId),
    // The same bounds the wire contract puts on a placement, built from the
    // same constants, so the two cannot drift into disagreeing about how wide
    // the grid is.
    check(
      'panel_placements_column_span_fits_the_grid',
      sql.raw(`column_span BETWEEN 1 AND ${GRID_COLUMNS}`),
    ),
    check('panel_placements_row_span_fits_the_grid', sql.raw(`row_span BETWEEN 1 AND ${MAX_PANEL_ROWS}`)),
    check('panel_placements_position_is_an_order', sql.raw('position >= 0')),
  ],
);

/**
 * What kind of thing an Item is ("Capture a thought or an action, and see which
 * it is", issue 155). Account-wide rather than per workspace: *Thought* means
 * the same in Work and in Personal, and a type name reveals nothing the
 * workspace boundary protects.
 *
 * **Created whole, with every column it will ever need**, including two nothing
 * writes yet. Once `items.type_id` points here this table has children under
 * RESTRICT, and from that moment a CHECK cannot be altered in and the table
 * cannot be rebuilt (architecture, "Schema conventions") - so `position` and
 * `deleted_at`, which "Manage the types, and put them in the order you want"
 * (issue 156) needs, arrive now with their constraints rather than later
 * without them. That is the opposite of the rule `itemColumns` in repo.ts
 * carries about *reads*, and for the same underlying reason: what a store can
 * still be told is decided the moment the first child row exists.
 */
export const itemTypes = sqliteTable(
  'item_types',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    name: text('name').notNull(),
    /** The name with its case folded away, exactly as `workspaces` carries one. */
    foldedName: text('folded_name').notNull().default(''),
    /** One of the palette's tints, which is the dot at the head of a row. */
    color: text('color').notNull(),
    /**
     * Where it sits in the list you put it in. Written by "Manage the types,
     * and put them in the order you want" (issue 156).
     */
    position: integer('position').notNull().default(0),
    createdAt: text('created_at').notNull(),
    /**
     * Tombstone, written by "Manage the types, and put them in the order you
     * want" (issue 156) and unread until then.
     */
    deletedAt: text('deleted_at'),
  },
  (t) => [
    /**
     * Uniqueness on the folded name among live types, the same shape and for
     * the same two reasons `workspaces` has one: `Thought` and `thought` are
     * the same name, and deleting a type gives its name back.
     *
     * It is the lock behind the check rather than the answer: creating a type
     * by using its name folds through `foldName` like every other writer, and
     * this is what keeps two tabs racing from making two of it.
     */
    uniqueIndex('item_types_tenant_live_folded_name')
      .on(t.tenantId, t.foldedName)
      .where(sql`${t.deletedAt} IS NULL`),
    /**
     * A closed set, so the database holds it too (architecture, "The database
     * is the second lock") - built from the same list the wire contract uses,
     * so the two cannot drift. `workspaces.color` has no equivalent for a
     * reason that does not apply here: that table was already live and could
     * not be rebuilt to attach one, and this one is created whole precisely so
     * every constraint it will ever need arrives up front.
     */
    check('item_types_color_is_known', oneOf('color', ITEM_TYPE_COLORS)),
    check('item_types_position_is_an_order', sql.raw('position >= 0')),
    check('item_types_created_at_is_timestamp', isTimestamp('created_at')),
    check('item_types_deleted_at_is_timestamp', isTimestamp('deleted_at')),
  ],
);

export const items = sqliteTable(
  'items',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'restrict' }),

    // -- write-once column --
    capturedMessage: text('captured_message'),

    // -- source-owned columns --
    source: text('source').$type<Source>().notNull(),
    sourceId: text('source_id'),
    sourceLink: text('source_link'),
    sender: text('sender'),
    sourceTimestamp: text('source_timestamp'),
    sourceResolvedAt: text('source_resolved_at'),

    // -- app-owned columns --
    // `preview` is deliberately absent though the column is still there: nothing
    // reads or writes it from here on, and dropping it waits for a later release
    // so a rollback still meets a schema its code can read (deployment,
    // "Migrations and rollback"; "Drop the preview column, once nothing reads
    // it", issue 161).
    title: text('title').notNull(),
    description: text('description'),
    /**
     * What kind of thing it is ("Capture a thought or an action, and see which
     * it is", issue 155). Nullable, which is what let it be added at all:
     * SQLite accepts a new column with a REFERENCES clause only when its
     * default is NULL, and `items` has children so it cannot be rebuilt.
     */
    typeId: text('type_id').references(() => itemTypes.id, { onDelete: 'restrict' }),
    nextAction: text('next_action'),
    /**
     * Finished with, and when ("An item is either yours to deal with or
     * finished with", issue 154). Carries no CHECK: a nullable column only the
     * command handlers write is not worth rebuilding three tables for, which is
     * the trade `workspaces.deleted_at` already records.
     */
    completedAt: text('completed_at'),
    priority: text('priority').$type<Priority>(),
    dueDate: text('due_date'),
    unseen: integer('unseen', { mode: 'boolean' }).notNull().default(false),
    deletedAt: text('deleted_at'),

    /**
     * Dead columns, kept because they cannot go. `status` is written
     * `DEAD_STATUS_VALUE` on every insert to satisfy NOT NULL and its CHECK,
     * and read nowhere; `focus_horizon` and `snoozed_until` are never written
     * at all. Focus horizons come back with "Goals: mark actions, panels and
     * dashboards as goals per horizon" (issue 38) as a decision rather than as
     * a menu entry, and may well not reuse these.
     */
    status: text('status').notNull(),
    focusHorizon: text('focus_horizon'),
    snoozedUntil: text('snoozed_until'),

    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    index('items_tenant_workspace_status').on(t.tenantId, t.workspaceId, t.status),
    check('items_source_is_known', oneOf('source', sourceSchema.options)),
    check('items_status_is_known', oneOf('status', DEAD_STATUSES)),
    check('items_focus_horizon_is_known', oneOf('focus_horizon', DEAD_FOCUS_HORIZONS)),
    check('items_priority_is_known', oneOf('priority', prioritySchema.options)),
    // STRICT gets this column to INTEGER; this gets it to a flag.
    check('items_unseen_is_flag', sql.raw('unseen IN (0, 1)')),
    check('items_due_date_is_date', isDate('due_date')),
    check('items_source_timestamp_is_timestamp', isTimestamp('source_timestamp')),
    check('items_source_resolved_at_is_timestamp', isTimestamp('source_resolved_at')),
    check('items_snoozed_until_is_timestamp', isTimestamp('snoozed_until')),
    check('items_deleted_at_is_timestamp', isTimestamp('deleted_at')),
    check('items_created_at_is_timestamp', isTimestamp('created_at')),
    check('items_updated_at_is_timestamp', isTimestamp('updated_at')),
  ],
);

/**
 * Which items are filed on which panels, and where each sits in its panel's
 * order ("Panels hold the items filed into them, and the Inbox holds the rest",
 * issue 36). The Inbox is the absence of a row here: every open item filed on
 * no live panel.
 *
 * **Many-to-many from the first change, and that is the whole point of the
 * shape.** The command that lands with it moves an item to one panel, so the
 * table it *needs* is one panel per item - and building it to that need
 * (`items.panel_id`, or a unique index on `item_id`) would make adding an item
 * to a second panel a rebuild of a table that by then has children, which is
 * the case D1 cannot do (architecture, "Schema conventions": a table with rows
 * pointing at it under RESTRICT cannot be dropped, and `PRAGMA foreign_keys =
 * OFF` is accepted and ignored). So nothing constrains `item_id`: an item has a
 * row per panel it is filed on, as many as there are panels.
 *
 * **`(panel_id, item_id)` is the key**, for the reason `panel_placements` has a
 * two-column one: an item is filed on a panel once, and that pair is what has
 * to be unique anyway, so a generated id would only add an index to guard.
 *
 * **Deleted for real, not tombstoned.** A filing is a link, and links here are
 * deleted - an association carries no `deleted_at` and neither does a
 * placement; tombstones are for items and for the boxes they live in. A
 * tombstoned link would also collide with its own dead row on the primary key
 * the moment an item was moved off a panel and back onto it. The append-only
 * history of where things were filed, which the router reads (routing that
 * learns from past decisions, "What the model reads: the whole history, no
 * retrieval"), is the command log - which carries no foreign keys precisely so
 * it outlives what it refers to.
 */
export const panelItems = sqliteTable(
  'panel_items',
  {
    tenantId: text('tenant_id').notNull(),
    panelId: text('panel_id')
      .notNull()
      .references(() => panels.id, { onDelete: 'restrict' }),
    itemId: text('item_id')
      .notNull()
      .references(() => items.id, { onDelete: 'restrict' }),
    position: integer('position').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.panelId, t.itemId] }),
    // Read per panel to draw one, and per item to decide whether it is in the
    // Inbox. Two indexes because the primary key only serves the first: a
    // lookup by item alone cannot use a key that leads with the panel.
    index('panel_items_tenant_panel').on(t.tenantId, t.panelId),
    index('panel_items_tenant_item').on(t.tenantId, t.itemId),
    check('panel_items_position_is_an_order', sql.raw('position >= 0')),
    check('panel_items_created_at_is_timestamp', isTimestamp('created_at')),
  ],
);

export const associations = sqliteTable(
  'associations',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    itemId: text('item_id')
      .notNull()
      .references(() => items.id, { onDelete: 'restrict' }),
    kind: text('kind').$type<AssociationKind>().notNull(),
    label: text('label').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    index('associations_tenant_item').on(t.tenantId, t.itemId),
    check('associations_kind_is_known', oneOf('kind', associationKindSchema.options)),
    check('associations_created_at_is_timestamp', isTimestamp('created_at')),
  ],
);

/**
 * The command log (architecture, "Mutations are commands, not object PUTs"):
 * idempotency check for retries and the audit trail. command_id is the
 * client-generated ID; a replayed command is a no-op.
 *
 * No foreign key on workspace_id: an audit trail has to outlive whatever it
 * refers to, which is the one place RESTRICT would be wrong.
 */
export const commands = sqliteTable(
  'commands',
  {
    commandId: text('command_id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    workspaceId: text('workspace_id').notNull(),
    name: text('name').notNull(),
    payload: text('payload').notNull(),
    issuedAt: text('issued_at').notNull(),
    receivedAt: text('received_at').notNull(),
  },
  (t) => [
    index('commands_tenant_received').on(t.tenantId, t.receivedAt),
    check('commands_payload_is_json', sql.raw('json_valid(payload)')),
    check('commands_issued_at_is_timestamp', isTimestamp('issued_at')),
    check('commands_received_at_is_timestamp', isTimestamp('received_at')),
  ],
);
