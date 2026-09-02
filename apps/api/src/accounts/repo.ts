import { and, eq, isNull, max, ne } from 'drizzle-orm';
import type { Association, Dashboard, Item, Workspace } from '@cockpit/shared';
import type { AccountDb } from './client.js';
import { associations, commands, dashboards, items, workspaces } from './schema.js';

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
  bar: workspaces.bar,
  ground: workspaces.ground,
  header: workspaces.header,
};

/** A deleted workspace is tombstoned, so every read of one filters it out. */
const live = (tenantId: string) =>
  and(eq(workspaces.tenantId, tenantId), isNull(workspaces.deletedAt));

/**
 * Every live workspace, in the order they sit in the tabs ("Reorder
 * workspaces", issue 31).
 *
 * The order is carried by the array and not by a field of it, which is why
 * `position` is absent from the columns above and named here instead: nothing
 * outside this ordering reads it, and a client that had it would only be able
 * to get it wrong. `created_at` breaks a tie, so two workspaces that somehow
 * share a position are still in a stable order rather than whichever one
 * SQLite reaches first.
 *
 * `position` is therefore a column this file *reads*, unlike `folded_name`, and
 * the two-release rule in the comment above applies to it in full: taking it
 * out from under this ORDER BY is a failed read, not a degraded one. A
 * qualified `"workspaces"."position"` raises "no such column" rather than
 * falling back to a string literal the way a bare quoted name does.
 */
export function listWorkspaces(db: AccountDb, tenantId: string): Workspace[] {
  return db
    .select(workspaceColumns)
    .from(workspaces)
    .where(live(tenantId))
    .orderBy(workspaces.position, workspaces.createdAt)
    .all();
}

/**
 * The highest position any of this account's workspaces holds, or null when it
 * has none at all - so a new one can be put after every workspace there is.
 *
 * Deleted workspaces count. They are filtered out of every read, so reusing
 * their positions would be harmless; not reusing them is one fewer thing to
 * hold in mind, and it keeps the numbers of an account's workspaces telling the
 * truth about the order they were in.
 */
export function lastWorkspacePosition(db: AccountDb, tenantId: string): number | null {
  const row = db
    .select({ highest: max(workspaces.position) })
    .from(workspaces)
    .where(eq(workspaces.tenantId, tenantId))
    .get();
  return row?.highest ?? null;
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

/**
 * The columns a dashboard is read by, named one by one for the reason the
 * workspace ones are: a bare `select()` names every column of the table, which
 * makes dropping one a two-release job. `folded_name` is deliberately not among
 * them - nothing outside the index reads it.
 */
const dashboardColumns = {
  id: dashboards.id,
  tenantId: dashboards.tenantId,
  workspaceId: dashboards.workspaceId,
  name: dashboards.name,
};

/**
 * A workspace's dashboards, oldest first, which is the order they sit in the
 * bar. Tombstoned ones are left out the way tombstoned workspaces are.
 */
export function listDashboards(
  db: AccountDb,
  tenantId: string,
  workspaceId: string,
): Dashboard[] {
  return db
    .select(dashboardColumns)
    .from(dashboards)
    .where(
      and(
        eq(dashboards.tenantId, tenantId),
        eq(dashboards.workspaceId, workspaceId),
        isNull(dashboards.deletedAt),
      ),
    )
    .orderBy(dashboards.createdAt)
    .all();
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
