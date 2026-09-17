import {
  check,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
import {
  associationKindSchema,
  GRID_COLUMNS,
  ITEM_TYPE_COLORS,
  MAX_ROW_HEIGHT,
  MAX_SCREEN_WIDTH,
  MIN_ROW_HEIGHT,
  MIN_SCREEN_WIDTH,
  PANEL_FORMATS,
  STORED_PANEL_KINDS,
  prioritySchema,
  sourceSchema,
} from '@cockpit/shared';
import type {
  AssociationKind,
  ItemReading,
  PanelFormat,
  Priority,
  Source,
  StoredPanelKind,
} from '@cockpit/shared';

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
 * and `tenant_id` stays"): its workspaces, dashboards, panels, screen sizes,
 * layouts, items, associations and change log.
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
 * - **CHECK constraints for what is true by definition, never for what the
 *   product tunes**: a timestamp, a flag, an order index. A set the product
 *   will extend - the kinds a panel can be, the statuses an item moves
 *   through, the heights a row may take - is guarded by its Zod enum alone,
 *   because a CHECK is as expensive to change as to add and every extension
 *   would cost a rebuild. The enum and range CHECKs still below predate the
 *   rule and are removed by "Let the database lock what is true by
 *   definition, and Zod lock what the product tunes" (issue 257).
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
    /**
     * What the panel is made of: the items filed into it, or the text written
     * in it. Written when the panel is made and never again, which is what
     * `panelKindSchema` in the contract says and why no command updates it.
     *
     * **A Filter is stored as `items` here**, and is told apart by
     * `filter_conditions` below rather than by a third value: see
     * `STORED_PANEL_KINDS` in the contract for why this column's CHECK cannot
     * be widened.
     */
    kind: text('kind').notNull().default('items').$type<StoredPanelKind>(),
    /**
     * Whether that text is drawn as the characters that were typed or as what
     * they mean. Not a property of the text, which is Markdown either way.
     */
    format: text('format').notNull().default('plain').$type<PanelFormat>(),
    /**
     * The Markdown of a panel of text, and the empty string for a panel of
     * items. NOT NULL with a default rather than nullable: "no text" and "the
     * empty string" are the same thing to everything that reads this, and one
     * of the two would then be a state nobody meant.
     */
    body: text('body').notNull().default(''),
    /** Whether that text is read rather than written in. */
    readOnly: integer('read_only', { mode: 'boolean' }).notNull().default(false),
    /**
     * What a Filter gathers, as the JSON `panelFilterAsStored` writes, and NULL
     * on every Panel that is not one ("Add a Filter panel that shows every filed
     * item due in a window", issue 463). Being set is what *makes* a Panel a
     * Filter, which is what let this be one `ADD COLUMN` over a table that
     * cannot be rebuilt.
     *
     * **Text rather than `mode: 'json'`, and read defensively** — a stored shape
     * this release cannot parse has to read as a Filter with nothing chosen
     * (`panelFilterFrom`), where drizzle's own JSON mode would throw and take
     * the whole Workspace read with it.
     *
     * **Nullable because NULL is the answer**: it means "not a Filter", so
     * every Panel that already existed is right without being rewritten.
     *
     * **No CHECK, and not because one could not be added.** `0016-text-panels`
     * gave this same table three columns each carrying its own, which is what
     * `ADD COLUMN` allows where a rebuild would be needed to change a
     * constraint already on it. It carries none because what a condition may
     * say is the product's to extend (architecture.md, "A CHECK for what is
     * true by definition, never for what the product tunes"), and because the
     * read has to survive a shape it cannot parse rather than refuse it.
     */
    filterConditions: text('filter_conditions'),
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
    // Built from the same enum the wire contract uses, per "The database is the
    // second lock": a kind the contract has never heard of cannot be stored.
    // `STORED_PANEL_KINDS` rather than every kind a Panel can *read back* as,
    // which is the contract's own distinction and the column's own comment.
    check('panels_kind_is_known', oneOf('kind', STORED_PANEL_KINDS)),
    check('panels_format_is_known', oneOf('format', PANEL_FORMATS)),
    // A STRICT integer column takes any integer, and this one is a flag.
    check('panels_read_only_is_a_flag', sql`read_only IN (0, 1)`),
  ],
);

/**
 * A screen size: one of the screens this account works on, and the width to
 * match a window against ("Give the account a list of screen sizes, before
 * anything reads it", issue 262).
 *
 * **The account's, not a dashboard's**, which is the point: a layout carried
 * its own name and width, so every dashboard re-declared the same screens and
 * renaming one was a rename per dashboard. It hangs off nothing but
 * `tenant_id`, the way `item_types` does.
 *
 * **Nothing writes one in this release.** The table, `layouts.screen_size_id`
 * and the snapshot field land together so that "Draw a dashboard against the
 * screen sizes its account has" (issue 263) changes behaviour rather than
 * shape.
 *
 * **Deleted for real, not tombstoned**, for the reason a layout is: a size
 * records nothing that happened, only which screens somebody said they use.
 * Every layout at it goes first, which the RESTRICT below makes explicit
 * rather than silent.
 */
export const screenSizes = sqliteTable(
  'screen_sizes',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    name: text('name').notNull(),
    foldedName: text('folded_name').notNull(),
    width: integer('width').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    /**
     * Unique within the *account*, the way a type's name is - not within a
     * workspace or a dashboard, because one list of screens is the whole idea.
     * Not partial on a tombstone, because a size is deleted for real.
     */
    uniqueIndex('screen_sizes_folded_name').on(t.tenantId, t.foldedName),
    // Bounded, because a window is matched to the size closest to it: one
    // absurd width would win that comparison everywhere or never. True by
    // definition rather than a number the product tunes, so the database holds
    // it (architecture, "The database is the second lock").
    check(
      'screen_sizes_width_is_a_width',
      sql.raw(`width BETWEEN ${MIN_SCREEN_WIDTH} AND ${MAX_SCREEN_WIDTH}`),
    ),
    check('screen_sizes_created_at_is_timestamp', isTimestamp('created_at')),
  ],
);

/**
 * A layout: one arrangement of a dashboard's panels, at one screen size.
 *
 * **What it is called is the screen size's own name**, not anything stored
 * here - a Layout used to carry `name`, `folded_name` and `screen_width` of its
 * own, from before "Draw a dashboard against the screen sizes its account has"
 * (issue 263) gave every Layout a `screen_size_id` to hang off instead. "Take
 * the width and the name off a layout, now that its size carries them" (issue
 * 264) is the release that drops them, once nothing reads them any more.
 *
 * **`screen_size_id` is NOT NULL**, which is what makes this the final shape:
 * every Layout from here on is defined at a size the account has, and there is
 * no longer a legacy row with none to fall back for.
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
    /**
     * Which screen size this layout arranges the dashboard for. RESTRICT, like
     * everything else here: deleting a size has to say what happens to the
     * layouts at it rather than taking them silently.
     */
    screenSizeId: text('screen_size_id')
      .notNull()
      .references(() => screenSizes.id, { onDelete: 'restrict' }),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    index('layouts_tenant_dashboard').on(t.tenantId, t.dashboardId),
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
    /**
     * Which row of the layout this Panel is in, and where along it.
     *
     * `position` was the whole arrangement while Panels flowed and wrapped;
     * with rows it orders the cells *within* one ("Rows of panels, not a grid
     * that wraps"), and `row_index` orders the rows. Two numbers because there
     * are two orders, and a single flat position could not say which Panels
     * share a line - which is the thing the rows are for.
     */
    rowIndex: integer('row_index').notNull(),
    position: integer('position').notNull(),
    /**
     * How much of its row this Panel takes, as a share rather than a width: the
     * cells of a row divide it in proportion to their spans, so 6 and 6 is half
     * each and so is 1 and 1. Bounded by the grid all the same, because a share
     * larger than a whole row is a number that means nothing.
     *
     * `span`, not `columns`: it is no longer a count of grid columns, and a
     * name that says otherwise would be read as one. (`rows` was never
     * available - `ROWS` is a keyword in SQLite's window-function grammar, and
     * every statement in changes.ts is hand-written.)
     */
    span: integer('span').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.layoutId, t.panelId] }),
    index('panel_placements_tenant_layout').on(t.tenantId, t.layoutId),
    // The same bound the wire contract puts on a cell, from the same constant,
    // so the two cannot drift into disagreeing about how wide a row is.
    check('panel_placements_span_fits_the_grid', sql.raw(`span BETWEEN 1 AND ${GRID_COLUMNS}`)),
    check('panel_placements_position_is_an_order', sql.raw('position >= 0')),
    check('panel_placements_row_index_is_an_order', sql.raw('row_index >= 0')),
  ],
);

/**
 * One row of one layout, and how tall it is.
 *
 * **A row is a row because its Panels share a height**, and that is why this is
 * a table rather than a column on the placement: one number belongs to the row,
 * and a copy of it on every Panel in the row is a set of numbers that can
 * disagree. The gesture that sets it is a drag on the line under the row, which
 * is a thing you do to the row.
 *
 * `height` is null for "as tall as what is in it", which is what a row is until
 * somebody drags that line. In pixels, because the gesture is a pointer against
 * a screen and there is no unit in between.
 *
 * **Deleted for real, like the layouts they belong to**: a row records nothing
 * that happened, only how a layout was once divided.
 */
export const layoutRows = sqliteTable(
  'layout_rows',
  {
    tenantId: text('tenant_id').notNull(),
    layoutId: text('layout_id')
      .notNull()
      .references(() => layouts.id, { onDelete: 'restrict' }),
    rowIndex: integer('row_index').notNull(),
    height: integer('height'),
  },
  (t) => [
    primaryKey({ columns: [t.layoutId, t.rowIndex] }),
    index('layout_rows_tenant_layout').on(t.tenantId, t.layoutId),
    check('layout_rows_row_index_is_an_order', sql.raw('row_index >= 0')),
    check(
      'layout_rows_height_is_a_height',
      sql.raw(`height IS NULL OR height BETWEEN ${MIN_ROW_HEIGHT} AND ${MAX_ROW_HEIGHT}`),
    ),
  ],
);

/**
 * What kind of thing an Item is ("Capture a thought or an action, and see which
 * it is", issue 155). Account-wide rather than per workspace: *Note* means the
 * same in Work and in Personal, and a type name reveals nothing the workspace
 * boundary protects.
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
     * the same two reasons `workspaces` has one: `Note` and `note` are the
     * same name, and deleting a type gives its name back.
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
    /**
     * Whether anybody has said which Workspace this Item belongs to ("Capture
     * something before you know which workspace it belongs to", issue 165).
     * False means it belongs to none and shows in every Workspace's Inbox;
     * `workspace_id` then holds the Workspace it was captured from.
     *
     * **The default is `1`, and that direction is the point.** `ADD COLUMN`
     * gives every row that already existed the default, and every one of them
     * was captured into a Workspace deliberately - so the default is what
     * makes this change a single statement with no backfill to half-apply.
     * It is also the safe direction for a write that forgets the column: the
     * Item stays in its own Workspace rather than appearing in all of them.
     *
     * Carries no CHECK holding it to a flag, unlike `unseen` beside it: a
     * column added to a live table cannot get one, because SQLite attaches
     * CHECKs only when a table is created and `items` cannot be rebuilt. Same
     * trade `completed_at` records below.
     */
    workspaceDecided: integer('workspace_decided', { mode: 'boolean' })
      .notNull()
      .default(true),

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
    title: text('title').notNull(),
    description: text('description'),
    /**
     * When a person took the two texts above over from Cockpit, and null while
     * they are still Cockpit's to replace ("Clean up a captured note into a
     * clear title and a fuller message", issue 296).
     *
     * Nullable, which is what makes the change that added it a single statement
     * with no backfill: every row that already existed gets NULL, and NULL is
     * the safe direction only because nothing enqueues those rows for
     * enrichment - a title written by hand before this shipped is unreachable
     * by construction rather than by this column's value.
     *
     * Carries no CHECK holding it to a timestamp, unlike the columns created
     * with the table: SQLite attaches CHECKs only when a table is created and
     * `items` cannot be rebuilt while `panel_items` and `associations` point at
     * it. Same trade `completed_at` and `workspace_decided` record above.
     */
    textsSettledAt: text('texts_settled_at'),
    /**
     * When Cockpit proposed the two texts above, and null while nothing has
     * been - either enrichment has not run yet, or never will ("Learn how you
     * write from the titles you correct", issue 394; `docs/text-learning.md`,
     * "What is stored"). Tells a real proposal apart from the mechanical write
     * `capture_item` makes to `title` and `description`, which is what lets a
     * later correction be told apart from a title written by hand from the
     * start.
     *
     * **Written once, by `applyProposedTexts` alone, and never cleared.**
     * `capture_item` never touches it - the same asymmetry `proposed_panel_id`
     * has with `applyProposedPanel` below - and `applyProposedTexts` itself
     * already refuses once `texts_settled_at` is set, so this can only ever be
     * written before that happens.
     *
     * Nullable and carries no CHECK, for the reason `texts_settled_at` above
     * does: `items` cannot be rebuilt while `panel_items` and `associations`
     * point at it under RESTRICT.
     */
    textsProposedAt: text('texts_proposed_at'),
    /**
     * The other ways this note could genuinely be read, where Cockpit found
     * any ("Offer the other readings when a captured note says two things",
     * issue 297). Written together with `title` and `description`
     * (`applyProposedTexts`), so it obeys the same rule `texts_settled_at`
     * does: once a person has taken the texts over there is nothing left for
     * an alternate reading to be an alternative to.
     *
     * **JSON in a text column, the first of its kind in this schema.** A
     * reading is small, bounded to two or three, and read back whole with the
     * Item that holds it - nothing ever queries into one, which is the case a
     * table earns itself and this does not have. `mode: 'json'` is what makes
     * the column round-trip as `ItemReading[] | null` rather than as a string
     * this file would have to (de)serialize by hand.
     *
     * Nullable for the reason `texts_settled_at` is: SQLite accepts a new
     * column on a live table only with a default of NULL or a constant, and
     * `items` cannot be rebuilt while `panel_items` and `associations` point
     * at it. Carries no CHECK for the same reason that column carries none -
     * SQLite attaches CHECKs only when a table is created.
     */
    readings: text('readings', { mode: 'json' }).$type<ItemReading[]>(),
    /**
     * The Panel Cockpit proposes this Item belongs on, and why - offered
     * rather than filed ("Propose where a captured note belongs, without
     * filing it there", issue 298). Null where nothing was proposed, which is
     * the common case and a real answer.
     *
     * **No settled flag beside it, unlike `texts_settled_at` above.** A
     * routing settles by being filed, which is a row in `panel_items` and not
     * a state on the Item, so there is nothing here for a person taking the
     * proposal over to write - the Item simply leaves the Inbox, which is the
     * only place a proposal is drawn.
     *
     * Nullable and carries no CHECK, for the reason `type_id` and
     * `texts_settled_at` do: `items` cannot be rebuilt while `panel_items` and
     * `associations` point at it under RESTRICT, and SQLite accepts a new
     * column with a REFERENCES clause only when its default is NULL.
     */
    proposedPanelId: text('proposed_panel_id').references(() => panels.id, { onDelete: 'restrict' }),
    proposedPanelReason: text('proposed_panel_reason'),
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
    /**
     * When `dueDate` was last set ("Colour an action's own deadline as it
     * approaches, and mark it red once passed", issue 473). Nullable and
     * carries no CHECK, the same shape `readings` and `texts_settled_at` are.
     */
    dueDateSetAt: text('due_date_set_at'),
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
    // Ordered for `itemsToRead`'s cursor walk (repo.ts) - `tenant_id` alone
    // picks out nothing within one account, so the index has to carry `id`
    // too for the `id > ?` range and the walk's own order to use it.
    index('items_tenant_id').on(t.tenantId, t.id),
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
 * learns from past decisions, "What the model reads: bounded, no retrieval"),
 * is the command log - which carries no foreign keys precisely so it outlives
 * what it refers to.
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
 * One entry per Item, written the first time it ever lands on a real Panel -
 * the append-only decision history a routing proposal reads from, bounded
 * rather than whole ("Learn where notes belong from where you actually file
 * them", issue 299; `docs/routing-learning.md`, "What the model reads:
 * bounded, no retrieval"). The table itself keeps every row regardless -
 * only `decisionHistoryForWorkspace`'s (`repo.ts`) own read is capped.
 *
 * **Written by whichever of `move_item_to_panel` or `add_item_to_panel` gets
 * there first, and never again for that Item.** Both settle a routing
 * equally ("putting an item on a panel is putting it on a panel whichever of
 * the two commands says so", `command-service.ts`'s own comment on the
 * second); what decides whether either writes a row is `isItemFiled` read
 * *before* the write, not which command was sent. A move to the Inbox
 * (`panel_id: null`) is not a filing at all, and a reorganizing move or add
 * of an Item already filed somewhere is not a *first* filing - neither
 * writes a row, which is what keeps a stale, long-since-acted-on proposal
 * from being misattributed to a decision it was never shown for.
 *
 * **`id` is the settling command's own `command_id`.** The command that writes
 * it is already idempotent on that id (`command-service.ts`), so reusing it
 * costs nothing and keeps every entry traceable to the exact command that made
 * it.
 *
 * **`proposed_panel_id` is nullable and `chosen_panel_id` is not**: naming no
 * Panel is a real proposal outcome (issue 298, "Proposing nothing is a real
 * answer"), while a row only exists because something was actually filed.
 * Both reference `panels`, exactly as `items.proposed_panel_id` already does,
 * because a Panel is tombstoned rather than deleted (architecture, "Schema
 * conventions") - so an entry naming a since-deleted Panel still resolves.
 *
 * **Nothing here is ever updated or deleted, by this table's own rule.** An
 * undone filing writes no second row and removes no first one - undoing a
 * first-ever filing returns an Item to the Inbox, logging nothing either
 * way, and undoing a later reorganizing move is itself just another
 * reorganizing move of an already-filed Item, which the "first filing only"
 * rule above already keeps out - so the original entry always stands.
 * Weighting a reorganizing filing's own, separately-recorded rows
 * differently from a first settling is `docs/routing-learning.md` §13
 * decision 4, deliberately not decided here - this table simply never
 * creates those separate rows in the first place while every reorganizing
 * move keeps the Item filed throughout.
 *
 * **`isItemFiled` (repo.ts) reads current state, not history, so an Item can
 * genuinely return to the Inbox and later write a *second* entry** - its only
 * Panel deleted (`delete_panel` tombstones the Panel, not the filing row) or
 * removed outright (`remove_item_from_panel`), then filed again. That second
 * entry is a real, distinct filing decision and is meant to be recorded - the
 * failure mode this guarded against was never the second row, it was the
 * first row's proposal being reattached to it. `command-service.ts` clears
 * `items.proposed_panel_id`/`proposed_panel_reason` in the same transaction
 * that reads either into an entry, so a proposal is readable here at most
 * once, by whichever filing consumes it first - a later entry for the same
 * Item always reads `proposed_panel_id` as null, honestly reporting that
 * nothing was live to propose by then.
 */
export const decisionHistory = sqliteTable(
  'decision_history',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'restrict' }),
    itemId: text('item_id')
      .notNull()
      .references(() => items.id, { onDelete: 'restrict' }),
    proposedPanelId: text('proposed_panel_id').references(() => panels.id, { onDelete: 'restrict' }),
    proposedPanelReason: text('proposed_panel_reason'),
    chosenPanelId: text('chosen_panel_id')
      .notNull()
      .references(() => panels.id, { onDelete: 'restrict' }),
    decidedAt: text('decided_at').notNull(),
  },
  (t) => [
    // Read per workspace, most recent first and capped (routing-learning.md,
    // "What the model reads") - the one access pattern this table has.
    index('decision_history_tenant_workspace_decided').on(t.tenantId, t.workspaceId, t.decidedAt),
    check('decision_history_decided_at_is_timestamp', isTimestamp('decided_at')),
  ],
);

/**
 * What one Item means, as a vector ("Flag a captured note that says what
 * another one already said", issue 407).
 *
 * **A table of its own rather than a column on `items`.** A reading is a
 * thousand numbers and every read of an Item would carry it - into the
 * snapshot, into a backup, into the copy a browser keeps - for something the
 * screen only ever needs as a mark and a link. Here, nothing but the job that
 * writes it and the query that pairs it ever touches one.
 *
 * **One row per Item, replaced rather than added to.** An Item has one current
 * meaning, which is the meaning of the two texts it shows right now - so
 * editing its Title writes over this row rather than making a second
 * (`rememberWhatAnItemMeans`, store.ts). There is no history here to keep: an
 * old reading is a reading of words nobody can see any more.
 *
 * **`model` is what stops two spaces being compared.** Vectors from two
 * different models are not comparable at all, so the pairing query only ever
 * compares rows naming the same model - which is also what makes changing the
 * model a matter of re-reading rather than of a migration.
 *
 * `reading` is JSON in a text column, the same choice `items.readings` records:
 * it is read back whole with the row and nothing ever queries into one.
 */
export const itemMeanings = sqliteTable(
  'item_meanings',
  {
    itemId: text('item_id')
      .primaryKey()
      .references(() => items.id, { onDelete: 'restrict' }),
    tenantId: text('tenant_id').notNull(),
    model: text('model').notNull(),
    reading: text('reading', { mode: 'json' }).$type<number[]>().notNull(),
    readAt: text('read_at').notNull(),
  },
  (t) => [
    // Read per account and per item, which is the one access pattern this
    // table has - scoped to the tenant so a routing bug returns nothing rather
    // than another account's reading (architecture, "`tenant_id` stays on
    // every row").
    index('item_meanings_tenant_item').on(t.tenantId, t.itemId),
    check('item_meanings_read_at_is_timestamp', isTimestamp('read_at')),
  ],
);

/**
 * Two Items that say the same thing ("Flag a captured note that says what
 * another one already said", issue 407).
 *
 * **One row per pair, never two.** `item_id` is always the smaller of the two
 * ids and the CHECK below is what holds it - so the pair is the same row
 * whichever of the two was read last, opening either Item finds it, and reading
 * the same note twice adds nothing. The alternative, a row per direction, makes
 * "is this one flagged" two queries and lets the two halves disagree.
 *
 * **Whether a pair is *drawn* is not decided here.** A pair is written between
 * any two Items whose readings are close enough; a filed Item is nothing's
 * duplicate yet, and that is a rule about what the Inbox shows rather than
 * about what is true (`possibleDuplicatesOf`, apps/web/src/duplicates.ts) -
 * which is what lets filing and unfiling an Item change the marks without
 * touching a row here.
 *
 * `how_alike` is kept though nothing reads it back today: it is the one number
 * that would say whether the cut-off is placed right, and it costs a column.
 */
export const itemDuplicates = sqliteTable(
  'item_duplicates',
  {
    tenantId: text('tenant_id').notNull(),
    itemId: text('item_id')
      .notNull()
      .references(() => items.id, { onDelete: 'restrict' }),
    otherItemId: text('other_item_id')
      .notNull()
      .references(() => items.id, { onDelete: 'restrict' }),
    howAlike: real('how_alike').notNull(),
    foundAt: text('found_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.itemId, t.otherItemId] }),
    // Two indexes, for the reason `panel_items` has two: a pair is looked up
    // from either of its Items, and a key that leads with the first cannot
    // serve a lookup by the second.
    index('item_duplicates_tenant_item').on(t.tenantId, t.itemId),
    index('item_duplicates_tenant_other').on(t.tenantId, t.otherItemId),
    // True by definition rather than a rule the product tunes, which is what a
    // CHECK is for (architecture, "The database is the second lock"): a pair of
    // one Item with itself is not a pair, and the same two Items the other way
    // round is the same pair.
    check('item_duplicates_is_one_unordered_pair', sql.raw('item_id < other_item_id')),
    check('item_duplicates_found_at_is_timestamp', isTimestamp('found_at')),
  ],
);

/**
 * A pair somebody has said is not a duplicate ("Say a flagged pair is not a
 * duplicate", issue 408) - checked wherever `item_duplicates` is drawn, never
 * where it is written.
 *
 * **Its own table rather than a column on `item_duplicates`.** A re-read
 * deletes and rewrites every row `item_duplicates` holds for the Item it is
 * about (`replaceDuplicatesOf`, repo.ts) - a column here would be lost the
 * moment either half of the pair was next edited, which is exactly the
 * failure `docs/routing-learning.md`'s rule ("Cockpit may replace what it
 * proposed and never what you settled") exists to rule out. A table nothing
 * in the recompute path touches is what makes the settling outlast it.
 *
 * **The same unordered-pair shape as `item_duplicates`, and for the same
 * reason**: one row settles the pair whichever of the two Items it is asked
 * from, and the CHECK below is what a writer never has to get right by
 * convention alone.
 */
export const duplicateSettlements = sqliteTable(
  'duplicate_settlements',
  {
    tenantId: text('tenant_id').notNull(),
    itemId: text('item_id')
      .notNull()
      .references(() => items.id, { onDelete: 'restrict' }),
    otherItemId: text('other_item_id')
      .notNull()
      .references(() => items.id, { onDelete: 'restrict' }),
    settledAt: text('settled_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.itemId, t.otherItemId] }),
    index('duplicate_settlements_tenant_item').on(t.tenantId, t.itemId),
    index('duplicate_settlements_tenant_other').on(t.tenantId, t.otherItemId),
    check('duplicate_settlements_is_one_unordered_pair', sql.raw('item_id < other_item_id')),
    check('duplicate_settlements_settled_at_is_timestamp', isTimestamp('settled_at')),
  ],
);

/**
 * One row per Item, recording the correction the moment you make it - the
 * evidence a title or description proposal reads back ("Learn how you write
 * from the titles you correct", issue 394; `docs/text-learning.md`, "What is
 * stored").
 *
 * **Upserted on `item_id`, unlike `decision_history` above.** A filing is one
 * act and its entry is never touched again; editing a text is not - a second
 * edit refines the same correction rather than making a new one, so this
 * table updates the settled half of an existing row instead of appending a
 * second (`docs/text-learning.md`, "The proposal is frozen at your first
 * edit; your side stays live").
 *
 * **The note and the proposal are copied onto the row, not joined from the
 * Item.** A row has to outlive the Item it was about - a dismissed Item is
 * tombstoned rather than erased, but a joined read would still lose its note
 * from view the moment a query excludes it, the same way `decisionHistoryFor-
 * Workspace` already does.
 *
 * **Holds only the "Edited" kind, not "Pinned" or "Rejected".** `item_id` is
 * `NOT NULL` and restricted to an Item that still exists, which a pinned
 * example - added or pasted with no Item behind it at all - cannot satisfy;
 * see `pinnedTextExamples` below for that kind's own table ("Pin an example
 * of how you want a note written", issue 397).
 *
 * **Written only for a text Cockpit actually proposed.** `command-service.ts`
 * writes a row only where `items.texts_proposed_at` is set - an Item hand-
 * written from the start teaches nothing about a correction, because nothing
 * was proposed to correct.
 */
export const textCorrections = sqliteTable(
  'text_corrections',
  {
    itemId: text('item_id')
      .primaryKey()
      .references(() => items.id, { onDelete: 'restrict' }),
    tenantId: text('tenant_id').notNull(),
    capturedMessage: text('captured_message').notNull(),
    proposedTitle: text('proposed_title').notNull(),
    proposedDescription: text('proposed_description'),
    settledTitle: text('settled_title').notNull(),
    settledDescription: text('settled_description'),
    recordedAt: text('recorded_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    // Read whole, per account, oldest first ("no retrieval step" -
    // `docs/text-learning.md`, quoting `docs/routing-learning.md`) - the one
    // access pattern this table has.
    index('text_corrections_tenant_recorded').on(t.tenantId, t.recordedAt),
    check('text_corrections_recorded_at_is_timestamp', isTimestamp('recorded_at')),
    check('text_corrections_updated_at_is_timestamp', isTimestamp('updated_at')),
  ],
);

/**
 * One row per Workspace: the sentence a person writes about where its notes
 * belong ("Show what the system learned, in a sentence you can correct", issue
 * 301).
 *
 * **`summary`/`summary_generated_at` are dead columns, not a second half.** A
 * nightly job wrote them and nothing ever read them back, so that job is gone
 * and nothing writes them any more ("Drop the nightly filing summary, keep the
 * sentence you wrote", issue 392). They keep whatever they already hold -
 * expand-then-contract, and dropping them is its own step, once the
 * account-scoped rules block replaces this table (`docs/text-learning.md`,
 * "Build order"). Nothing may start reading them in the meantime.
 *
 * `correction`/`correction_set_at` are written only by the
 * `set_routing_summary_correction` command, and that write has never touched
 * the other two columns.
 *
 * **`workspace_id` is the primary key, not a separate `id`.** There is
 * exactly one correction per Workspace, ever, so a row is addressed by the
 * Workspace it belongs to and there is nothing else it could be keyed on.
 *
 * **The row does not exist until something is written.** Nobody has written a
 * sentence for a freshly made Workspace, so there is no row to create in step
 * with it - unlike `workspaces` itself, which is a row from the moment it is
 * made. Reads treat a missing row exactly as they would an existing one with
 * every column null.
 *
 * **All four value columns are nullable.** `correction`/`correction_set_at`
 * are null until a person writes one, and go back to null when they clear it -
 * there is no third state between "never set" and "set to nothing" worth
 * telling apart, the same choice `set_description` already makes. The other
 * two are null on every Workspace never summarized before that job was
 * removed, and on every Workspace made since.
 */
export const workspaceRoutingSummary = sqliteTable(
  'workspace_routing_summary',
  {
    workspaceId: text('workspace_id')
      .primaryKey()
      .references(() => workspaces.id, { onDelete: 'restrict' }),
    tenantId: text('tenant_id').notNull(),
    summary: text('summary'),
    summaryGeneratedAt: text('summary_generated_at'),
    correction: text('correction'),
    correctionSetAt: text('correction_set_at'),
  },
  (t) => [
    // The one access pattern this table has: one workspace's own row, scoped
    // to its tenant so a routing bug returns nothing rather than another
    // account's summary (architecture, "`tenant_id` stays on every row").
    index('workspace_routing_summary_tenant_workspace').on(t.tenantId, t.workspaceId),
    check(
      'workspace_routing_summary_generated_at_is_timestamp',
      isTimestamp('summary_generated_at'),
    ),
    check(
      'workspace_routing_summary_correction_set_at_is_timestamp',
      isTimestamp('correction_set_at'),
    ),
  ],
);

/**
 * One row per account: the rules an account writes for how Cockpit writes a
 * title and a message ("Show what Cockpit is told, and say how you want it
 * changed", issue 398; `docs/text-learning.md`, "Where you see it, and
 * change it").
 *
 * **`tenant_id` is the primary key, not a separate `id`.** There is exactly
 * one rules box per account, ever, and inside one account's own store every
 * row's `tenant_id` already reads the same value - the same shape
 * `workspaceRoutingSummary` above takes for `workspace_id`, one level up the
 * scope it is keyed on.
 *
 * **The row does not exist until something is written.** Nobody has written
 * rules for a freshly made account, so there is no row to create it with -
 * reads treat a missing row exactly as they would an existing one with every
 * column null, the same convention `workspaceRoutingSummary` follows.
 *
 * **A different table from `workspace_routing_summary` above, not a
 * migration of it** - why, in `packages/shared/src/domain/text-learning-
 * rules.ts`. Nothing reads or writes across the two tables.
 */
export const accountTextRules = sqliteTable(
  'account_text_rules',
  {
    tenantId: text('tenant_id').primaryKey(),
    /** Null until the account writes one, and null again once it is cleared. */
    rules: text('rules'),
    rulesSetAt: text('rules_set_at'),
  },
  (t) => [check('account_text_rules_rules_set_at_is_timestamp', isTimestamp('rules_set_at'))],
);

/**
 * A worked example of a note and the title and message chosen for it, added
 * by hand rather than corrected after the fact ("Pin an example of how you
 * want a note written", issue 397; `docs/text-learning.md`, "What is
 * stored" - the "Pinned" kind).
 *
 * **Its own table, not a `kind` column on `textCorrections` above.** That
 * table's primary key is the Item it corrected, `NOT NULL` and restricted
 * to one that still exists - a pinned example has no Item behind it, most
 * concretely the 29 examples this issue exists to let in. Reworking that
 * table's key shape to make room for a row with no Item is a larger,
 * riskier change than this issue's own failure modes ask for.
 *
 * **`id` is a separate primary key, not `tenant_id`**, unlike
 * `accountTextRules` above: an account has many pinned examples, not one.
 *
 * **Hard-deleted, never tombstoned** - unlike `itemTypes`, `workspaces` and
 * their siblings, nothing else references a pinned example's id under a
 * restricting foreign key, so there is no key to keep satisfied by keeping
 * the row. The same choice "See what it got right, and what you corrected"
 * (issue 412) makes for deleting a correction, the sibling kind of evidence
 * row: gone is gone.
 */
export const pinnedTextExamples = sqliteTable(
  'pinned_text_examples',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    note: text('note').notNull(),
    title: text('title').notNull(),
    description: text('description'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    // Read whole, per account, oldest first - the same access pattern
    // `textCorrections` above has, and for the same reason: no retrieval
    // step (`docs/text-learning.md`, quoting `docs/routing-learning.md`).
    index('pinned_text_examples_tenant_created').on(t.tenantId, t.createdAt),
    check('pinned_text_examples_created_at_is_timestamp', isTimestamp('created_at')),
    check('pinned_text_examples_updated_at_is_timestamp', isTimestamp('updated_at')),
  ],
);

/**
 * A file attached to an Item - metadata only ("Attach a file to an item",
 * issue 441). The bytes live in R2 under `r2Key`
 * (`apps/api/src/domain/attachments.ts`); nothing here ever holds them, and
 * the account's own store is not a second copy.
 *
 * **Hard-deleted, never tombstoned** - the same choice `pinnedTextExamples`
 * above makes and for the same reason: nothing else references an
 * attachment's id under a restricting foreign key. Removing an attachment
 * removes this row and nothing else; the R2 object it named is left in
 * place - the tombstone-not-delete stance this build was scoped to have no
 * state it can destroy (issue 441, "Out of scope").
 *
 * **No CHECK on `content_type`.** The allowlist (`attachmentContentTypeSchema`,
 * `@cockpit/shared`) is a set the product may extend, the same category this
 * file's own header puts panel kinds and item statuses in - guarded by Zod
 * alone, because a CHECK here would cost rebuilding this table (and
 * everything under RESTRICT beneath it) the day that allowlist grows by one
 * entry.
 *
 * **`size > 0` is the one CHECK this table gets**, because a stored file
 * having positive size is true by definition; the 25MB cap itself is a
 * product number enforced by `addAttachmentSchema` on the way in, the same
 * split `MIN_ROW_HEIGHT`/`MAX_ROW_HEIGHT` take for a Layout row.
 */
export const attachments = sqliteTable(
  'attachments',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    itemId: text('item_id')
      .notNull()
      .references(() => items.id, { onDelete: 'restrict' }),
    r2Key: text('r2_key').notNull(),
    filename: text('filename').notNull(),
    size: integer('size').notNull(),
    contentType: text('content_type').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    // What `listAttachmentsInWorkspace` reads by (repo.ts) - every
    // attachment of one item, joined the same way `listAssociationsForWorkspace`
    // joins its own.
    index('attachments_tenant_item').on(t.tenantId, t.itemId),
    check('attachments_size_is_positive', sql.raw('size > 0')),
    check('attachments_created_at_is_timestamp', isTimestamp('created_at')),
  ],
);

/**
 * One attempt Cockpit made to rewrite a captured item's title and description,
 * from the moment it was queued through to its outcome ("See the history of
 * what Cockpit proposed for the Inbox's items", issue 444).
 *
 * **Written from `jobs/enrichment.ts`'s own outcome points, not from
 * `command-service.ts`** - unlike `decisionHistory` above, an attempt here is
 * queued and settled outside any user command, so `id` is a fresh id minted
 * at the moment it is queued rather than a reused `commandId`.
 *
 * **One row per attempt, updated rather than replaced as it settles** - a
 * queue retry of the same attempt carries the same `id` and updates this row
 * in place; a later, separate re-proposal is queued with an id of its own,
 * so it is a second row rather than a second write to this one.
 *
 * **`title_before`/`description_before` are frozen at the moment this is
 * queued.** They are what the row is showing a change *from*, and an Item
 * edited again while the attempt is in flight must not rewrite what this row
 * says it started with.
 */
export const rewriteHistory = sqliteTable(
  'rewrite_history',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'restrict' }),
    itemId: text('item_id')
      .notNull()
      .references(() => items.id, { onDelete: 'restrict' }),
    titleBefore: text('title_before').notNull(),
    titleAfter: text('title_after'),
    descriptionBefore: text('description_before'),
    descriptionAfter: text('description_after'),
    proposedPanelId: text('proposed_panel_id').references(() => panels.id, { onDelete: 'restrict' }),
    proposedPanelReason: text('proposed_panel_reason'),
    /** 'pending' | 'rewritten' | 'left-as-is' | 'failed' (RewriteAttemptStatus, packages/shared). */
    status: text('status').notNull(),
    message: text('message'),
    attemptedAt: text('attempted_at').notNull(),
  },
  (t) => [
    // Read per workspace, most recent first - the account-wide table opened
    // from the Inbox's own menu.
    index('rewrite_history_tenant_workspace_attempted').on(t.tenantId, t.workspaceId, t.attemptedAt),
    // Read per item, most recent first - the table opened from an item's own
    // menu.
    index('rewrite_history_tenant_item_attempted').on(t.tenantId, t.itemId, t.attemptedAt),
    check('rewrite_history_attempted_at_is_timestamp', isTimestamp('attempted_at')),
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
