import { and, eq, exists, notExists, sql } from 'drizzle-orm';
import type { CommandName, CommandPayload, CommandResult, PanelKind } from '@cockpit/shared';
import type { AccountDb } from './client.js';
import {
  associations,
  commands,
  dashboards,
  DEAD_STATUS_VALUE,
  decisionHistory,
  items,
  itemTypes,
  layoutRows,
  layouts,
  panelItems,
  panelPlacements,
  panels,
  screenSizes,
  workspaces,
} from './schema.js';
import {
  commandAlreadyApplied,
  getDashboard,
  getItem,
  getItemType,
  getLayout,
  getPanel,
  getScreenSize,
  getWorkspace,
  isItemFiled,
  lastWorkspacePosition,
  listDashboards,
  lastItemTypePosition,
  listFilingsOnPanel,
  listItemTypes,
  listLayoutIds,
  listLayoutRows,
  listLayoutsOn,
  listPanels,
  listPlacements,
  listScreenSizes,
  listWorkspaces,
} from './repo.js';
import {
  ACCOUNT_WIDE,
  DEFAULT_SCREEN_SIZE_NAME,
  isPaletteTheme,
  nearestScreenSize,
  panelTakesItems,
} from '@cockpit/shared';
import { foldName } from '../domain/names.js';
import {
  dashboardFromCommand,
  dashboardNamed,
  firstDashboardFor,
} from '../domain/dashboards.js';
import {
  FILING_VALUES_PER_ROW,
  filingRows,
  orderIsNotOfThePanel,
  type Arriving,
} from '../domain/filings.js';
import {
  LAYOUT_ROW_VALUES_PER_ROW,
  PLACEMENT_VALUES_PER_ROW,
  appendedPlacement,
  arrangementRows,
  firstPanelFor,
  panelFromCommand,
  panelNamed,
  panelsNotOn,
} from '../domain/panels.js';
import { inBatchesOf } from '../domain/statements.js';
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
import { defaultScreenSizeId, screenSizeNamed } from '../domain/screen-sizes.js';
import { decisionHistoryEntryFor } from '../domain/decision-history.js';
import {
  applyProposedPanel,
  applyProposedTexts,
  applySetDescription,
  applySetDismissed,
  applySetDone,
  applySetNextAction,
  applySetPriority,
  applySetTitle,
  associationFromCommand,
  captureItem,
  decideWorkspace,
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
 * A panel of text asked to hold an item, or a panel of items asked to hold
 * text. Nothing is filed onto a panel of text and nothing is written into a
 * panel of items: what a panel is made of is settled when it is made
 * (`panelKindSchema`), and the two hold different things.
 *
 * **Refused here and not only hidden in the app**, because the app's scoping is
 * presentation rather than protection (architecture, "Security"). An item filed
 * onto a panel that does not draw items leaves the Inbox and is then on no
 * screen at all.
 */
export class PanelHoldsSomethingElseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PanelHoldsSomethingElseError';
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
 * A dashboard may have at most one Layout at a given Screen size ("Draw a
 * dashboard against the screen sizes its account has", issue 263) - the
 * message names the size, since that is the thing actually in the way.
 */
export class LayoutSizeTakenError extends Error {
  constructor(screenSizeName: string) {
    super(`a layout for ${screenSizeName} already arranges this dashboard`);
    this.name = 'LayoutSizeTakenError';
  }
}

/**
 * A screen size that is not the account's - gone, or never made ("Draw a
 * dashboard against the screen sizes its account has", issue 263). There is no
 * deleting-the-last refusal beside this one: unlike a Layout, an account
 * keeping none is a normal state, meaning every Dashboard is drawn fitted to
 * the screen it is on.
 */
export class ScreenSizeNotFoundError extends Error {
  constructor(screenSizeId: string) {
    super(`screen size ${screenSizeId} not found`);
    this.name = 'ScreenSizeNotFoundError';
  }
}

/**
 * Its own kind rather than the type one, for the reason every name-taken error
 * here has its own: the message is what a person reads, and it has to name the
 * list that is actually in the way.
 */
export class ScreenSizeNameTakenError extends Error {
  constructor(name: string) {
    super(`a screen size called ${name} already exists`);
    this.name = 'ScreenSizeNameTakenError';
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
 * Refuses a panel that holds text where an item is being filed.
 *
 * One function rather than the check written twice, because filing an item and
 * adding it to one more panel are the same act with different answers about
 * where it was before ("Ask whether to move an item to a panel or add it to
 * one", issue 142) - so they cannot be allowed to come to disagree about what
 * a panel will take.
 *
 * Takes the null a move to the Inbox carries, so the caller need not ask twice.
 *
 * The kind is the contract's own type rather than a bare string: the check is a
 * comparison against a literal, and a mistyped one would compile, never refuse,
 * and quietly reopen the hole this exists to close.
 */
function refuseAPanelOfText(panel: { name: string; kind: PanelKind } | null) {
  if (panel && !panelTakesItems(panel)) {
    throw new PanelHoldsSomethingElseError(`${panel.name} holds text, so nothing is filed on it`);
  }
}

/**
 * Refuses a panel that holds items where its text is being changed.
 *
 * The mirror of the guard above, and one function for the same reason: three
 * commands are about a panel's text - what it says, whether it is written in,
 * and how it is drawn - and three copies of one rule are three chances for them
 * to answer differently about the same panel.
 */
function refuseUnlessPanelOfText(panel: { name: string; kind: PanelKind }) {
  if (panelTakesItems(panel)) {
    throw new PanelHoldsSomethingElseError(`${panel.name} holds items, not text`);
  }
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
 * The Panel a routing proposal names, checked exactly as strictly as a
 * person's own filing is - the Workspace live, the Panel live, its dashboard
 * live and in that Workspace, and holding items rather than text - except
 * that failing any of it answers `null` rather than throwing.
 *
 * **Never trust a panel id back** ("Propose where a captured note belongs,
 * without filing it there", issue 298): the model chooses among the ids it
 * was given, and this is where what came back is checked against what is
 * actually still true, freshly, rather than against the list the prompt was
 * built from - which is what catches a Panel deleted in the moment between
 * asking and this write. Failing it is not a user's mistake to refuse, it is
 * a discarded proposal, exactly as an answer that will not parse is.
 *
 * **The Workspace check matters here in a way it would not for a person's own
 * filing.** `delete_workspace` tombstones the Workspace alone and leaves its
 * Dashboards and Panels exactly as they were - "the items stay exactly where
 * they are" - so a Panel of a deleted Workspace still passes every other
 * check in this function. A person can never reach it, because nothing
 * offers a Workspace that has gone; the Item behind this proposal can, since
 * `item.workspaceId` is read from a row that predates the deletion.
 */
function liveDestinationPanel(
  db: AccountDb,
  tenantId: string,
  workspaceId: string,
  panelId: string,
): { id: string; kind: PanelKind } | null {
  if (!getWorkspace(db, tenantId, workspaceId)) return null;
  const panel = getPanel(db, tenantId, panelId);
  if (!panel || !panelTakesItems(panel)) return null;
  if (!getDashboard(db, tenantId, workspaceId, panel.dashboardId)) return null;
  return panel;
}

/**
 * Logs this change against the account rather than against one workspace, so
 * the stream tells *every* workspace its snapshot is stale (events.ts derives
 * invalidations from this column, and useServerEvents reads the sentinel).
 *
 * **Every change to an item that belongs to no workspace needs it**, because an
 * item that belongs to none is drawn in every workspace's Inbox ("Capture
 * something before you know which workspace it belongs to", issue 165) - so
 * finishing with one, dismissing one, or settling one changes what a tab open
 * on some other workspace should be showing. Logging it against the workspace
 * the envelope happens to name leaves that tab drawing the item until something
 * unrelated makes it read again.
 */
function everyWorkspaceSees(commandRow: { workspaceId: string }): void {
  commandRow.workspaceId = ACCOUNT_WIDE;
}

/**
 * Inside one of this store's transactions - what `db.transaction` hands its
 * callback, which is not the database itself.
 */
type InATransaction = Parameters<Parameters<AccountDb['transaction']>[0]>[0];

/** Writes where an item belongs, once somebody has said ("An item gets its workspace…"). */
function settleWorkspace(
  tx: InATransaction,
  tenantId: string,
  itemId: string,
  decided: { workspaceId: string; updatedAt: string },
): void {
  tx.update(items)
    .set({ workspaceId: decided.workspaceId, workspaceDecided: true, updatedAt: decided.updatedAt })
    .where(and(eq(items.tenantId, tenantId), eq(items.id, itemId)))
    .run();
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
  // Set only by `move_item_to_panel`/`add_item_to_panel`, and only on the
  // same `!alreadyFiled` branch that writes `decisionHistory` - the one
  // signal the HTTP layer needs to know a routing genuinely settled just
  // now, read off this atomic call rather than by asking `isItemFiled`
  // again itself, before and separately from it, and racing whatever moves
  // the same Item in between ("Re-propose the rest of the inbox the moment
  // you file one", issue 300).
  let settledRouting = false;

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
      // Whether this is the first time this workspace has been made, which is
      // what decides whether its dashboard gets a panel below.
      const dashboardIsNew = listDashboards(db, tenantId, cmd.workspaceId).length === 0;
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
        const dashboard = firstDashboardFor(workspace);
        tx.insert(dashboards)
          .values(dashboard)
          .onConflictDoNothing({ target: dashboards.id })
          .run();
        // And that dashboard's panel, in the same act, so the workspace has
        // somewhere to file an item into from the moment it exists rather than
        // an Inbox with no way out of it (`firstPanelFor`). There is no
        // placement to write: a dashboard this new has no layout, and the board
        // arranges an unarranged dashboard itself (`panels/arrangement.ts`).
        //
        // **Only where the dashboard is really new**, which is the one guard
        // that cannot be `onConflictDoNothing` like the two above. A replay
        // carrying a fresh request id brings the same workspace and so the same
        // derived dashboard - both no-ops - but a panel id nothing has seen, so
        // naming `panels.id` would catch nothing and the *title* index would
        // refuse a second Panel 1 and take the whole command down with it.
        if (dashboardIsNew) {
          tx.insert(panels).values(firstPanelFor(dashboard, cmd.panelId)).run();
        }
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
      const alreadyThere = listDashboards(db, tenantId, cmd.workspaceId);
      const alreadyCalledThat = dashboardNamed(alreadyThere, cmd.name);
      if (alreadyCalledThat) throw new DashboardNameTakenError(alreadyCalledThat.name);
      // The same question `create_workspace` asks, for the same reason: a
      // replay carrying this dashboard's id and a fresh request id would
      // otherwise add a second Panel 1 to it.
      const dashboardIsNew = !alreadyThere.some((one) => one.id === cmd.dashboardId);
      db.transaction((tx) => {
        const dashboard = dashboardFromCommand(cmd, tenantId);
        tx.insert(dashboards)
          .values(dashboard)
          .onConflictDoNothing({ target: dashboards.id })
          .run();
        // Every dashboard arrives with one, not only a workspace's first:
        // otherwise the `+` in the bar makes a dashboard nothing can be filed
        // onto, one dashboard at a time.
        if (dashboardIsNew) {
          tx.insert(panels).values(firstPanelFor(dashboard, cmd.panelId)).run();
        }
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
        appendedPlacement(tenantId, layoutId, cmd.panelId, listLayoutRows(db, tenantId, layoutId)),
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
        for (const { row, placement } of appended) {
          // The row first: the placement points at it, and a row of its own is
          // what a panel added to an existing layout gets (`appendedPlacement`).
          tx.insert(layoutRows)
            .values(row)
            .onConflictDoNothing({ target: [layoutRows.layoutId, layoutRows.rowIndex] })
            .run();
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
    case 'set_panel_text': {
      const cmd = payload as CommandPayload<'set_panel_text'>;
      const panel = panelTheChangeIsAbout(db, tenantId, cmd.workspaceId, cmd.panelId);
      // A panel of items has no text to hold, so writing to one is refused
      // rather than quietly filling a column nothing draws.
      refuseUnlessPanelOfText(panel);
      // **A read-only panel is not refused, and that is deliberate.** Read-only
      // says what the panel is for rather than who may write to it - there are
      // no roles inside an account, and anybody looking at it can hand it back
      // in one gesture. Refusing would mean that somebody typing when a second
      // person locks the panel loses the sentence in flight, which is the one
      // thing writing on a pause exists to prevent.
      db.transaction((tx) => {
        // The whole document, over whatever is there. Two people typing at once
        // is the later write standing, which is the same answer this app gives
        // everywhere else and the reason the command carries the text whole.
        tx.update(panels)
          .set({ body: cmd.body })
          .where(and(eq(panels.tenantId, tenantId), eq(panels.id, cmd.panelId)))
          .run();
        tx.insert(commands).values(commandRow).run();
      });
      break;
    }
    case 'set_panel_format': {
      const cmd = payload as CommandPayload<'set_panel_format'>;
      const panel = panelTheChangeIsAbout(db, tenantId, cmd.workspaceId, cmd.panelId);
      // A panel of items has no words to draw, either way.
      refuseUnlessPanelOfText(panel);
      db.transaction((tx) => {
        // The `body` is deliberately untouched. What is stored is Markdown
        // whichever way it is drawn, so switching is not a conversion and
        // cannot lose a character somebody typed.
        tx.update(panels)
          .set({ format: cmd.format })
          .where(and(eq(panels.tenantId, tenantId), eq(panels.id, cmd.panelId)))
          .run();
        tx.insert(commands).values(commandRow).run();
      });
      break;
    }
    case 'set_panel_read_only': {
      const cmd = payload as CommandPayload<'set_panel_read_only'>;
      const panel = panelTheChangeIsAbout(db, tenantId, cmd.workspaceId, cmd.panelId);
      // A panel of items has nothing to lock, and a flag nobody reads is a
      // state to explain later.
      refuseUnlessPanelOfText(panel);
      db.transaction((tx) => {
        tx.update(panels)
          .set({ readOnly: cmd.readOnly })
          .where(and(eq(panels.tenantId, tenantId), eq(panels.id, cmd.panelId)))
          .run();
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
      const going = panelTheChangeIsAbout(db, tenantId, cmd.workspaceId, cmd.panelId);
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
        // And any row that was holding only this panel, in the same statement
        // and the same transaction: a row is the panels across it, so one with
        // none left is not an emptier arrangement but a line nothing draws.
        // The screen drops such a row anyway (repo.ts, `rowsOf`), because a
        // browser can be holding a copy from before this delete - but a state
        // the store can be left in is a state somebody has to explain later,
        // and this one need not exist at all.
        //
        // Bounded to this dashboard's layouts, which are the only ones this
        // delete touched. Emptied by tenant it would be a sweep: deleting a
        // panel on one dashboard would quietly rewrite the arrangements of
        // every other, and whatever it found to remove there would be somebody
        // else's problem to explain.
        //
        // A join rather than the ids read out and bound in: a dashboard's
        // layouts are uncapped, and an `IN` list as long as them is a statement
        // whose parameter count grows with the data - past a hundred of them
        // every delete on that dashboard would throw, for good (architecture,
        // "No statement's parameter count grows with the data", which names a
        // workspace that stopped painting at a hundred layouts as one of the
        // instances it was written for).
        tx.delete(layoutRows)
          .where(
            and(
              eq(layoutRows.tenantId, tenantId),
              // Both halves carry `tenant_id` like every other query here does
              // (architecture, "One store per account, and `tenant_id` stays").
              // A store holds one account, so nothing else could match today -
              // which is the reason to write it rather than to leave it out:
              // the column is only ever a lock if it is always turned.
              exists(
                tx
                  .select({ one: sql`1` })
                  .from(layouts)
                  .where(
                    and(
                      eq(layouts.tenantId, tenantId),
                      eq(layouts.id, layoutRows.layoutId),
                      eq(layouts.dashboardId, going.dashboardId),
                    ),
                  ),
              ),
              notExists(
                tx
                  .select({ one: sql`1` })
                  .from(panelPlacements)
                  .where(
                    and(
                      eq(panelPlacements.tenantId, tenantId),
                      eq(panelPlacements.layoutId, layoutRows.layoutId),
                      eq(panelPlacements.rowIndex, layoutRows.rowIndex),
                    ),
                  ),
              ),
            ),
          )
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
      // An upsert: a layout id the dashboard already has changes that layout,
      // and a fresh one creates it. Which of the two it is is no longer a
      // question anybody is asked - you pick the layout you are on and every
      // change goes into it.
      const held = getLayout(db, tenantId, cmd.layoutId);
      if (held && held.dashboardId !== dashboard.id) throw new LayoutNotFoundError(cmd.layoutId);
      // Resolved only where this save is the one creating the layout - see
      // `saveLayoutSchema`'s `screenSizeId` for what each branch means. Left
      // as the empty string where `held` is truthy: the insert below still
      // names it, but `onConflictDoNothing` never lets an existing layout's
      // row be touched by it.
      let screenSizeId = '';
      let screenSizeName = '';
      let makingSize: { id: string; name: string; width: number } | null = null;
      if (!held) {
        if (cmd.screenSizeId) {
          // Explicit - "Define a layout for X". A tab that raced a delete of
          // this size past the menu offering it is refused naming the size,
          // not left to the foreign key underneath.
          const named = getScreenSize(db, tenantId, cmd.screenSizeId);
          if (!named) throw new ScreenSizeNotFoundError(cmd.screenSizeId);
          screenSizeId = named.id;
          screenSizeName = named.name;
        } else {
          // Implicit - an ordinary arrangement gesture on a Dashboard with
          // nothing defined. Kept in the nearest size the account has; where
          // it has none at all, this is the one save in the product that
          // still makes one, called `DEFAULT_SCREEN_SIZE_NAME`.
          const sizes = listScreenSizes(db, tenantId);
          const nearest = nearestScreenSize(sizes, cmd.screenWidth);
          if (nearest) {
            screenSizeId = nearest.id;
            screenSizeName = nearest.name;
          } else {
            makingSize = {
              id: defaultScreenSizeId(tenantId),
              name: DEFAULT_SCREEN_SIZE_NAME,
              width: cmd.screenWidth,
            };
            screenSizeId = makingSize.id;
            screenSizeName = makingSize.name;
          }
        }
        // At most one Layout of a Dashboard per screen size, checked by the
        // id itself: a screen size can be renamed at any time
        // (`rename_screen_size`), and comparing anything it was ever called
        // would let two Layouts at one size through around a rename landing
        // between two saves.
        const its = listLayoutsOn(db, tenantId, dashboard.id);
        const alreadyThere = its.find((layout) => layout.screenSizeId === screenSizeId);
        if (alreadyThere) throw new LayoutSizeTakenError(screenSizeName);
      }
      // Every screen size is the account's, offered in every Workspace it has -
      // see `create_screen_size`. Only where this save makes one; an ordinary
      // arrangement change stays scoped to the Workspace it was made in.
      if (makingSize) everyWorkspaceSees(commandRow);
      const arrangement = arrangementRows(tenantId, cmd.layoutId, cmd.rows);
      db.transaction((tx) => {
        if (makingSize) {
          tx.insert(screenSizes)
            .values({
              id: makingSize.id,
              tenantId,
              name: makingSize.name,
              foldedName: foldName(makingSize.name),
              width: makingSize.width,
              createdAt: cmd.issuedAt,
            })
            // Named at the primary key, like `create_screen_size`'s and for
            // the same reason: the id is derived from the tenant's own rather
            // than sent, so a retry under a fresh request id makes the same
            // one, not a second `Default`.
            .onConflictDoNothing({ target: screenSizes.id })
            .run();
        }
        tx.insert(layouts)
          .values({
            id: cmd.layoutId,
            tenantId,
            dashboardId: dashboard.id,
            screenSizeId,
            createdAt: cmd.issuedAt,
          })
          // `DoNothing` is what records the screen size once and once only,
          // and it is the whole of that rule rather than a guard on a branch:
          // a layout records the size it was *created* at, so changing an
          // existing layout's arrangement leaves that alone.
          .onConflictDoNothing({ target: layouts.id })
          .run();
        // Replaced whole rather than merged: an arrangement is an answer to
        // "where do these panels go now", so a panel left out of it has no
        // place in this layout and its old row must not survive - and a row it
        // no longer has is a line nothing would draw.
        //
        // Nothing enforces the order the two lists are written in - a cell
        // names its row by number, not by a foreign key - so what keeps them
        // agreeing is the transaction around both: nothing ever reads a layout
        // with its rows gone and its cells still there. A cell whose row is
        // missing all the same is a state the screen survives (repo.ts,
        // `rowsOf`) rather than one this relies on being impossible.
        tx.delete(panelPlacements)
          .where(
            and(eq(panelPlacements.tenantId, tenantId), eq(panelPlacements.layoutId, cmd.layoutId)),
          )
          .run();
        tx.delete(layoutRows)
          .where(and(eq(layoutRows.tenantId, tenantId), eq(layoutRows.layoutId, cmd.layoutId)))
          .run();
        // Several inserts rather than one, and inside this transaction rather
        // than beside it - see `inBatchesOf`, which carries both reasons.
        for (const batch of inBatchesOf(arrangement.rows, LAYOUT_ROW_VALUES_PER_ROW)) {
          tx.insert(layoutRows).values(batch).run();
        }
        for (const batch of inBatchesOf(arrangement.placements, PLACEMENT_VALUES_PER_ROW)) {
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
      // Deleting a Dashboard's last Layout is allowed: having none is a
      // normal state now, meaning fitted to the screen, not one this refuses.
      db.transaction((tx) => {
        // Its placements first, which is what ON DELETE RESTRICT is for: what
        // happens to the rows pointing at this one is said here rather than
        // inherited from a cascade nobody wrote.
        tx.delete(panelPlacements)
          .where(
            and(eq(panelPlacements.tenantId, tenantId), eq(panelPlacements.layoutId, cmd.layoutId)),
          )
          .run();
        tx.delete(layoutRows)
          .where(and(eq(layoutRows.tenantId, tenantId), eq(layoutRows.layoutId, cmd.layoutId)))
          .run();
        tx.delete(layouts)
          .where(and(eq(layouts.tenantId, tenantId), eq(layouts.id, cmd.layoutId)))
          .run();
        tx.insert(commands).values(commandRow).run();
      });
      break;
    }
    case 'create_screen_size': {
      const cmd = payload as CommandPayload<'create_screen_size'>;
      // A screen size is the account's, offered in every Workspace it has, so
      // every tab open on any of them needs telling - not only the one this
      // change happened to be sent from. Unconditional, unlike the item
      // commands above that call this only once a Workspace is decided: a
      // screen size is never workspace-scoped in the first place.
      everyWorkspaceSees(commandRow);
      const already = listScreenSizes(db, tenantId);
      // A name another size has is refused rather than reused, exactly as a
      // Type's is - a screen size is only ever made deliberately (R5).
      const alreadyCalledThat = screenSizeNamed(already, cmd.name);
      if (alreadyCalledThat) throw new ScreenSizeNameTakenError(alreadyCalledThat.name);
      db.transaction((tx) => {
        tx.insert(screenSizes)
          .values({
            id: cmd.screenSizeId,
            tenantId,
            name: cmd.name,
            foldedName: foldName(cmd.name),
            width: cmd.width,
            createdAt: cmd.issuedAt,
          })
          // Named at the primary key, like `create_workspace`'s and for the
          // same reason: a screen size also carries a second unique index, the
          // one on its folded name. A bare call would treat a race lost against
          // the check above as proof the request had already been granted, and
          // this client would go on to define a Layout against the id it sent
          // rather than the id that actually won - a foreign key with nothing
          // on the other end. Named at the id, a replayed create is the only
          // conflict this quietly absorbs, and a genuine name collision still
          // raises.
          .onConflictDoNothing({ target: screenSizes.id })
          .run();
        tx.insert(commands).values(commandRow).run();
      });
      break;
    }
    case 'rename_screen_size': {
      const cmd = payload as CommandPayload<'rename_screen_size'>;
      everyWorkspaceSees(commandRow); // account-wide - see create_screen_size
      const live = listScreenSizes(db, tenantId);
      const size = live.find((candidate) => candidate.id === cmd.screenSizeId);
      if (!size) throw new ScreenSizeNotFoundError(cmd.screenSizeId);
      // Its own name back is a rename that changes nothing, not a collision.
      const taken = screenSizeNamed(live, cmd.name, cmd.screenSizeId);
      if (taken) throw new ScreenSizeNameTakenError(taken.name);
      db.transaction((tx) => {
        tx.update(screenSizes)
          .set({ name: cmd.name, foldedName: foldName(cmd.name) })
          .where(and(eq(screenSizes.tenantId, tenantId), eq(screenSizes.id, cmd.screenSizeId)))
          .run();
        tx.insert(commands).values(commandRow).run();
      });
      break;
    }
    case 'delete_screen_size': {
      const cmd = payload as CommandPayload<'delete_screen_size'>;
      everyWorkspaceSees(commandRow); // account-wide - see create_screen_size
      // Deleted for real, so the same delete sent twice with a fresh request id
      // finds nothing the second time.
      if (!getScreenSize(db, tenantId, cmd.screenSizeId)) {
        throw new ScreenSizeNotFoundError(cmd.screenSizeId);
      }
      db.transaction((tx) => {
        // A join rather than the ids read out and bound in, for the reason
        // `delete_panel`'s cascade above is: every Dashboard of every
        // Workspace the account has may hold a Layout at this size - not only
        // one Dashboard's, which is the whole difference from `delete_layout`
        // - so that count is uncapped, and an `IN` list as long as it is a
        // statement whose parameter count grows with the data (architecture,
        // "No statement's parameter count grows with the data").
        //
        // Placements and rows before the layouts themselves, which is what
        // the RESTRICT on both makes explicit rather than silent.
        tx.delete(panelPlacements)
          .where(
            and(
              eq(panelPlacements.tenantId, tenantId),
              exists(
                tx
                  .select({ one: sql`1` })
                  .from(layouts)
                  .where(
                    and(
                      eq(layouts.tenantId, tenantId),
                      eq(layouts.id, panelPlacements.layoutId),
                      eq(layouts.screenSizeId, cmd.screenSizeId),
                    ),
                  ),
              ),
            ),
          )
          .run();
        tx.delete(layoutRows)
          .where(
            and(
              eq(layoutRows.tenantId, tenantId),
              exists(
                tx
                  .select({ one: sql`1` })
                  .from(layouts)
                  .where(
                    and(
                      eq(layouts.tenantId, tenantId),
                      eq(layouts.id, layoutRows.layoutId),
                      eq(layouts.screenSizeId, cmd.screenSizeId),
                    ),
                  ),
              ),
            ),
          )
          .run();
        tx.delete(layouts)
          .where(and(eq(layouts.tenantId, tenantId), eq(layouts.screenSizeId, cmd.screenSizeId)))
          .run();
        // Items filed on the Panels those Layouts arranged are untouched:
        // `panel_placements` is where a Panel sits in a Layout, and
        // `panel_items` is what is filed on a Panel - two tables one word
        // apart, holding two completely different things.
        tx.delete(screenSizes)
          .where(and(eq(screenSizes.tenantId, tenantId), eq(screenSizes.id, cmd.screenSizeId)))
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
      // a 404 like any other missing thing. Unconditional now that every
      // capture names one - the shape says there is a type, and this says it
      // is a type of this account.
      if (!getItemType(db, tenantId, cmd.typeId)) {
        throw new ItemTypeNotFoundError(cmd.typeId);
      }
      const item = captureItem(cmd, tenantId);
      // An item belonging to no workspace shows in every workspace's Inbox, so
      // every workspace's snapshot is now stale - not only the one it was
      // captured from ("Capture something before you know which workspace it
      // belongs to", issue 165). The same sentinel a new type carries, read by
      // the stream in events.ts and by useServerEvents in the browser.
      if (!item.workspaceDecided) everyWorkspaceSees(commandRow);
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
      //
      // **An item belonging to no workspace is reachable from every one of
      // them**, because it is shown in every one of them ("Capture something
      // before you know which workspace it belongs to", issue 165) - and this
      // is the command that says where it belongs. The workspace it names still
      // has to exist, which is what the check below does for a move to an Inbox
      // (`panelTheChangeIsAbout` already does it for a move to a panel).
      const item = getItem(db, tenantId, cmd.itemId);
      if (!item || (item.workspaceDecided && item.workspaceId !== cmd.workspaceId)) {
        throw new ItemNotFoundError(cmd.itemId);
      }
      // A null panel is the Inbox, which is not a panel and so is nothing to
      // look up: the item comes off everything and, being filed nowhere, is
      // back in the Inbox.
      const panel = cmd.panelId ? panelTheChangeIsAbout(db, tenantId, cmd.workspaceId, cmd.panelId) : null;
      if (!panel && !getWorkspace(db, tenantId, cmd.workspaceId)) {
        throw new WorkspaceNotFoundError(cmd.workspaceId);
      }
      // Nothing is filed onto a panel of text, which draws no items: one filed
      // there would leave the Inbox and be on no screen at all.
      refuseAPanelOfText(panel);

      // Checked against what the panel actually holds rather than left to the
      // foreign key, which could not tell an item of another workspace from one
      // that was moved off a moment ago - and would surface either as a 500.
      if (panel) refuseAStaleOrder(db, tenantId, { ...cmd, panelId: panel.id });

      // Read before anything below moves the item, because a routing settles
      // exactly once - the first time an Item leaves the Inbox - and this is
      // what tells that filing apart from every reorganizing move after it
      // ("Learn where notes belong from where you actually file them", issue
      // 299). Without this check, a later drag from one Panel to another would
      // still carry whatever `proposedPanelId` was frozen at the *first*
      // filing (nothing clears it - `applyProposedPanel`'s own comment: "never
      // read again") and misrecord it as a proposal for a decision it was
      // never shown for; undoing that later move would then write a further,
      // equally spurious entry, breaking `decision_history`'s own append-only,
      // undo-writes-nothing rule (schema.ts).
      const alreadyFiled = isItemFiled(db, tenantId, cmd.itemId);

      // Where it goes is where it belongs, from now on. Null for an item that
      // already belonged somewhere, which is every move the app made before
      // this: the workspace is settled and nothing about it changes.
      const decided = decideWorkspace(item, cmd.workspaceId, cmd.issuedAt);
      // It has just left every other workspace's Inbox, so their snapshots are
      // stale too - the same reason a capture with no workspace carries this.
      if (decided) everyWorkspaceSees(commandRow);

      const rows = filingRows(tenantId, cmd);
      db.transaction((tx) => {
        if (decided) settleWorkspace(tx, tenantId, cmd.itemId, decided);
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
          for (const batch of inBatchesOf(rows, FILING_VALUES_PER_ROW)) {
            tx.insert(panelItems).values(batch).run();
          }
          // A routing settles by landing on a real Panel for the first time -
          // never on a move to the Inbox, and never on a reorganizing move of
          // an Item already filed somewhere (`alreadyFiled` above), which is
          // not a fresh routing decision and would only ever misattribute a
          // stale proposal to it. `item` is read fresh above, before this
          // write, so its `proposedPanelId`/`proposedPanelReason` are exactly
          // what the Inbox chip showed for this, its one settling filing.
          if (!alreadyFiled) {
            settledRouting = true;
            tx.insert(decisionHistory)
              .values(decisionHistoryEntryFor(item, cmd, panel.id))
              .onConflictDoNothing()
              .run();
            // The proposal is spent the moment it is read into that entry -
            // cleared here rather than left for `applyProposedPanel`'s "never
            // read again" to keep true only by convention. Without this, an
            // Item that returns to the Inbox later (its only Panel deleted,
            // or removed via `remove_item_from_panel`) and is filed again
            // would still carry the *original* proposal, and the write above
            // would misattribute it to a decision it was never shown for -
            // exactly the failure `alreadyFiled` exists to prevent, reopened
            // through `isItemFiled` correctly reporting the Item as unfiled
            // again.
            tx.update(items)
              .set({ proposedPanelId: null, proposedPanelReason: null })
              .where(and(eq(items.tenantId, tenantId), eq(items.id, cmd.itemId)))
              .run();
          }
        }
        tx.insert(commands).values(commandRow).run();
      });
      break;
    }
    case 'add_item_to_panel': {
      const cmd = payload as CommandPayload<'add_item_to_panel'>;
      // Reachable from every workspace while it belongs to none, and settled by
      // landing on a panel - exactly as `move_item_to_panel` above, because
      // putting an item on a panel is putting it on a panel whichever of the
      // two commands says so. Without this, adding an undecided item to a panel
      // left it filed *and* still in every other workspace's Inbox, which is a
      // state the rule does not have.
      const item = getItem(db, tenantId, cmd.itemId);
      if (!item || (item.workspaceDecided && item.workspaceId !== cmd.workspaceId)) {
        throw new ItemNotFoundError(cmd.itemId);
      }
      const panel = panelTheChangeIsAbout(db, tenantId, cmd.workspaceId, cmd.panelId);
      // The same rule the move above carries, and for the same reason.
      refuseAPanelOfText(panel);

      refuseAStaleOrder(db, tenantId, { ...cmd, panelId: panel.id });

      // Read before the write, for the reason `move_item_to_panel` reads it:
      // the ordinary path onto this command is already-filed ("Add to…" on a
      // Panel, offered only there), but nothing here refuses one aimed at an
      // Item still in the Inbox - and landing on a Panel for the first time
      // is a routing settling whichever of the two commands does it (see the
      // comment above on why this command settles the Workspace too).
      const alreadyFiled = isItemFiled(db, tenantId, cmd.itemId);

      const decided = decideWorkspace(item, cmd.workspaceId, cmd.issuedAt);
      if (decided) everyWorkspaceSees(commandRow);

      const rows = filingRows(tenantId, { ...cmd, panelId: panel.id });
      db.transaction((tx) => {
        if (decided) settleWorkspace(tx, tenantId, cmd.itemId, decided);
        // Only this panel's rows. **The whole difference from a move is the
        // delete that is not here**: the panels the item was already on keep
        // it, which is what makes one item on several panels a thing at all.
        tx.delete(panelItems)
          .where(and(eq(panelItems.tenantId, tenantId), eq(panelItems.panelId, panel.id)))
          .run();
        for (const batch of inBatchesOf(rows, FILING_VALUES_PER_ROW)) {
          tx.insert(panelItems).values(batch).run();
        }
        if (!alreadyFiled) {
          settledRouting = true;
          tx.insert(decisionHistory)
            .values(decisionHistoryEntryFor(item, cmd, panel.id))
            .onConflictDoNothing()
            .run();
          // Spent the moment it is read - see the identical write in
          // `move_item_to_panel` above for why.
          tx.update(items)
            .set({ proposedPanelId: null, proposedPanelReason: null })
            .where(and(eq(items.tenantId, tenantId), eq(items.id, cmd.itemId)))
            .run();
        }
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
      // A name another type has is refused, exactly as a workspace's is. It
      // used to reuse the existing type in silence, which was right while the
      // only way to make one was naming it at capture - the gesture was "this
      // is a thought", and it meant the same whether or not the type existed a
      // moment ago. Making one is now a deliberate box in the window they are
      // managed in ("Make a type where types are managed, not while capturing",
      // issue 203), where a silent reuse is a button that appears to do
      // nothing.
      const alreadyCalledThat = itemTypeNamed(already, cmd.name);
      if (alreadyCalledThat) throw new ItemTypeNameTakenError(alreadyCalledThat.name);
      db.transaction((tx) => {
        tx.insert(itemTypes)
          .values({
            ...itemTypeFromCommand(cmd, tenantId, already, lastItemTypePosition(db, tenantId)),
            foldedName: foldName(cmd.name),
            deletedAt: null,
          })
          // Bare, and unlike `create_workspace`'s, which names its primary key.
          // Either conflict this can hit proves the request has already been
          // granted: on the id, the same create replayed after its command row
          // was lost; on the folded name, another tab that won the race past
          // the check above. Both leave exactly one type going by that name, so
          // answering "done" is true - which is the thing the workspaces' bare
          // call could not promise.
          .onConflictDoNothing()
          .run();
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
      // Its associations are read in every workspace the item is drawn in, so
      // for one that belongs to none that is all of them.
      if (!existing.workspaceDecided) everyWorkspaceSees(commandRow);
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
    case 'propose_item_texts': {
      const cmd = payload as CommandPayload<'propose_item_texts'>;
      const existing = getItem(db, tenantId, cmd.itemId);
      // The same 404 every other command that names an item answers with, and
      // it is the ordinary case here rather than a caller's mistake: the job
      // that sends this carries an item id from minutes ago, and the item may
      // have been dismissed and erased, or may belong to another account
      // entirely - in which case this read simply matches no row, because every
      // query filters on the account ("Clean up a captured note into a clear
      // title and a fuller message", issue 296).
      if (!existing) throw new ItemNotFoundError(cmd.itemId);
      // An item belonging to no workspace is drawn in every workspace's Inbox,
      // so the two texts a row shows changing is a change every open tab has to
      // hear about, not only the one the envelope names.
      if (!existing.workspaceDecided) everyWorkspaceSees(commandRow);

      const updated = applyProposedTexts(existing, cmd);
      if (updated === null) {
        // The texts are somebody's own now, so there is nothing to write. The
        // command is still logged, which is what makes a redelivery of this
        // same job a replay rather than a second decision.
        //
        // **The read that refused it cannot go stale before the write.**
        // `runCommand` is synchronous end to end and a Durable Object runs one
        // thing at a time (see this function's own note about `db.transaction`),
        // so the read above and the write below are one indivisible step: an
        // edit made while the model was thinking is already here, and one made
        // after this waits until it is done.
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
    case 'propose_item_panel': {
      const cmd = payload as CommandPayload<'propose_item_panel'>;
      const existing = getItem(db, tenantId, cmd.itemId);
      // The same 404 every other command naming an item answers with, and the
      // ordinary case here rather than a caller's mistake - the job that sends
      // this carries an item id from minutes ago ("Propose where a captured
      // note belongs, without filing it there", issue 298).
      if (!existing) throw new ItemNotFoundError(cmd.itemId);
      if (!existing.workspaceDecided) everyWorkspaceSees(commandRow);

      // A withdrawal names no Panel to look up - `null` is the answer itself,
      // not something to resolve ("Re-propose the rest of the inbox the
      // moment you file one", issue 300).
      const panel = cmd.panelId ? liveDestinationPanel(db, tenantId, existing.workspaceId, cmd.panelId) : null;
      // Settling a routing is filing it, so an Item already on some Panel has
      // already answered the question this proposes - by hand, or by taking an
      // earlier proposal - and there is nothing left to overwrite, a
      // withdrawal included: it too would misattribute a live filing to a
      // decision that already happened.
      const usable = (cmd.panelId === null || panel !== null) && !isItemFiled(db, tenantId, cmd.itemId);

      if (!usable) {
        // Discarded, not refused: nothing a queued job sent is a mistake worth
        // reporting to anybody, and the command is still logged so a
        // redelivery of the same job is a replay rather than a second
        // decision.
        db.insert(commands).values(commandRow).run();
        applied = false;
      } else {
        const updated = applyProposedPanel(existing, cmd);
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
    default: {
      // All remaining commands are updates to a single existing item.
      const cmd = payload as
        | CommandPayload<'set_done'>
        | CommandPayload<'set_dismissed'>
        | CommandPayload<'set_next_action'>
        | CommandPayload<'set_priority'>
        | CommandPayload<'set_title'>
        | CommandPayload<'set_description'>;
      const existing = getItem(db, tenantId, cmd.itemId);
      if (!existing) throw new ItemNotFoundError(cmd.itemId);
      // Finishing with an item that belongs to no workspace, or dismissing one,
      // takes it out of *every* workspace's Inbox rather than one - so every
      // one of them has to be told, not the one the envelope happens to name.
      if (!existing.workspaceDecided) everyWorkspaceSees(commandRow);

      const updated =
        name === 'set_done'
          ? applySetDone(existing, cmd as CommandPayload<'set_done'>)
          : name === 'set_dismissed'
            ? applySetDismissed(existing, cmd as CommandPayload<'set_dismissed'>)
            : name === 'set_next_action'
              ? applySetNextAction(existing, cmd as CommandPayload<'set_next_action'>)
              : name === 'set_title'
                ? applySetTitle(existing, cmd as CommandPayload<'set_title'>)
                : name === 'set_description'
                  ? applySetDescription(existing, cmd as CommandPayload<'set_description'>)
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
  return settledRouting ? { ok: true, applied, settledRouting } : { ok: true, applied };
}
