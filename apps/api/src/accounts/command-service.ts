import { and, eq } from 'drizzle-orm';
import type { CommandName, CommandPayload, CommandResult } from '@cockpit/shared';
import type { AccountDb } from './client.js';
import {
  associations,
  commands,
  dashboards,
  DEAD_STATUS_VALUE,
  items,
  itemTypes,
  layouts,
  panelItems,
  panelPlacements,
  panels,
  workspaces,
} from './schema.js';
import {
  commandAlreadyApplied,
  getDashboard,
  getItem,
  getItemType,
  getLayout,
  getPanel,
  getWorkspace,
  lastWorkspacePosition,
  listDashboards,
  lastItemTypePosition,
  listFilingsOnPanel,
  listItemTypes,
  listLayoutIds,
  listPanels,
  listPlacements,
  listWorkspaces,
} from './repo.js';
import { isPaletteTheme } from '@cockpit/shared';
import { foldName } from '../domain/names.js';
import {
  dashboardFromCommand,
  dashboardNamed,
  firstDashboardFor,
} from '../domain/dashboards.js';
import { filingRows, orderIsNotOfThePanel, type Arriving } from '../domain/filings.js';
import {
  appendedPlacement,
  panelFromCommand,
  panelNamed,
  panelsNotOn,
  placementBatches,
  placementRows,
} from '../domain/panels.js';
import {
  nextColor,
  nextPosition,
  ordersExactly,
  workspaceFromCommand,
  workspaceNamed,
} from '../domain/workspaces.js';
import {
  itemTypeFromCommand,
  itemTypeNamed,
  ordersTypesExactly,
} from '../domain/item-types.js';
import {
  applySetDismissed,
  applySetDone,
  applySetNextAction,
  applySetPriority,
  associationFromCommand,
  captureItem,
} from '../domain/items.js';

export class ItemTypeNotFoundError extends Error {
  constructor(typeId: string) {
    super(`item type ${typeId} not found`);
    this.name = 'ItemTypeNotFoundError';
  }
}

/**
 * Its own kind rather than the workspace one, for the reason the dashboard one
 * is: the message is what a person reads, and it has to name the thing that is
 * actually in the way.
 */
export class ItemTypeNameTakenError extends Error {
  constructor(name: string) {
    super(`a type called ${name} already exists`);
    this.name = 'ItemTypeNameTakenError';
  }
}

/** The same collision `WorkspaceOrderStaleError` names, one list along. */
export class ItemTypeOrderStaleError extends Error {
  constructor() {
    super('the types changed while they were being put in order');
    this.name = 'ItemTypeOrderStaleError';
  }
}

export class ItemNotFoundError extends Error {
  constructor(itemId: string) {
    super(`item ${itemId} not found`);
    this.name = 'ItemNotFoundError';
  }
}

export class WorkspaceNotFoundError extends Error {
  constructor(workspaceId: string) {
    super(`workspace ${workspaceId} not found`);
    this.name = 'WorkspaceNotFoundError';
  }
}

/**
 * A theme that is not one of the palette's. Its own kind because it is a 400,
 * not a 404 or a 409: the request names a workspace that exists and asks for
 * colors that are simply not on offer.
 */
export class UnknownThemeError extends Error {
  constructor() {
    super('that is not one of the themes');
    this.name = 'UnknownThemeError';
  }
}

export class WorkspaceNameTakenError extends Error {
  constructor(name: string) {
    super(`a workspace called ${name} already exists`);
    this.name = 'WorkspaceNameTakenError';
  }
}

/**
 * An order of workspaces that are no longer the account's workspaces - one was
 * made or deleted in another tab while this one was being put in order.
 *
 * A collision rather than a missing thing, so it is a 409: nothing the request
 * names is necessarily gone, the list as a whole is simply about a state of the
 * account that has moved on. The message says what to do about it, because the
 * page will have the current list a moment later and the move can be made again.
 */
export class WorkspaceOrderStaleError extends Error {
  constructor() {
    super('the workspaces changed while they were being put in order');
    this.name = 'WorkspaceOrderStaleError';
  }
}

export class DashboardNotFoundError extends Error {
  constructor(dashboardId: string) {
    super(`dashboard ${dashboardId} not found`);
    this.name = 'DashboardNotFoundError';
  }
}

/**
 * The one delete Cockpit refuses, and a deliberate exception rather than an
 * oversight: deleting the last *workspace* is allowed because the app can offer
 * to make one, while a workspace with no dashboards has no view at all and
 * every screen would grow a permanent branch for it ("Rename and delete a
 * dashboard from a dashboard settings page", issue 90).
 */
export class LastDashboardError extends Error {
  constructor() {
    super('a workspace keeps at least one dashboard');
    this.name = 'LastDashboardError';
  }
}

/**
 * Its own kind rather than the workspace one, because the message is what a
 * person reads and "a workspace called Research already exists" next to a bar
 * of dashboards names the wrong thing entirely.
 */
export class DashboardNameTakenError extends Error {
  constructor(name: string) {
    super(`a dashboard called ${name} already exists in this workspace`);
    this.name = 'DashboardNameTakenError';
  }
}

/**
 * A panel that is not on the dashboard the change is about - deleted a moment
 * ago, belonging to another dashboard, or never real. One kind for all three,
 * because the answer to the person is the same sentence.
 */
export class PanelNotFoundError extends Error {
  constructor(panelId: string) {
    super(`panel ${panelId} is not on this dashboard`);
    this.name = 'PanelNotFoundError';
  }
}

/**
 * Its own kind rather than the dashboard one, for the reason that one is not
 * the workspace one: the message is what a person reads, and it has to name the
 * thing that is actually in the way.
 */
export class PanelNameTakenError extends Error {
  constructor(name: string) {
    super(`a panel called ${name} is already on this dashboard`);
    this.name = 'PanelNameTakenError';
  }
}

/** A layout that is not this dashboard's - gone, or never this dashboard's to begin with. */
export class LayoutNotFoundError extends Error {
  constructor(layoutId: string) {
    super(`layout ${layoutId} is not on this dashboard`);
    this.name = 'LayoutNotFoundError';
  }
}

/**
 * An order that is not this panel's arrangement - it leaves out an item the
 * panel holds, or names one that is not on it. A conflict rather than a shape
 * problem: the request is well formed and every id in it is real, and what has
 * collided is a list against a panel that has moved on.
 */
export class PanelOrderStaleError extends Error {
  constructor(why: string) {
    super(why);
    this.name = 'PanelOrderStaleError';
  }
}

/**
 * The dashboard a panel change is about, or the refusal that ends it.
 *
 * Both steps are here rather than repeated in each handler, and both are
 * load-bearing. The workspace is checked first because it is what the envelope
 * names and the answer for an unknown one is about the workspace; the dashboard
 * is then looked up *inside* that workspace, so a request naming a real
 * dashboard of a different workspace is a 404 rather than a change applied
 * somewhere the caller was not looking.
 */
function dashboardTheChangeIsAbout(
  db: AccountDb,
  tenantId: string,
  workspaceId: string,
  dashboardId: string,
) {
  if (!getWorkspace(db, tenantId, workspaceId)) throw new WorkspaceNotFoundError(workspaceId);
  const dashboard = getDashboard(db, tenantId, workspaceId, dashboardId);
  if (!dashboard) throw new DashboardNotFoundError(dashboardId);
  return dashboard;
}

/**
 * The panel a change names, checked all the way up: it is live, its dashboard
 * is live, and that dashboard is in the workspace the envelope names. A panel
 * is addressed by its own id alone, so without the last step a change could
 * reach across the account into a workspace the caller never opened.
 */
function panelTheChangeIsAbout(
  db: AccountDb,
  tenantId: string,
  workspaceId: string,
  panelId: string,
) {
  if (!getWorkspace(db, tenantId, workspaceId)) throw new WorkspaceNotFoundError(workspaceId);
  const panel = getPanel(db, tenantId, panelId);
  if (!panel) throw new PanelNotFoundError(panelId);
  if (!getDashboard(db, tenantId, workspaceId, panel.dashboardId)) {
    throw new PanelNotFoundError(panelId);
  }
  return panel;
}

/**
 * Refuses an order that is not the panel's arrangement, in the words the person
 * who sent it is shown. Both commands that carry an order ask it, because it is
 * the same question about the same rows.
 */
function refuseAStaleOrder(db: AccountDb, tenantId: string, cmd: Arriving & { panelId: string }): void {
  const stale = orderIsNotOfThePanel(listFilingsOnPanel(db, tenantId, cmd.panelId), cmd);
  if (stale) throw new PanelOrderStaleError(stale);
}

/**
 * The one write path (architecture, "Mutations are commands, not object
 * PUTs"): idempotency check on the client-generated command ID, pure domain
 * handler, then the data change and the command-log entry written inside one
 * transaction of the account's own store.
 *
 * Synchronous throughout, and deliberately: `db.transaction` on a Durable
 * Object's SQLite is `ctx.storage.transactionSync`, which commits when its
 * callback returns. An `await` inside it would commit the transaction before
 * the work it wraps had happened. See `client.ts`.
 */
export function runCommand<N extends CommandName>(
  db: AccountDb,
  tenantId: string,
  name: N,
  payload: CommandPayload<N>,
): CommandResult {
  if (commandAlreadyApplied(db, payload.commandId)) {
    return { ok: true, applied: false };
  }

  const commandRow = {
    commandId: payload.commandId,
    tenantId,
    workspaceId: payload.workspaceId,
    name,
    payload: JSON.stringify(payload),
    issuedAt: payload.issuedAt,
    receivedAt: new Date().toISOString(),
  };

  let applied = true;

  switch (name) {
    case 'create_workspace': {
      const cmd = payload as CommandPayload<'create_workspace'>;
      // One list, two questions: which colors are taken, and whether the name
      // is. The color is a function of the whole set, so it is picked here
      // rather than by the client, whose copy of that set can be stale.
      const existing = listWorkspaces(db, tenantId);
      // `workspaceNamed` is the one place a name is compared, for creating and
      // for renaming alike, and its own comment says why it folds the names it
      // is handed rather than reading the folded column.
      const alreadyCalledThat = workspaceNamed(existing, cmd.name);
      if (alreadyCalledThat) throw new WorkspaceNameTakenError(alreadyCalledThat.name);
      // The position comes from its own query rather than from `existing`,
      // because it is decided against every workspace the account has ever had
      // and `existing` is the live ones - a new workspace goes after a deleted
      // one's place rather than into it.
      const workspace = workspaceFromCommand(
        cmd,
        tenantId,
        nextColor(existing.map((w) => w.color)),
        nextPosition(lastWorkspacePosition(db, tenantId)),
      );
      // A retried create whose command ID was lost still may not make a second
      // workspace: the id is the client's, so the replay carries the same one.
      //
      // `target` is load-bearing, and this is the one table where leaving it
      // off is dangerous. Bare `onConflictDoNothing()` means *any* conflict,
      // and workspaces now carry a second unique index - the one on the name.
      // Two creates of the same name racing past the check above would then
      // both answer "done" while the second wrote nothing at all: the box
      // clears, the list is re-read, and the workspace is simply not there.
      // Named at the primary key, the id replay stays a no-op and a name
      // collision raises, which is what the index is for. (`items` and
      // `associations` have no second unique index, so their bare calls below
      // mean only what they say.)
      db.transaction((tx) => {
        tx.insert(workspaces).values(workspace).onConflictDoNothing({ target: workspaces.id }).run();
        // Its first dashboard, in the same act, so "every workspace has at
        // least one dashboard" holds from the moment the workspace exists
        // rather than from the next time somebody adds one ("Add and switch
        // dashboards", issue 32). Named at the primary key for the same reason
        // the workspace above is: a replayed create must add neither a second
        // workspace nor a second dashboard.
        tx.insert(dashboards)
          .values(firstDashboardFor(workspace))
          .onConflictDoNothing({ target: dashboards.id })
          .run();
        tx.insert(commands).values(commandRow).run();
      });
      break;
    }
    case 'add_dashboard': {
      const cmd = payload as CommandPayload<'add_dashboard'>;
      // The workspace is client-supplied and only shape-validated, so this is
      // where an unknown one is caught. Live only: a dashboard cannot be added
      // to a workspace that is no longer there.
      if (!getWorkspace(db, tenantId, cmd.workspaceId)) {
        throw new WorkspaceNotFoundError(cmd.workspaceId);
      }
      // Scoped to this workspace, which is the whole difference from a
      // workspace name: two workspaces may each have a Research.
      const alreadyCalledThat = dashboardNamed(
        listDashboards(db, tenantId, cmd.workspaceId),
        cmd.name,
      );
      if (alreadyCalledThat) throw new DashboardNameTakenError(alreadyCalledThat.name);
      db.transaction((tx) => {
        tx.insert(dashboards)
          .values(dashboardFromCommand(cmd, tenantId))
          .onConflictDoNothing({ target: dashboards.id })
          .run();
        tx.insert(commands).values(commandRow).run();
      });
      break;
    }
    case 'rename_dashboard': {
      const cmd = payload as CommandPayload<'rename_dashboard'>;
      if (!getWorkspace(db, tenantId, cmd.workspaceId)) {
        throw new WorkspaceNotFoundError(cmd.workspaceId);
      }
      // One list, two questions: is this dashboard still there, and is the name
      // free. Live only, so renaming one that is no longer there is a 404
      // rather than an update that quietly matches no rows.
      const existing = listDashboards(db, tenantId, cmd.workspaceId);
      if (!existing.some((d) => d.id === cmd.dashboardId)) {
        throw new DashboardNotFoundError(cmd.dashboardId);
      }
      // The same question adding asks, minus this dashboard's own row: the name
      // it already has, in any capitalization, collides with nothing.
      const alreadyCalledThat = dashboardNamed(existing, cmd.name, cmd.dashboardId);
      if (alreadyCalledThat) throw new DashboardNameTakenError(alreadyCalledThat.name);
      db.transaction((tx) => {
        tx.update(dashboards)
          // `foldedName` alongside `name`, never on its own: it is what the
          // unique index holds, so a rename writing only the name would leave
          // the index guarding the old one.
          .set({ name: cmd.name, foldedName: foldName(cmd.name) })
          .where(and(eq(dashboards.tenantId, tenantId), eq(dashboards.id, cmd.dashboardId)))
          .run();
        tx.insert(commands).values(commandRow).run();
      });
      break;
    }
    case 'delete_dashboard': {
      const cmd = payload as CommandPayload<'delete_dashboard'>;
      if (!getWorkspace(db, tenantId, cmd.workspaceId)) {
        throw new WorkspaceNotFoundError(cmd.workspaceId);
      }
      const existing = listDashboards(db, tenantId, cmd.workspaceId);
      // A dashboard already deleted is not there to delete again, so the same
      // delete sent twice deletes one dashboard whether the replay carries the
      // original request id (caught above) or a fresh one (caught here).
      if (!existing.some((d) => d.id === cmd.dashboardId)) {
        throw new DashboardNotFoundError(cmd.dashboardId);
      }
      // Counted here rather than left to a rule somewhere else: a workspace
      // with no dashboards has no view at all.
      if (existing.length === 1) throw new LastDashboardError();
      // Its panels and layouts go with it, and no statement here touches them:
      // every read of either joins to a live dashboard (repo.ts), so
      // tombstoning this one takes them off every screen at once. That is
      // "tombstones, not deletes" doing its job rather than being worked
      // around - restoring the dashboard by hand would bring them all back.
      db.transaction((tx) => {
        tx.update(dashboards)
          .set({ deletedAt: cmd.issuedAt })
          .where(and(eq(dashboards.tenantId, tenantId), eq(dashboards.id, cmd.dashboardId)))
          .run();
        tx.insert(commands).values(commandRow).run();
      });
      break;
    }
    case 'add_panel': {
      const cmd = payload as CommandPayload<'add_panel'>;
      const dashboard = dashboardTheChangeIsAbout(db, tenantId, cmd.workspaceId, cmd.dashboardId);
      // Scoped to this dashboard, which is one level further down than a
      // dashboard name: two dashboards of one workspace may each have a
      // Reading list.
      const alreadyCalledThat = panelNamed(listPanels(db, tenantId, dashboard.id), cmd.name);
      if (alreadyCalledThat) throw new PanelNameTakenError(alreadyCalledThat.name);
      // Every layout of the dashboard gets the new panel, appended, so that
      // adding one on a laptop does not leave it missing from the phone layout
      // until somebody rearranges that too. Read here rather than sent by the
      // client because the client's copy of the layouts can be stale - the same
      // reason a new workspace's colour is picked here.
      const layoutIds = listLayoutIds(db, tenantId, dashboard.id);
      const appended = layoutIds.map((layoutId) =>
        appendedPlacement(tenantId, layoutId, cmd.panelId, listPlacements(db, tenantId, layoutId)),
      );
      db.transaction((tx) => {
        // Named at the primary key for the reason a workspace's insert is: a
        // replayed add whose request id was lost carries the same panel id, so
        // it must be a no-op rather than a second panel - and a *name*
        // collision has to raise, which a bare onConflictDoNothing would
        // swallow now that this table has a second unique index.
        tx.insert(panels)
          .values(panelFromCommand(cmd, tenantId))
          .onConflictDoNothing({ target: panels.id })
          .run();
        for (const placement of appended) {
          tx.insert(panelPlacements)
            .values(placement)
            .onConflictDoNothing({
              target: [panelPlacements.layoutId, panelPlacements.panelId],
            })
            .run();
        }
        tx.insert(commands).values(commandRow).run();
      });
      break;
    }
    case 'rename_panel': {
      const cmd = payload as CommandPayload<'rename_panel'>;
      const panel = panelTheChangeIsAbout(db, tenantId, cmd.workspaceId, cmd.panelId);
      // The same question adding asks, minus this panel's own row: the title it
      // already has, in any capitalization, collides with nothing.
      const alreadyCalledThat = panelNamed(
        listPanels(db, tenantId, panel.dashboardId),
        cmd.name,
        panel.id,
      );
      if (alreadyCalledThat) throw new PanelNameTakenError(alreadyCalledThat.name);
      db.transaction((tx) => {
        tx.update(panels)
          // `foldedName` alongside `name`, never on its own: it is what the
          // unique index holds, so a rename writing only the title would leave
          // the index guarding the old one.
          .set({ name: cmd.name, foldedName: foldName(cmd.name) })
          .where(and(eq(panels.tenantId, tenantId), eq(panels.id, cmd.panelId)))
          .run();
        tx.insert(commands).values(commandRow).run();
      });
      break;
    }
    case 'delete_panel': {
      const cmd = payload as CommandPayload<'delete_panel'>;
      // A panel already deleted is not there to delete again, so the same
      // delete sent twice deletes one panel whether the replay carries the
      // original request id (caught at the top) or a fresh one (caught here).
      panelTheChangeIsAbout(db, tenantId, cmd.workspaceId, cmd.panelId);
      // A dashboard may end up with no panels at all. The last *dashboard* of a
      // workspace is the one thing the app refuses to delete, because a
      // workspace with no dashboard has no view; a dashboard with no panels is
      // a dashboard you can put one on.
      db.transaction((tx) => {
        // Out of every layout of the dashboard, in one statement: a layout is a
        // list of where the panels are, and one naming a panel nobody can see
        // would be a hole no gesture could fill. Deleted rather than
        // tombstoned, like the layouts they belong to - the reason is on
        // `panelPlacements` in schema.ts.
        tx.delete(panelPlacements)
          .where(and(eq(panelPlacements.tenantId, tenantId), eq(panelPlacements.panelId, cmd.panelId)))
          .run();
        tx.update(panels)
          .set({ deletedAt: cmd.issuedAt })
          .where(and(eq(panels.tenantId, tenantId), eq(panels.id, cmd.panelId)))
          .run();
        tx.insert(commands).values(commandRow).run();
      });
      break;
    }
    case 'save_layout': {
      const cmd = payload as CommandPayload<'save_layout'>;
      const dashboard = dashboardTheChangeIsAbout(db, tenantId, cmd.workspaceId, cmd.dashboardId);
      // An arrangement may only name panels that are on the dashboard it
      // arranges. Checked here rather than left to the foreign key, which would
      // surface a caller's mistake as a 500 and could not tell a panel of
      // another dashboard from one that never existed.
      const stranger = panelsNotOn(listPanels(db, tenantId, dashboard.id), cmd)[0];
      if (stranger) throw new PanelNotFoundError(stranger);
      // An upsert, which is what carries the issue's question: a layout id the
      // dashboard already has changes that layout, and a fresh one defines a
      // new layout for this screen width.
      const held = getLayout(db, tenantId, cmd.layoutId);
      if (held && held.dashboardId !== dashboard.id) throw new LayoutNotFoundError(cmd.layoutId);
      const rows = placementRows(tenantId, cmd.layoutId, cmd.placements);
      db.transaction((tx) => {
        tx.insert(layouts)
          .values({
            id: cmd.layoutId,
            tenantId,
            dashboardId: dashboard.id,
            screenWidth: cmd.screenWidth,
            createdAt: cmd.issuedAt,
          })
          // `DoNothing` is what records the width once and once only, and it is
          // the whole of that rule rather than a guard on a branch: a layout
          // records the width it was *created* at, so changing one from another
          // screen has to leave that alone - defining a new layout is the other
          // answer to the question, and it carries a new id. Named at the
          // primary key rather than bare, so a collision on anything else would
          // still raise.
          .onConflictDoNothing({ target: layouts.id })
          .run();
        // Replaced whole rather than merged: an arrangement is an answer to
        // "where do these panels go now", so a panel left out of it has no
        // place in this layout and its old row must not survive.
        tx.delete(panelPlacements)
          .where(
            and(eq(panelPlacements.tenantId, tenantId), eq(panelPlacements.layoutId, cmd.layoutId)),
          )
          .run();
        // Several inserts rather than one, because one statement may bind 100
        // values and a placement is six of them (`placementBatches`). Inside
        // this transaction and not beside it, which is the whole of what makes
        // a big arrangement still all-or-nothing: a batch that failed with its
        // predecessors already committed would leave a layout holding half an
        // arrangement, and nothing afterwards would know to finish it.
        for (const batch of placementBatches(rows)) {
          tx.insert(panelPlacements).values(batch).run();
        }
        tx.insert(commands).values(commandRow).run();
      });
      break;
    }
    case 'delete_layout': {
      const cmd = payload as CommandPayload<'delete_layout'>;
      if (!getWorkspace(db, tenantId, cmd.workspaceId)) {
        throw new WorkspaceNotFoundError(cmd.workspaceId);
      }
      const held = getLayout(db, tenantId, cmd.layoutId);
      // Deleted rather than tombstoned, so the same delete sent twice with a
      // fresh request id finds nothing the second time.
      if (!held) throw new LayoutNotFoundError(cmd.layoutId);
      if (!getDashboard(db, tenantId, cmd.workspaceId, held.dashboardId)) {
        throw new LayoutNotFoundError(cmd.layoutId);
      }
      db.transaction((tx) => {
        // Its placements first, which is what ON DELETE RESTRICT is for: what
        // happens to the rows pointing at this one is said here rather than
        // inherited from a cascade nobody wrote.
        tx.delete(panelPlacements)
          .where(
            and(eq(panelPlacements.tenantId, tenantId), eq(panelPlacements.layoutId, cmd.layoutId)),
          )
          .run();
        tx.delete(layouts)
          .where(and(eq(layouts.tenantId, tenantId), eq(layouts.id, cmd.layoutId)))
          .run();
        tx.insert(commands).values(commandRow).run();
      });
      break;
    }
    case 'rename_workspace': {
      const cmd = payload as CommandPayload<'rename_workspace'>;
      // One list, two questions again: is this workspace still there, and is
      // the name free. Live only, so renaming a workspace that is no longer
      // there is a 404 rather than an update that quietly matches no rows.
      const existing = listWorkspaces(db, tenantId);
      if (!existing.some((w) => w.id === cmd.workspaceId)) {
        throw new WorkspaceNotFoundError(cmd.workspaceId);
      }
      // The same question creating asks, minus this workspace's own row: the
      // name it already has, in any capitalization, collides with nothing.
      const alreadyCalledThat = workspaceNamed(existing, cmd.name, cmd.workspaceId);
      if (alreadyCalledThat) throw new WorkspaceNameTakenError(alreadyCalledThat.name);
      db.transaction((tx) => {
        tx.update(workspaces)
          // `foldedName` alongside `name`, never on its own and never left
          // behind: it is what the unique index holds, so a rename that wrote
          // only the name would leave the index guarding the old one - the
          // workspace would still block its previous name and stop blocking
          // its current one.
          .set({ name: cmd.name, foldedName: foldName(cmd.name) })
          .where(and(eq(workspaces.tenantId, tenantId), eq(workspaces.id, cmd.workspaceId)))
          .run();
        tx.insert(commands).values(commandRow).run();
      });
      break;
    }
    case 'delete_workspace': {
      const cmd = payload as CommandPayload<'delete_workspace'>;
      // A workspace already deleted is not there to delete again, so the same
      // delete sent twice deletes one workspace whether the replay carries the
      // original request id (caught above) or a fresh one (caught here).
      if (!getWorkspace(db, tenantId, cmd.workspaceId)) {
        throw new WorkspaceNotFoundError(cmd.workspaceId);
      }
      // A tombstone, not a delete: the items stay exactly where they are, so
      // the router keeps the history of where things were actually filed.
      // `issuedAt` is the client's own clock, like every other timestamp a
      // command writes, so a delete queued offline records when it was made.
      db.transaction((tx) => {
        tx.update(workspaces)
          .set({ deletedAt: cmd.issuedAt })
          .where(and(eq(workspaces.tenantId, tenantId), eq(workspaces.id, cmd.workspaceId)))
          .run();
        tx.insert(commands).values(commandRow).run();
      });
      break;
    }
    case 'reorder_workspaces': {
      const cmd = payload as CommandPayload<'reorder_workspaces'>;
      // One list, one question: is this an order of the workspaces the account
      // actually has? It answers "is the workspace that moved still there" at
      // the same time, because the wire schema has already made that id one of
      // the ones in the list.
      const existing = listWorkspaces(db, tenantId);
      if (!ordersExactly(existing, cmd.workspaceIds)) throw new WorkspaceOrderStaleError();
      db.transaction((tx) => {
        // Every workspace written, not only the ones that moved. Working out
        // which those are would be a second implementation of the order that
        // could disagree with the first, and it is at most a handful of rows -
        // the tabs across the top of one screen.
        cmd.workspaceIds.forEach((workspaceId, position) => {
          tx.update(workspaces)
            .set({ position })
            .where(and(eq(workspaces.tenantId, tenantId), eq(workspaces.id, workspaceId)))
            .run();
        });
        tx.insert(commands).values(commandRow).run();
      });
      break;
    }
    case 'set_workspace_theme': {
      const cmd = payload as CommandPayload<'set_workspace_theme'>;
      if (!getWorkspace(db, tenantId, cmd.workspaceId)) {
        throw new WorkspaceNotFoundError(cmd.workspaceId);
      }
      // The four colors are stored, but only the palette's combinations may be
      // stored: that is what "picked from designed options" means once there is
      // a wire format a caller can put anything into, and it is how the
      // legibility half of the decision is actually kept rather than intended.
      // The day mixing your own is wanted, this check is what relaxes.
      if (
        !isPaletteTheme({ tint: cmd.color, bar: cmd.bar, ground: cmd.ground, header: cmd.header })
      ) {
        throw new UnknownThemeError();
      }
      db.transaction((tx) => {
        tx.update(workspaces)
          .set({ color: cmd.color, bar: cmd.bar, ground: cmd.ground, header: cmd.header })
          .where(and(eq(workspaces.tenantId, tenantId), eq(workspaces.id, cmd.workspaceId)))
          .run();
        tx.insert(commands).values(commandRow).run();
      });
      break;
    }
    case 'capture_item': {
      const cmd = payload as CommandPayload<'capture_item'>;
      // The workspace is client-supplied and only shape-validated, so this is
      // the one place an unknown id can reach a write. Checked here rather
      // than left to the foreign key: the constraint would surface a caller's
      // mistake as a 500, and this is a 404 like any other missing thing.
      if (!getWorkspace(db, tenantId, cmd.workspaceId)) {
        throw new WorkspaceNotFoundError(cmd.workspaceId);
      }
      // The type the capture names, checked here rather than left to the
      // foreign key, for the reason the workspace above is: a constraint would
      // surface a caller's mistake as a 500, and a type of another account is
      // a 404 like any other missing thing.
      if (cmd.typeId && !getItemType(db, tenantId, cmd.typeId)) {
        throw new ItemTypeNotFoundError(cmd.typeId);
      }
      const item = captureItem(cmd, tenantId);
      db.transaction((tx) => {
        // A retried capture whose command ID was lost still may not duplicate the item.
        // `status` is the dead column being satisfied rather than used: it is
        // NOT NULL with a CHECK and nothing reads it (schema.ts).
        tx.insert(items).values({ ...item, status: DEAD_STATUS_VALUE }).onConflictDoNothing().run();
        tx.insert(commands).values(commandRow).run();
      });
      break;
    }
    case 'move_item_to_panel': {
      const cmd = payload as CommandPayload<'move_item_to_panel'>;
      // The item first, because it is what the change is about, and checked
      // against the workspace the envelope names: an item is addressed by its
      // own id alone, so without that a move could reach across the account
      // into a workspace the caller never opened. The same reasoning
      // `panelTheChangeIsAbout` carries, one level along.
      const item = getItem(db, tenantId, cmd.itemId);
      if (!item || item.workspaceId !== cmd.workspaceId) throw new ItemNotFoundError(cmd.itemId);
      // A null panel is the Inbox, which is not a panel and so is nothing to
      // look up: the item comes off everything and, being filed nowhere, is
      // back in the Inbox.
      const panel = cmd.panelId ? panelTheChangeIsAbout(db, tenantId, cmd.workspaceId, cmd.panelId) : null;

      // Checked against what the panel actually holds rather than left to the
      // foreign key, which could not tell an item of another workspace from one
      // that was moved off a moment ago - and would surface either as a 500.
      if (panel) refuseAStaleOrder(db, tenantId, { ...cmd, panelId: panel.id });

      const rows = filingRows(tenantId, cmd);
      db.transaction((tx) => {
        // Off everything first, which is what makes this a move rather than an
        // add: the item's own rows go, wherever they were, and the target
        // panel's arrangement is then written whole. A reorder is the same two
        // steps over one panel, which is why it is the same command.
        tx.delete(panelItems)
          .where(and(eq(panelItems.tenantId, tenantId), eq(panelItems.itemId, cmd.itemId)))
          .run();
        if (panel) {
          // Replaced whole rather than merged, for the reason a layout's
          // placements are: an order is the answer to "where do these items go
          // now", so a row not in it must not survive.
          tx.delete(panelItems)
            .where(and(eq(panelItems.tenantId, tenantId), eq(panelItems.panelId, panel.id)))
            .run();
          if (rows.length > 0) tx.insert(panelItems).values(rows).run();
        }
        tx.insert(commands).values(commandRow).run();
      });
      break;
    }
    case 'add_item_to_panel': {
      const cmd = payload as CommandPayload<'add_item_to_panel'>;
      const item = getItem(db, tenantId, cmd.itemId);
      if (!item || item.workspaceId !== cmd.workspaceId) throw new ItemNotFoundError(cmd.itemId);
      const panel = panelTheChangeIsAbout(db, tenantId, cmd.workspaceId, cmd.panelId);

      refuseAStaleOrder(db, tenantId, { ...cmd, panelId: panel.id });

      const rows = filingRows(tenantId, { ...cmd, panelId: panel.id });
      db.transaction((tx) => {
        // Only this panel's rows. **The whole difference from a move is the
        // delete that is not here**: the panels the item was already on keep
        // it, which is what makes one item on several panels a thing at all.
        tx.delete(panelItems)
          .where(and(eq(panelItems.tenantId, tenantId), eq(panelItems.panelId, panel.id)))
          .run();
        if (rows.length > 0) tx.insert(panelItems).values(rows).run();
        tx.insert(commands).values(commandRow).run();
      });
      break;
    }
    case 'remove_item_from_panel': {
      const cmd = payload as CommandPayload<'remove_item_from_panel'>;
      const item = getItem(db, tenantId, cmd.itemId);
      if (!item || item.workspaceId !== cmd.workspaceId) throw new ItemNotFoundError(cmd.itemId);
      const panel = panelTheChangeIsAbout(db, tenantId, cmd.workspaceId, cmd.panelId);

      db.transaction((tx) => {
        // One row. What is left keeps the places it had: a gap in the numbering
        // is not a hole anybody can see, and renumbering would be an
        // arrangement nobody asked for.
        tx.delete(panelItems)
          .where(
            and(
              eq(panelItems.tenantId, tenantId),
              eq(panelItems.panelId, panel.id),
              eq(panelItems.itemId, cmd.itemId),
            ),
          )
          .run();
        tx.insert(commands).values(commandRow).run();
      });
      break;
    }
    case 'create_item_type': {
      const cmd = payload as CommandPayload<'create_item_type'>;
      const already = listItemTypes(db, tenantId);
      // Naming one that is already there reuses it rather than refusing: the
      // gesture is "this is a thought", and it means the same whether or not
      // the type existed a moment ago ("Capture a thought or an action, and
      // see which it is", issue 155). The command is still recorded, so a
      // replay is still a replay.
      const existing = itemTypeNamed(already, cmd.name);
      db.transaction((tx) => {
        if (!existing) {
          tx.insert(itemTypes)
            .values({
              ...itemTypeFromCommand(cmd, tenantId, already, lastItemTypePosition(db, tenantId)),
              foldedName: foldName(cmd.name),
              deletedAt: null,
            })
            .onConflictDoNothing()
            .run();
        }
        tx.insert(commands).values(commandRow).run();
      });
      break;
    }
    case 'rename_item_type': {
      const cmd = payload as CommandPayload<'rename_item_type'>;
      const live = listItemTypes(db, tenantId);
      const type = live.find((candidate) => candidate.id === cmd.typeId);
      if (!type) throw new ItemTypeNotFoundError(cmd.typeId);
      // Its own name back is a rename that changes nothing, not a collision.
      const taken = itemTypeNamed(live, cmd.name);
      if (taken && taken.id !== cmd.typeId) throw new ItemTypeNameTakenError(cmd.name);
      db.transaction((tx) => {
        tx.update(itemTypes)
          .set({ name: cmd.name, foldedName: foldName(cmd.name) })
          .where(and(eq(itemTypes.tenantId, tenantId), eq(itemTypes.id, cmd.typeId)))
          .run();
        tx.insert(commands).values(commandRow).run();
      });
      break;
    }
    case 'set_item_type_color': {
      const cmd = payload as CommandPayload<'set_item_type_color'>;
      if (!getItemType(db, tenantId, cmd.typeId)) throw new ItemTypeNotFoundError(cmd.typeId);
      db.transaction((tx) => {
        tx.update(itemTypes)
          .set({ color: cmd.color })
          .where(and(eq(itemTypes.tenantId, tenantId), eq(itemTypes.id, cmd.typeId)))
          .run();
        tx.insert(commands).values(commandRow).run();
      });
      break;
    }
    case 'delete_item_type': {
      const cmd = payload as CommandPayload<'delete_item_type'>;
      if (!getItemType(db, tenantId, cmd.typeId)) throw new ItemTypeNotFoundError(cmd.typeId);
      db.transaction((tx) => {
        // Tombstoned, never erased, and the items that named it are left
        // alone: the row stays, so the foreign key stays satisfied, and an
        // item pointing at a type no longer in the live list simply has none.
        // That is what makes deleting a type a tidy-up rather than a change to
        // everything it labelled.
        tx.update(itemTypes)
          .set({ deletedAt: cmd.issuedAt })
          .where(and(eq(itemTypes.tenantId, tenantId), eq(itemTypes.id, cmd.typeId)))
          .run();
        tx.insert(commands).values(commandRow).run();
      });
      break;
    }
    case 'reorder_item_types': {
      const cmd = payload as CommandPayload<'reorder_item_types'>;
      const live = listItemTypes(db, tenantId);
      if (!live.some((type) => type.id === cmd.typeId)) {
        throw new ItemTypeNotFoundError(cmd.typeId);
      }
      if (!ordersTypesExactly(live, cmd.typeIds)) throw new ItemTypeOrderStaleError();
      db.transaction((tx) => {
        cmd.typeIds.forEach((typeId, position) => {
          tx.update(itemTypes)
            .set({ position })
            .where(and(eq(itemTypes.tenantId, tenantId), eq(itemTypes.id, typeId)))
            .run();
        });
        tx.insert(commands).values(commandRow).run();
      });
      break;
    }
    case 'associate': {
      const cmd = payload as CommandPayload<'associate'>;
      const existing = getItem(db, tenantId, cmd.itemId);
      if (!existing) throw new ItemNotFoundError(cmd.itemId);
      db.transaction((tx) => {
        if (cmd.remove) {
          tx.delete(associations)
            .where(and(eq(associations.tenantId, tenantId), eq(associations.id, cmd.associationId)))
            .run();
        } else {
          tx.insert(associations)
            .values(associationFromCommand(cmd, tenantId))
            .onConflictDoNothing()
            .run();
        }
        tx.insert(commands).values(commandRow).run();
      });
      break;
    }
    default: {
      // All remaining commands are updates to a single existing item.
      const cmd = payload as
        | CommandPayload<'set_done'>
        | CommandPayload<'set_dismissed'>
        | CommandPayload<'set_next_action'>
        | CommandPayload<'set_priority'>;
      const existing = getItem(db, tenantId, cmd.itemId);
      if (!existing) throw new ItemNotFoundError(cmd.itemId);

      const updated =
        name === 'set_done'
          ? applySetDone(existing, cmd as CommandPayload<'set_done'>)
          : name === 'set_dismissed'
            ? applySetDismissed(existing, cmd as CommandPayload<'set_dismissed'>)
            : name === 'set_next_action'
              ? applySetNextAction(existing, cmd as CommandPayload<'set_next_action'>)
              : applySetPriority(existing, cmd as CommandPayload<'set_priority'>);

      if (updated === null) {
        // Stale by last-write-wins: log the command, change nothing.
        db.insert(commands).values(commandRow).run();
        applied = false;
      } else {
        db.transaction((tx) => {
          tx.update(items)
            .set(updated)
            .where(and(eq(items.tenantId, tenantId), eq(items.id, cmd.itemId)))
            .run();
          tx.insert(commands).values(commandRow).run();
        });
      }
      break;
    }
  }

  // No explicit broadcast: SSE connections derive invalidations from the
  // command log itself (see events.ts for why in-memory fan-out can't work).
  return { ok: true, applied };
}
