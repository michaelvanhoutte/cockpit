import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import type { AssociationKind, FocusHorizon, ItemStatus, Priority, Source } from '@cockpit/shared';

/**
 * Schema conventions (architecture §4.2), binding from the first migration:
 * - tenant_id on every row, non-null, even while there is exactly one tenant;
 * - client-generated IDs (UUIDv7) as text primary keys;
 * - tombstones, not deletes (deleted_at / source_resolved_at);
 * - source-owned vs app-owned columns are separate groups on items:
 *   re-syncs overwrite source-owned columns unconditionally, never app-owned.
 * Timestamps are ISO-8601 text; dates are YYYY-MM-DD text.
 */

export const tenants = sqliteTable('tenants', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  createdAt: text('created_at').notNull(),
});

export const workspaces = sqliteTable(
  'workspaces',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    color: text('color').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [uniqueIndex('workspaces_tenant_slug').on(t.tenantId, t.slug)],
);

export const items = sqliteTable(
  'items',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    workspaceId: text('workspace_id').notNull(),

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
  (t) => [index('items_tenant_workspace_status').on(t.tenantId, t.workspaceId, t.status)],
);

export const associations = sqliteTable(
  'associations',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    itemId: text('item_id').notNull(),
    kind: text('kind').$type<AssociationKind>().notNull(),
    label: text('label').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('associations_tenant_item').on(t.tenantId, t.itemId)],
);

/**
 * The command log (§4.3): idempotency check for retries and the audit trail.
 * command_id is the client-generated ID; a replayed command is a no-op.
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
  (t) => [index('commands_tenant_received').on(t.tenantId, t.receivedAt)],
);
