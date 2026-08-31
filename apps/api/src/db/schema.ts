import { check, index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
import {
  associationKindSchema,
  focusHorizonSchema,
  itemStatusSchema,
  prioritySchema,
  sourceSchema,
} from '@cockpit/shared';
import type { AssociationKind, FocusHorizon, ItemStatus, Priority, Source } from '@cockpit/shared';

/**
 * Schema conventions (architecture §4.2), binding from the first migration:
 * - tenant_id on every row, non-null, even while there is exactly one tenant;
 * - client-generated IDs (UUIDv7) as text primary keys;
 * - tombstones, not deletes (deleted_at / source_resolved_at);
 * - source-owned vs app-owned columns are separate groups on items:
 *   re-syncs overwrite source-owned columns unconditionally, never app-owned.
 * Timestamps are ISO-8601 text; dates are YYYY-MM-DD text.
 *
 * The database enforces those conventions rather than trusting its callers to,
 * per "The database is the second lock" in the architecture's schema
 * conventions:
 *
 * - **STRICT tables.** SQLite's default is dynamic typing with affinity: a
 *   TEXT column will happily store an integer. STRICT (SQLite 3.37+, which D1
 *   runs) makes declared types enforced. Drizzle cannot express it - there is
 *   no STRICT option in drizzle-orm's sqlite-core and drizzle-kit never emits
 *   the keyword - so **every migration carries it by hand**: after any
 *   `db:generate`, add STRICT to each CREATE TABLE it produced. The rule "a
 *   value of the wrong kind is refused rather than quietly changed" in
 *   tests/integration/db/constraints.test.ts exists to go red when that is
 *   forgotten.
 * - **CHECK constraints for every closed set**, built from the same Zod enums
 *   the wire contract uses, so the two cannot drift.
 * - **Foreign keys**, which D1 enforces. ON DELETE RESTRICT throughout,
 *   because nothing in this model is ever hard-deleted; deleting a workspace
 *   ("Rename and delete a workspace", issue 77) leaves its items where they
 *   are and tombstones the workspace, rather than inheriting a silent cascade.
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

export const tenants = sqliteTable(
  'tenants',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    createdAt: text('created_at').notNull(),
  },
  () => [check('tenants_created_at_is_timestamp', isTimestamp('created_at'))],
);

export const workspaces = sqliteTable(
  'workspaces',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    /**
     * The name with its case folded away, written beside the name itself. The
     * unique index below is its only reader: the handler that asks whether a
     * name is taken folds the *names* it already has in hand instead, because
     * a row can hold a stale folded copy or none at all (see migration 0005,
     * and the comment where that question is asked in
     * src/http/command-service.ts).
     *
     * It exists because SQLite's `lower()` folds `A`-`Z` and nothing else, and
     * D1 carries no ICU extension, so `Réunions` and `réunions` were two
     * different workspaces you could not tell apart in the tabs ("Workspace
     * names are only case-insensitive in ASCII", issue 91). Folding happens in
     * the application, where the whole of Unicode is available; `foldName` in
     * src/domain/workspaces.ts is the one function that does it.
     *
     * `NOT NULL DEFAULT ''` rather than nullable, and that default is
     * load-bearing: for the length of the deploy that follows migration 0005,
     * old code is still writing rows and knows nothing about this column. A
     * NULL would slip through the unique index - NULLs never collide - and let
     * that code create a duplicate name. An empty string collides with the
     * next one, which is the loud failure this wants.
     */
    foldedName: text('folded_name').notNull().default(''),
    /**
     * Read by nothing - no URL, no CSS selector, no component - and dropped by
     * "Drop the unused workspace slug column" (issue 78). It cannot go in the
     * same release that stopped reading it: migrations only roll forward, so
     * promoting an earlier commit runs old code against the new schema, and
     * that old code still selects this column (deployment, "Migrations and
     * rollback"). Until then it is written, never read, and holds the
     * workspace's own id.
     */
    slug: text('slug').notNull(),
    color: text('color').notNull(),
    createdAt: text('created_at').notNull(),
    /**
     * Tombstone. Deleting a workspace sets it and leaves everything filed in
     * that workspace exactly where it is, because the router learns from the
     * whole history of where things were actually filed and erasing a
     * workspace would erase that signal with it.
     *
     * Deliberately carrying **no** CHECK, unlike every
     * other timestamp column here, and that is a measured limitation rather
     * than an oversight: SQLite cannot ALTER a CHECK into an existing table,
     * and D1 refuses to drop a table that has children under ON DELETE
     * RESTRICT - `PRAGMA foreign_keys = OFF` is accepted and ignored. Adding
     * one therefore means rebuilding `workspaces`, `items` and `associations`
     * together, which is a whole-schema rebuild for a single constraint, and
     * a far larger risk than the constraint removes. See the note in
     * migration 0002.
     */
    deletedAt: text('deleted_at'),
  },
  (t) => [
    /**
     * Uniqueness is on the *name*, because the name is what a person types and
     * reads; the slug index it replaced guarded a column nothing looks at.
     *
     * Partial and case-insensitive, which is two decisions:
     * - on `folded_name`, so `Personal` and `personal` are the same name - and
     *   so are `ÉTÉ` and `été`, which `lower(name)` in SQL could not manage
     *   (see the column). Names arrive already trimmed, from the wire schema.
     * - `WHERE deleted_at IS NULL`, so deleting a workspace gives its name
     *   back. A tombstoned workspace keeps its name for the record without
     *   holding it hostage.
     *
     * This index is the lock behind the check, not the answer itself: nothing
     * reads `folded_name` to decide whether a name is taken, so it only
     * catches what a concurrent write gets past. Both writers of a name -
     * creating here and renaming in "Rename and delete a workspace" (issue 77)
     * - fold through the same `foldName`, and this index is what keeps a race
     * between them from producing two rows with the same folded name.
     *
     * Migration 0005 makes the swap, and carries the answers to what happens
     * when it meets two workspaces already named the same; 0004 is the column
     * it reads, alone in its own file because `ADD COLUMN` cannot be re-run.
     */
    uniqueIndex('workspaces_tenant_live_folded_name')
      .on(t.tenantId, t.foldedName)
      .where(sql`${t.deletedAt} IS NULL`),
    check('workspaces_created_at_is_timestamp', isTimestamp('created_at')),
  ],
);

export const items = sqliteTable(
  'items',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'restrict' }),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'restrict' }),

    // -- source-owned columns --
    source: text('source').$type<Source>().notNull(),
    sourceId: text('source_id'),
    sourceLink: text('source_link'),
    sender: text('sender'),
    sourceTimestamp: text('source_timestamp'),
    title: text('title').notNull(),
    preview: text('preview'),
    sourceResolvedAt: text('source_resolved_at'),

    // -- app-owned columns --
    status: text('status').$type<ItemStatus>().notNull(),
    nextAction: text('next_action'),
    focusHorizon: text('focus_horizon').$type<FocusHorizon>(),
    priority: text('priority').$type<Priority>(),
    dueDate: text('due_date'),
    snoozedUntil: text('snoozed_until'),
    unseen: integer('unseen', { mode: 'boolean' }).notNull().default(false),
    deletedAt: text('deleted_at'),

    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    index('items_tenant_workspace_status').on(t.tenantId, t.workspaceId, t.status),
    check('items_source_is_known', oneOf('source', sourceSchema.options)),
    check('items_status_is_known', oneOf('status', itemStatusSchema.options)),
    check('items_focus_horizon_is_known', oneOf('focus_horizon', focusHorizonSchema.options)),
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

export const associations = sqliteTable(
  'associations',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'restrict' }),
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
 * The command log (§4.3): idempotency check for retries and the audit trail.
 * command_id is the client-generated ID; a replayed command is a no-op.
 *
 * No foreign key on workspace_id or tenant_id: an audit trail has to outlive
 * whatever it refers to, which is the one place RESTRICT would be wrong.
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
