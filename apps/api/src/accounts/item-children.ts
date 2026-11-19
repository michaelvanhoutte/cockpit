import { and, eq, sql } from 'drizzle-orm';
import type { AccountDb } from './client.js';
import { DEAD_STATUS_VALUE, items, panelItems, panels } from './schema.js';

type InATransaction = Parameters<Parameters<AccountDb['transaction']>[0]>[0];

/**
 * Every Panel is an Item, and what is filed on it is also what its Item holds
 * ("Brainstorming: give every Panel an Item and store filings as Item-in-Item
 * relations", issue 1824). The writes that keep `item_children` and the counts
 * equal to `panel_items`, each called inside the transaction of the change
 * that moves them, so the two tables never disagree. Reads still come from
 * `panel_items`; the backfill that brought existing Panels here is
 * `0109-panels-become-items` (changes.ts).
 *
 * **A Panel the backfill has not reached holds nothing here**: one an older
 * Worker made during the rollout has no Item, so its filings are left to the
 * switch's copy step (issue 1825) rather than given a holder here.
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
