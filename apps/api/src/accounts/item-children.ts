import { and, eq, sql } from 'drizzle-orm';
import type { AccountDb } from './client.js';
import { DEAD_STATUS_VALUE, items, panelItems, panels } from './schema.js';

type InATransaction = Parameters<Parameters<AccountDb['transaction']>[0]>[0];

/**
 * Item inside Item ("Brainstorming: an Item can't hold other Items", issue
 * 1825): `putInside` and `takeOut` write the rows of an Item parent, and the
 * walk and lookups below read Items as parents only.
 *
 * **A Panel is never a parent** ("Brainstorming: a Panel is an Item nobody can
 * open", issue 1846), and what is filed on it is read from `panel_items`. The
 * release before reads filings from the rows under a Panel's own Item
 * ("Brainstorming: give every Panel an Item and store filings as Item-in-Item
 * relations", issue 1824), so the writes here still make, rename and dismiss
 * that Item and keep its rows and counts equal to `panel_items`, inside the
 * transaction of every change that moves them, for a rollback to lose nothing.
 */

/**
 * The Item a new Panel is, in the transaction that makes the Panel: the
 * Panel's id, title and Workspace, its texts settled. A replay that finds it
 * changes nothing.
 */
export function insertPanelsItem(
  tx: InATransaction,
  tenantId: string,
  panel: { id: string; name: string },
  workspaceId: string,
  at: string,
): void {
  tx.insert(items)
    .values({
      id: panel.id,
      tenantId,
      workspaceId,
      workspaceDecided: true,
      source: 'internal',
      title: panel.name,
      textsSettledAt: at,
      status: DEAD_STATUS_VALUE,
      createdAt: at,
      updatedAt: at,
    })
    .onConflictDoNothing({ target: items.id })
    .run();
}

/** A Panel's new title, written to its Item as well. */
export function renamePanelsItem(tx: InATransaction, tenantId: string, panelId: string, name: string, at: string): void {
  tx.run(sql`UPDATE items SET title = ${name}, updated_at = ${at}
              WHERE tenant_id = ${tenantId}
                AND id = (SELECT item_id FROM panels WHERE tenant_id = ${tenantId} AND id = ${panelId})`);
}

/**
 * The Items of Panels just deleted, dismissed with them - one Panel, or every
 * Panel of a deleted Dashboard - so a live Item never stands for a Panel that
 * is gone, as the backfill gives a deleted one none.
 */
export function dismissPanelsItems(
  tx: InATransaction,
  tenantId: string,
  of: { panelId: string } | { dashboardId: string },
  at: string,
): void {
  const which =
    'panelId' in of
      ? sql`SELECT item_id FROM panels WHERE tenant_id = ${tenantId} AND id = ${of.panelId}`
      : sql`SELECT item_id FROM panels WHERE tenant_id = ${tenantId} AND dashboard_id = ${of.dashboardId}`;
  tx.run(sql`UPDATE items SET deleted_at = ${at}, updated_at = ${at}
              WHERE tenant_id = ${tenantId} AND deleted_at IS NULL AND id IN (${which})`);
}

/** The Panels an Item is filed on now, read before a move takes it off them. */
export function panelsHolding(tx: InATransaction, tenantId: string, itemId: string): string[] {
  return tx
    .select({ panelId: panelItems.panelId })
    .from(panelItems)
    .where(and(eq(panelItems.tenantId, tenantId), eq(panelItems.itemId, itemId)))
    .all()
    .map((row) => row.panelId);
}

/**
 * Each Panel's Item made to hold exactly what is filed on the Panel, in its
 * order: what left is tombstoned, what arrived or came back is put in with
 * its place, and the Item's counts are counted again. Copied in SQL from the
 * Panel's own rows, so a Panel of any size is two statements and no batch.
 */
export function mirrorFilingsOf(tx: InATransaction, tenantId: string, panelIds: Iterable<string>, at: string): void {
  for (const panelId of new Set(panelIds)) {
    const holder = tx
      .select({ itemId: panels.itemId })
      .from(panels)
      .where(and(eq(panels.tenantId, tenantId), eq(panels.id, panelId)))
      .get()?.itemId;
    if (!holder) continue;
    tx.run(sql`UPDATE item_children SET deleted_at = ${at}
                WHERE tenant_id = ${tenantId} AND parent_id = ${holder} AND deleted_at IS NULL
                  AND NOT EXISTS (SELECT 1 FROM panel_items f
                                   WHERE f.tenant_id = ${tenantId} AND f.panel_id = ${panelId}
                                     AND f.item_id = item_children.child_id)`);
    tx.run(sql`INSERT INTO item_children (tenant_id, parent_id, child_id, position, created_at)
                SELECT f.tenant_id, ${holder}, f.item_id, f.position, ${at} FROM panel_items f
                 WHERE f.tenant_id = ${tenantId} AND f.panel_id = ${panelId}
                ON CONFLICT (parent_id, child_id) DO UPDATE SET
                  position = excluded.position,
                  created_at = CASE WHEN item_children.deleted_at IS NULL THEN item_children.created_at
                                    ELSE excluded.created_at END,
                  deleted_at = NULL`);
    tx.run(sql`UPDATE items SET ${COUNTS} WHERE tenant_id = ${tenantId} AND id = ${holder}`);
  }
}

/**
 * The counts of every Item holding this one, counted again after it was
 * finished, reopened, dismissed or restored - or written at all, which costs
 * one lookup by `item_children_tenant_child` where nothing holds it.
 */
export function recountHoldersOf(tx: InATransaction, tenantId: string, itemId: string): void {
  tx.run(sql`UPDATE items SET ${COUNTS}
              WHERE tenant_id = ${tenantId}
                AND id IN (SELECT parent_id FROM item_children
                            WHERE tenant_id = ${tenantId} AND child_id = ${itemId} AND deleted_at IS NULL)`);
}

/**
 * What an Item holds and how many of those are done: its live rows whose
 * Item is not dismissed, as `0109-panels-become-items` counts them.
 */
const COUNTS = sql.raw(`
  children_count = (SELECT count(*) FROM item_children c JOIN items k ON k.id = c.child_id
                     WHERE c.tenant_id = items.tenant_id AND c.parent_id = items.id
                       AND c.deleted_at IS NULL AND k.deleted_at IS NULL),
  children_done = (SELECT count(*) FROM item_children c JOIN items k ON k.id = c.child_id
                    WHERE c.tenant_id = items.tenant_id AND c.parent_id = items.id
                      AND c.deleted_at IS NULL AND k.deleted_at IS NULL AND k.completed_at IS NOT NULL)`);

/**
 * Items put inside an Item at the end of its order ("Brainstorming: an Item
 * can't hold other Items", issue 1825), in the transaction of `add_children`:
 * one already inside it keeps its place, one taken out before comes back, and
 * the parent's counts are counted again. Never a Panel's own Item as parent:
 * a Panel is no parent, and filing is its own change.
 */
export function putInside(tx: InATransaction, tenantId: string, parentId: string, childIds: readonly string[], at: string): void {
  const last = tx.get<{ last: number | null }>(sql`SELECT max(position) AS last FROM item_children
                                                    WHERE tenant_id = ${tenantId} AND parent_id = ${parentId}
                                                      AND deleted_at IS NULL`);
  let position = (last?.last ?? -1) + 1;
  for (const childId of childIds) {
    tx.run(sql`INSERT INTO item_children (tenant_id, parent_id, child_id, position, created_at)
                VALUES (${tenantId}, ${parentId}, ${childId}, ${position}, ${at})
                ON CONFLICT (parent_id, child_id) DO UPDATE SET
                  position = excluded.position, created_at = excluded.created_at, deleted_at = NULL
                WHERE item_children.deleted_at IS NOT NULL`);
    position += 1;
  }
  recount(tx, tenantId, parentId);
}

/** One Item taken out of one parent, which keeps the places of the rest, and the parent counted again. */
export function takeOut(tx: InATransaction, tenantId: string, parentId: string, childId: string, at: string): void {
  tx.run(sql`UPDATE item_children SET deleted_at = ${at}
              WHERE tenant_id = ${tenantId} AND parent_id = ${parentId} AND child_id = ${childId}
                AND deleted_at IS NULL`);
  recount(tx, tenantId, parentId);
}

/**
 * Which of these Items the parent already sits inside, however deep: putting
 * one of them in it would make an Item its own ancestor. Walks up from the
 * parent by `item_children_tenant_child`, one row per level, through Items
 * alone: a Panel is never a parent (issue 1846).
 */
export function ancestorsAmong(db: AccountDb, tenantId: string, parentId: string, childIds: readonly string[]): string[] {
  if (childIds.length === 0) return [];
  const candidates = sql.join(
    childIds.map((id) => sql`${id}`),
    sql`, `,
  );
  return db
    .all<{ id: string }>(sql`WITH RECURSIVE up(id) AS (
                               SELECT ${parentId}
                               UNION
                               SELECT c.parent_id FROM item_children c JOIN up ON c.child_id = up.id
                                WHERE c.tenant_id = ${tenantId} AND c.deleted_at IS NULL
                                  AND NOT EXISTS (SELECT 1 FROM panels WHERE panels.item_id = c.parent_id))
                             SELECT id FROM up WHERE id IN (${candidates})`)
    .map((row) => row.id);
}

/** Whether a live row has this Item inside that one: what a take-out needs to find to change anything. */
export function isInside(db: AccountDb, tenantId: string, parentId: string, childId: string): boolean {
  return (
    db.get<{ one: number }>(sql`SELECT 1 AS one FROM item_children
                                 WHERE tenant_id = ${tenantId} AND parent_id = ${parentId} AND child_id = ${childId}
                                   AND deleted_at IS NULL`) !== undefined
  );
}

function recount(tx: InATransaction, tenantId: string, itemId: string): void {
  tx.run(sql`UPDATE items SET ${COUNTS} WHERE tenant_id = ${tenantId} AND id = ${itemId}`);
}

/**
 * The Panels any of these Items is filed on, each once, in the order they are
 * met: where a Merge files the Item it makes ("Brainstorming: related loose
 * notes can't be brought together", issue 1826).
 */
export function panelsHeldBy(db: AccountDb, tenantId: string, itemIds: readonly string[]): string[] {
  const found: string[] = [];
  for (const itemId of itemIds) {
    const rows = db.all<{ panel_id: string }>(
      sql`SELECT panel_id FROM panel_items WHERE tenant_id = ${tenantId} AND item_id = ${itemId} ORDER BY created_at, panel_id`,
    );
    for (const row of rows) if (!found.includes(row.panel_id)) found.push(row.panel_id);
  }
  return found;
}

/**
 * The Items that hold any of these, each once: a Merge's Item goes inside every
 * one its originals were inside. A Panel's own Item is no parent: the Merge
 * files its Item where the originals were filed (`panelsHeldBy`).
 */
export function itemParentsHolding(db: AccountDb, tenantId: string, itemIds: readonly string[]): string[] {
  const found: string[] = [];
  for (const itemId of itemIds) {
    const rows = db.all<{ parent_id: string }>(
      sql`SELECT c.parent_id FROM item_children c JOIN items p ON p.id = c.parent_id
           WHERE c.tenant_id = ${tenantId} AND c.child_id = ${itemId} AND c.deleted_at IS NULL
             AND p.deleted_at IS NULL
             AND NOT EXISTS (SELECT 1 FROM panels WHERE tenant_id = ${tenantId} AND item_id = c.parent_id)
           ORDER BY c.created_at, c.parent_id`,
    );
    for (const row of rows) if (!found.includes(row.parent_id)) found.push(row.parent_id);
  }
  return found;
}

/**
 * The live Items the given Items hold, each once, in the order held: what a
 * Merge hands to the Item that replaces them, so their children are not left
 * held by nothing.
 */
export function itemChildrenHeldBy(db: AccountDb, tenantId: string, parentIds: readonly string[]): string[] {
  const found: string[] = [];
  for (const parentId of parentIds) {
    const rows = db.all<{ child_id: string }>(
      sql`SELECT c.child_id FROM item_children c JOIN items k ON k.id = c.child_id
           WHERE c.tenant_id = ${tenantId} AND c.parent_id = ${parentId} AND c.deleted_at IS NULL
             AND k.deleted_at IS NULL
           ORDER BY c.created_at, c.child_id`,
    );
    for (const row of rows) if (!found.includes(row.child_id)) found.push(row.child_id);
  }
  return found;
}
