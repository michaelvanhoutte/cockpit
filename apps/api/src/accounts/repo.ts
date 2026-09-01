import { and, eq, isNull, ne } from 'drizzle-orm';
import type { Association, Item, Workspace } from '@cockpit/shared';
import type { AccountDb } from './client.js';
import { associations, commands, items, workspaces } from './schema.js';

/**
 * Repositories: the only place queries live. Every query filters on tenant_id
 * (architecture, "Security": workspace scoping is enforced server-side, the
 * UI's scoping is presentation, not protection).
 *
 * The filter is not redundant now that a store holds exactly one account. It is
 * what turns a request that reached the wrong store into no rows rather than
 * somebody else's items - see "One store per account, and `tenant_id` stays".
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
 * tests/integration/accounts/workspace-reads.test.ts - which drops a column nothing
 * needs and asks for a workspace anyway.
 */
const workspaceColumns = {
  id: workspaces.id,
  tenantId: workspaces.tenantId,
  name: workspaces.name,
  color: workspaces.color,
  ground: workspaces.ground,
  header: workspaces.header,
};

/** A deleted workspace is tombstoned, so every read of one filters it out. */
const live = (tenantId: string) =>
  and(eq(workspaces.tenantId, tenantId), isNull(workspaces.deletedAt));

export function listWorkspaces(db: AccountDb, tenantId: string): Workspace[] {
  return db
    .select(workspaceColumns)
    .from(workspaces)
    .where(live(tenantId))
    .orderBy(workspaces.createdAt)
    .all();
}

export function getWorkspace(
  db: AccountDb,
  tenantId: string,
  workspaceId: string,
): Workspace | null {
  return (
    db
      .select(workspaceColumns)
      .from(workspaces)
      .where(and(live(tenantId), eq(workspaces.id, workspaceId)))
      .get() ?? null
  );
}

/** Open items: tombstoned rows stay in the store but never in the snapshot. */
export function listOpenItems(db: AccountDb, tenantId: string, workspaceId: string): Item[] {
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
    .orderBy(items.createdAt)
    .all();
}

export function getItem(db: AccountDb, tenantId: string, itemId: string): Item | null {
  return (
    db
      .select()
      .from(items)
      .where(and(eq(items.tenantId, tenantId), eq(items.id, itemId)))
      .get() ?? null
  );
}

export function listAssociationsForWorkspace(
  db: AccountDb,
  tenantId: string,
  workspaceId: string,
): Association[] {
  return db
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
    .where(and(eq(associations.tenantId, tenantId), eq(items.workspaceId, workspaceId)))
    .all();
}

export function commandAlreadyApplied(db: AccountDb, commandId: string): boolean {
  return db.select().from(commands).where(eq(commands.commandId, commandId)).all().length > 0;
}
