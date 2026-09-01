import { and, eq, isNull, ne } from 'drizzle-orm';
import type { Association, Item, Workspace } from '@cockpit/shared';
import type { Db } from './client.js';
import { associations, commands, items, workspaces } from './schema.js';

/**
 * Repositories: the only place queries live. Every query filters on tenant_id
 * (architecture §8: workspace scoping is enforced server-side, the UI's
 * scoping is presentation, not protection).
 */

/**
 * The columns a workspace is read by: exactly the wire shape, named one by one.
 *
 * **Spelled out rather than left to a bare `select()`, and that is the whole
 * point of it.** Drizzle builds a bare `select()`'s field list from every
 * column declared on the table, so the SQL it sends names each one - including
 * the ones this service has no use for. Measured, not assumed: it emitted
 * `select "id", "tenant_id", "name", "folded_name", "slug", "color",
 * "created_at", "deleted_at" from "workspaces"`.
 *
 * That is what makes dropping a column a two-release job rather than one, and
 * naming the columns here is the first of those releases. A column this list
 * does not mention can be dropped by a later release without the code running
 * at that moment - which is this one - ever noticing. Drop one out from under a
 * bare `select()` and every read of the table fails instead, which is not a
 * degraded workspace list: it is no page at all.
 *
 * So: add a column here only when something reads it, and take it out one
 * release before the migration that drops it. The rule has a test -
 * "a workspace is read by the columns it is read by" in
 * tests/integration/db/workspace-reads.test.ts - which drops a column nothing
 * needs and asks for a workspace anyway.
 */
const workspaceColumns = {
  id: workspaces.id,
  tenantId: workspaces.tenantId,
  name: workspaces.name,
  color: workspaces.color,
};

/** A deleted workspace is tombstoned, so every read of one filters it out. */
const live = (tenantId: string) =>
  and(eq(workspaces.tenantId, tenantId), isNull(workspaces.deletedAt));

export async function listWorkspaces(db: Db, tenantId: string): Promise<Workspace[]> {
  return db
    .select(workspaceColumns)
    .from(workspaces)
    .where(live(tenantId))
    .orderBy(workspaces.createdAt);
}

export async function getWorkspace(
  db: Db,
  tenantId: string,
  workspaceId: string,
): Promise<Workspace | null> {
  const rows = await db
    .select(workspaceColumns)
    .from(workspaces)
    .where(and(live(tenantId), eq(workspaces.id, workspaceId)));
  return rows[0] ?? null;
}

/** Open items: tombstoned rows stay in the database but never in the snapshot. */
export async function listOpenItems(
  db: Db,
  tenantId: string,
  workspaceId: string,
): Promise<Item[]> {
  return db
    .select()
    .from(items)
    .where(
      and(
        eq(items.tenantId, tenantId),
        eq(items.workspaceId, workspaceId),
        isNull(items.deletedAt),
        ne(items.status, 'dismissed'),
      ),
    )
    .orderBy(items.createdAt);
}

export async function getItem(db: Db, tenantId: string, itemId: string): Promise<Item | null> {
  const rows = await db
    .select()
    .from(items)
    .where(and(eq(items.tenantId, tenantId), eq(items.id, itemId)));
  return rows[0] ?? null;
}

export async function listAssociationsForWorkspace(
  db: Db,
  tenantId: string,
  workspaceId: string,
): Promise<Association[]> {
  const rows = await db
    .select({
      id: associations.id,
      tenantId: associations.tenantId,
      itemId: associations.itemId,
      kind: associations.kind,
      label: associations.label,
      createdAt: associations.createdAt,
    })
    .from(associations)
    .innerJoin(items, eq(associations.itemId, items.id))
    .where(and(eq(associations.tenantId, tenantId), eq(items.workspaceId, workspaceId)));
  return rows;
}

export async function commandAlreadyApplied(db: Db, commandId: string): Promise<boolean> {
  const rows = await db.select().from(commands).where(eq(commands.commandId, commandId));
  return rows.length > 0;
}
