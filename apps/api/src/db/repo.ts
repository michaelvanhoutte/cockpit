import { and, eq, isNull, ne, sql } from 'drizzle-orm';
import type { Association, Item, Workspace } from '@cockpit/shared';
import type { Db } from './client.js';
import { associations, commands, items, workspaces } from './schema.js';

/**
 * Repositories: the only place queries live. Every query filters on tenant_id
 * (architecture §8: workspace scoping is enforced server-side, the UI's
 * scoping is presentation, not protection).
 */

/**
 * The wire shape of a workspace, from the row. `slug` and the bookkeeping
 * columns are dropped here rather than being selected around, so there is one
 * place to change when issue 78 removes the column.
 */
function asWorkspace(row: typeof workspaces.$inferSelect): Workspace {
  return { id: row.id, tenantId: row.tenantId, name: row.name, color: row.color };
}

/** A deleted workspace is tombstoned, so every read of one filters it out. */
const live = (tenantId: string) =>
  and(eq(workspaces.tenantId, tenantId), isNull(workspaces.deletedAt));

export async function listWorkspaces(db: Db, tenantId: string): Promise<Workspace[]> {
  const rows = await db
    .select()
    .from(workspaces)
    .where(live(tenantId))
    .orderBy(workspaces.createdAt);
  return rows.map(asWorkspace);
}

export async function getWorkspace(
  db: Db,
  tenantId: string,
  workspaceId: string,
): Promise<Workspace | null> {
  const rows = await db
    .select()
    .from(workspaces)
    .where(and(live(tenantId), eq(workspaces.id, workspaceId)));
  const row = rows[0];
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
export async function liveWorkspaceNamed(
  db: Db,
  tenantId: string,
  name: string,
): Promise<string | null> {
  const rows = await db
    .select({ name: workspaces.name })
    .from(workspaces)
    .where(and(live(tenantId), sql`lower(${workspaces.name}) = lower(${name})`));
  return rows[0]?.name ?? null;
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
