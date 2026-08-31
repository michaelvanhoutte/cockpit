import { and, eq, isNull, ne, sql } from 'drizzle-orm';
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
 * The wire shape of a workspace, from the row. `slug` and the bookkeeping
 * columns are dropped here rather than being selected around, so there is one
 * place to change when "Drop the unused workspace slug column" (issue 78)
 * removes it.
 */
function asWorkspace(row: typeof workspaces.$inferSelect): Workspace {
  return { id: row.id, tenantId: row.tenantId, name: row.name, color: row.color };
}

/** A deleted workspace is tombstoned, so every read of one filters it out. */
const live = (tenantId: string) =>
  and(eq(workspaces.tenantId, tenantId), isNull(workspaces.deletedAt));

export function listWorkspaces(db: AccountDb, tenantId: string): Workspace[] {
  return db
    .select()
    .from(workspaces)
    .where(live(tenantId))
    .orderBy(workspaces.createdAt)
    .all()
    .map(asWorkspace);
}

export function getWorkspace(
  db: AccountDb,
  tenantId: string,
  workspaceId: string,
): Workspace | null {
  const row = db
    .select()
    .from(workspaces)
    .where(and(live(tenantId), eq(workspaces.id, workspaceId)))
    .get();
  return row ? asWorkspace(row) : null;
}

/**
 * The live workspace already going by this name, compared the way the unique
 * index compares it, or null. Asked before the insert rather than left to the
 * index for the same reason a capture checks its workspace exists: the
 * constraint would surface as a 500, and a name already in use is something to
 * say out loud. The index is still the lock behind this one.
 *
 * It returns the *stored* name rather than a yes or no so the refusal can name
 * what is actually on screen. Someone typing `work` against a workspace called
 * `Work` is told about `Work`, not told that "work already exists" next to a
 * tab that plainly says something else.
 */
export function liveWorkspaceNamed(db: AccountDb, tenantId: string, name: string): string | null {
  const row = db
    .select({ name: workspaces.name })
    .from(workspaces)
    .where(and(live(tenantId), sql`lower(${workspaces.name}) = lower(${name})`))
    .get();
  return row?.name ?? null;
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
