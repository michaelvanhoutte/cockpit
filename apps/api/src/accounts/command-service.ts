import { and, eq, exists, gt, inArray, isNull, notExists, sql } from 'drizzle-orm';
import { CLAUDE_REPORTED_STAGES, REPORT_NOTE_LIMIT, claudeResultLink, claudeSessionLink, firstDayAfter, nextColor, REMEMBERED_SENTENCES_KEPT, uuidv7 } from '@cockpit/shared';
import type { CommandName, CommandPayload, CommandResult, Item, PanelKind } from '@cockpit/shared';
import { SENTENCE_POINTS_SOMEWHERE, onOneLine, sentenceMayBeKept } from '../domain/remembered-sentences.js';
import type { AccountDb } from './client.js';
import { dropPulledWanted, wantPulledOpenStateMirrored } from './pulled-open-state.js';
import {
  accountItemFormPresentation,
  agentRuns,
  associations,
  attachments,
  commands,
  connectionFailures,
  connectorAccounts,
  dashboards,
  DEAD_STATUS_VALUE,
  decisionHistory,
  items,
  layoutRows,
  layouts,
  panelItems,
  panelPlacements,
  panels,
  pulledConnections,
  series,
  seriesPanels,
  textCorrections,
  workspaces,
} from './schema.js';
import {
  commandAlreadyApplied,
  anotherRunStartedSince,
  getAgentRun,
  getAttachment,
  getDashboard,
  getItem,
  getLayout,
  getPanel,
  getSeries,
  getSourceAccount,
  givenDueDateOf,
  getWorkspace,
  insertWorkspace,
  isItemFiled,
  lastDashboardPosition,
  lastWorkspacePosition,
  latestOccurrence,
  masterPanelIdsOf,
  panelIdsOf,
  listDashboards,
  openAgentRunOn,
  recordClaudeSend,
  rememberSentence,
  editRememberedSentence,
  deleteRememberedSentence,
  countSentencesUsed,
  listFilingsOnPanel,
  listLayoutIds,
  listLayoutRows,
  layoutOfDashboard,
  listPanels,
  listPlacements,
  listWorkspaces,
  settleDuplicate,
  storedRowsOf,
  textCorrectionExistsFor,
} from './repo.js';
import { attachmentFromCommand } from '../domain/attachments.js';
import { captureDay } from '../domain/capture-day.js';
import { recordOfSend } from '../domain/claude-send-records.js';
import { couldStillBeActedOn, pairOf } from '../domain/duplicates.js';
import {
  ACCOUNT_WIDE,
  isPaletteTint,
  panelFilterAsStored,
  panelSortAsStored,
  panelGathers,
  panelHoldsText,
  panelTakesItems,
} from '@cockpit/shared';
import { foldName } from '../domain/names.js';
import { decideSourceConnection } from '../domain/connections.js';
import {
  dashboardFromCommand,
  dashboardNamed,
  firstDashboardFor,
  ordersDashboardsExactly,
} from '../domain/dashboards.js';
import {
  FILING_VALUES_PER_ROW,
  decideAddToPanel,
  decideCaptureFiling,
  decideFilingWhereSaid,
  decideMoveToPanel,
  filingRows,
  whyNothingIsFiledOn,
  type FiledWhereSaid,
  type FilingDecided,
  type FilingFacts,
  type FilingRefusal,
  type FilingRow,
  type NamedPanel,
} from '../domain/filings.js';
import {
  LAYOUT_ROW_VALUES_PER_ROW,
  PLACEMENT_VALUES_PER_ROW,
  appendedPlacement,
  decideLayoutSave,
  firstPanelFor,
  panelFromCommand,
  panelNameForMove,
  panelNamed,
} from '../domain/panels.js';
import { inBatchesOf } from '../domain/statements.js';
import {
  nextPosition,
  ordersExactly,
  workspaceFromCommand,
  workspaceNamed,
} from '../domain/workspaces.js';
import { decideClaudeSend } from '../domain/claude-sends.js';
import { textCorrectionFor } from '../domain/text-corrections.js';
import { UNKNOWN_TIME_ZONE, countedFrom, decideRepeat, masterContentOf, occurrenceDueAt, occurrenceOf } from '../domain/series.js';
import {
  applyProposedFields,
  type FieldsSet,
  applyProposedPanel,
  applyClaudeProposals,
  applyProposedTexts,
  applySetDescription,
  applySetDismissed,
  applySetDone,
  applySetStarted,
  applyWaitForReply,
  applySetDueDate,
  applySetNextAction,
  applySetPriority,
  applySetTitle,
  asStored,
  associationFromCommand,
  captureItem,
  decideWorkspace,
} from '../domain/items.js';

/**
 * A send Claude may not be given, in words the row can show as they are
 * ("Send an item to Cowork or Claude Code with its prompt reviewed first",
 * issue 1159): an Item already carrying a run or finished with.
 */
export class AgentRunRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentRunRefusedError';
  }
}

export class AgentRunNotFoundError extends Error {
  constructor(runId: string) {
    super(`agent run ${runId} not found`);
    this.name = 'AgentRunNotFoundError';
  }
}

export class ItemNotFoundError extends Error {
  constructor(itemId: string) {
    super(`item ${itemId} not found`);
    this.name = 'ItemNotFoundError';
  }
}

/**
 * `add_attachment` naming an `attachmentId` this account already has, for an
 * upload that is not the same one replayed ("Attach a file to an item",
 * issue 441). `commandAlreadyApplied` already covers a genuine retry - the
 * same `commandId` sent twice never reaches `runCommand`'s switch at all -
 * so this is a *different* `commandId` reusing an old `attachmentId`, which
 * `attachmentId`s being client-generated makes possible: naming a different
 * item, or naming the same item with a different filename, size or type.
 * Refused rather than silently accepted, so R2 (already written by the
 * upload route by the time this runs) and the row describing it can never
 * disagree about which upload actually happened.
 */
export class AttachmentIdTakenError extends Error {
  constructor(attachmentId: string) {
    super(`attachment ${attachmentId} already names a different upload`);
    this.name = 'AttachmentIdTakenError';
  }
}

/** A Repeats change that is refused, in the words the person is told beside the field ("Set an Item to repeat from its form", issue 1406). */
export class RepeatRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RepeatRefusedError';
  }
}

/** A wait for a reply that is refused, in the words the person is told ("Set an Item Waiting for reply", issue 1463). */
export class WaitRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WaitRefusedError';
  }
}

/** A sentence to remember that is refused, in the words the person is told (issue 1163). */
export class SentenceRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SentenceRefusedError';
  }
}

/** A remembered sentence that is not in the account, most likely deleted from another tab (issue 1164). */
export class SentenceNotFoundError extends Error {
  constructor(sentenceId: string) {
    super(`remembered sentence ${sentenceId} not found`);
    this.name = 'SentenceNotFoundError';
  }
}

export class WorkspaceNotFoundError extends Error {
  constructor(workspaceId: string) {
    super(`workspace ${workspaceId} not found`);
    this.name = 'WorkspaceNotFoundError';
  }
}

/**
 * A disconnect naming a source account this account no longer has ("Connect a
 * Microsoft Teams source account", issue 485) - most likely another tab's
 * disconnect winning the race.
 */
export class SourceAccountNotFoundError extends Error {
  constructor(sourceAccountId: string) {
    super(`source account ${sourceAccountId} not found`);
    this.name = 'SourceAccountNotFoundError';
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

/** The same collision `WorkspaceOrderStaleError` names, one level down: a whole order sent against a workspace whose dashboards have moved on. */
export class DashboardOrderStaleError extends Error {
  constructor() {
    super('the dashboards changed while they were being put in order');
    this.name = 'DashboardOrderStaleError';
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

/**
 * A panel asked to move to the dashboard it is already on ("Move a panel to
 * another dashboard, from its menu or by dragging it onto a tab", issue 439).
 *
 * A 400 rather than a 404 or a 409: both the panel and the dashboard are
 * exactly what the request says, and what is wrong is that moving there is
 * not a move at all. The picker never offers it and a drag onto the tab
 * already open is read as no drop, so a person only reaches this through a
 * stale client.
 */
export class PanelAlreadyOnDashboardError extends Error {
  constructor(panelName: string, dashboardName: string) {
    super(`${panelName} is already on ${dashboardName}`);
    this.name = 'PanelAlreadyOnDashboardError';
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
 * Refuses a panel nothing is filed onto where an item is being filed - one of
 * text, or a Filter, which gathers what is filed elsewhere.
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
function refuseAPanelNothingIsFiledOn(panel: { name: string; kind: PanelKind } | null) {
  const why = panel && whyNothingIsFiledOn(panel);
  if (why) throw new PanelHoldsSomethingElseError(why);
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
  if (!panelHoldsText(panel)) {
    throw new PanelHoldsSomethingElseError(`${panel.name} holds items, not text`);
  }
}

/**
 * Refuses a panel that is not a Filter where its conditions are being set
 * ("Add a Filter panel that shows every filed item due in a window", issue 463).
 *
 * The third of the same family, for the reason the second exists: what a panel
 * is made of is settled when it is made, so a command about one kind reaching
 * another is a stale client rather than a state to accept quietly.
 */
function refuseUnlessAFilter(panel: { name: string; kind: PanelKind }) {
  if (!panelGathers(panel)) {
    throw new PanelHoldsSomethingElseError(`${panel.name} is not a filter`);
  }
}

/**
 * Refuses a sort for a panel with no rows to sort, and Manual for a Filter
 * ("Sort a panel of items by the fields you choose", issue 526; "Choose how a
 * Filter's rows are sorted", issue 527). A panel of text has no rows; a
 * Filter's rows are gathered rather than filed, so it has no order of its own
 * to go back to. The fourth of the same family, for the same reason.
 */
function refuseUnlessSortable(
  panel: { name: string; kind: PanelKind },
  sort: readonly unknown[] | null,
) {
  if (panelTakesItems(panel)) return;
  if (!panelGathers(panel)) {
    throw new PanelHoldsSomethingElseError(`${panel.name} holds text, so it has no rows to sort`);
  }
  if (sort === null) {
    throw new PanelHoldsSomethingElseError(`${panel.name} is a filter, which is never Manual`);
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
 * that failing any of it answers `null` rather than throwing, and that a Panel
 * flagged Never propose fails it too, though a person may still file there.
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
  // A panel flagged Never propose is checked here, freshly, for the reason
  // a deleted one is: it may have been flagged since the prompt was built.
  if (!panel || !panelTakesItems(panel) || panel.neverPropose) return null;
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

/**
 * Every layout of a dashboard, with a fresh placement for one panel appended
 * to each - a row of its own, under everything already there.
 *
 * Read before the transaction that writes it (`add_panel`,
 * `move_panel_to_dashboard`), because the caller's own copy of the
 * dashboard's layouts can be stale - the same reason a new workspace's colour
 * is picked here rather than sent.
 */
function appendedAcrossLayouts(
  db: AccountDb,
  tenantId: string,
  dashboardId: string,
  panelId: string,
) {
  return listLayoutIds(db, tenantId, dashboardId).map((layoutId) =>
    appendedPlacement(tenantId, layoutId, panelId, listLayoutRows(db, tenantId, layoutId)),
  );
}

/** Writes what `appendedAcrossLayouts` computed: the row first, since the placement points at it. */
function insertAppended(
  tx: InATransaction,
  appended: ReturnType<typeof appendedAcrossLayouts>,
): void {
  for (const { row, placement } of appended) {
    tx.insert(layoutRows)
      .values(row)
      .onConflictDoNothing({ target: [layoutRows.layoutId, layoutRows.rowIndex] })
      .run();
    tx.insert(panelPlacements)
      .values(placement)
      .onConflictDoNothing({ target: [panelPlacements.layoutId, panelPlacements.panelId] })
      .run();
  }
}

/**
 * Takes a panel out of every layout of the dashboard it is on: its placement
 * in each, and any row that placement leaves holding nothing.
 *
 * Shared by `delete_panel`, which tombstones the panel once this has run, and
 * `move_panel_to_dashboard`, which gives it a new dashboard instead - both
 * leave the same hole in the dashboard being left.
 */
function removedFromItsLayouts(
  tx: InATransaction,
  tenantId: string,
  dashboardId: string,
  panelId: string,
): void {
  // Out of every layout of the dashboard, in one statement: a layout is a
  // list of where the panels are, and one naming a panel nobody can see
  // would be a hole no gesture could fill. Deleted rather than
  // tombstoned, like the layouts they belong to - the reason is on
  // `panelPlacements` in schema.ts.
  tx.delete(panelPlacements)
    .where(and(eq(panelPlacements.tenantId, tenantId), eq(panelPlacements.panelId, panelId)))
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
        // A Section holds no panels and stays with nothing under it.
        isNull(layoutRows.title),
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
                eq(layouts.dashboardId, dashboardId),
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
}

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
 * Everything the domain needs to decide a filing, read before it decides: the
 * store is asked, the domain answers (`decideMoveToPanel`, `decideAddToPanel`).
 * `named` is the Panels a move takes the Item off.
 */
function filingFactsFor(
  db: AccountDb,
  tenantId: string,
  cmd: { workspaceId: string; itemId: string; panelId: string | null },
  named: readonly string[],
): FilingFacts {
  const item = getItem(db, tenantId, cmd.itemId);
  const found = cmd.panelId ? getPanel(db, tenantId, cmd.panelId) : null;
  // A Panel is the Workspace's only where its dashboard is.
  const panel = found && getDashboard(db, tenantId, cmd.workspaceId, found.dashboardId) ? found : null;
  return {
    item,
    workspaceExists: !!getWorkspace(db, tenantId, cmd.workspaceId),
    panel: panel ? { id: panel.id, name: panel.name, kind: panel.kind } : null,
    held: panel ? listFilingsOnPanel(db, tenantId, panel.id) : [],
    alreadyFiled: isItemFiled(db, tenantId, cmd.itemId),
    proposedPanelNeverPropose: item?.proposedPanelId
      ? !!getPanel(db, tenantId, item.proposedPanelId)?.neverPropose
      : false,
    sources: named.map((id) => {
      const from = getPanel(db, tenantId, id);
      return {
        id,
        exists: !!from,
        ofTheWorkspace: !!from && !!getDashboard(db, tenantId, cmd.workspaceId, from.dashboardId),
      };
    }),
  };
}

/** A filing the domain accepted as it is, or the error its refusal is. */
function refusedOrFiling(decision: FilingRefusal | FilingDecided): FilingDecided {
  switch (decision.refusal) {
    case null:
      return decision;
    case 'item-not-found':
      throw new ItemNotFoundError(decision.id);
    case 'workspace-not-found':
      throw new WorkspaceNotFoundError(decision.id);
    case 'panel-not-found':
      throw new PanelNotFoundError(decision.id);
    case 'panel-holds-something-else':
      throw new PanelHoldsSomethingElseError(decision.why);
    case 'order-stale':
      throw new PanelOrderStaleError(decision.why);
  }
}

/**
 * A filing as a source made it: the same rows, and no decision recorded, since
 * the source's name rather than a person's choice put it there and routing
 * learns only from people ("File Outlook mail on the Panel named after its
 * category", issue 1146).
 */
function asTheSourceFiles(decided: FilingDecided, fromTheSource: boolean): FilingDecided {
  return fromTheSource ? { ...decided, decision: null } : decided;
}

/** Writes what a filing decided, inside the transaction of the change that made it. */
function writeFiling(
  tx: InATransaction,
  tenantId: string,
  itemId: string,
  decided: FilingDecided,
): void {
  if (decided.workspaceSettled) settleWorkspace(tx, tenantId, itemId, decided.workspaceSettled);
  // Off the Panels it is moved from first, which is what makes this a move
  // rather than an add: the item's own rows there go, and the target panel's
  // arrangement is then written whole.
  if (decided.takesItOffPanels) {
    tx.delete(panelItems)
      .where(
        and(
          eq(panelItems.tenantId, tenantId),
          eq(panelItems.itemId, itemId),
          decided.fromPanelIds ? inArray(panelItems.panelId, decided.fromPanelIds) : undefined,
        ),
      )
      .run();
  }
  if (!decided.panelId) return;
  // Replaced whole rather than merged: an order is the answer to "where do
  // these items go now", so a row not in it must not survive.
  tx.delete(panelItems)
    .where(and(eq(panelItems.tenantId, tenantId), eq(panelItems.panelId, decided.panelId)))
    .run();
  for (const batch of inBatchesOf(decided.rows, FILING_VALUES_PER_ROW)) {
    tx.insert(panelItems).values(batch).run();
  }
  if (!decided.decision) return;
  tx.insert(decisionHistory).values(decided.decision).onConflictDoNothing().run();
  // The proposal is spent the moment it is read into that entry - cleared here
  // so an Item that returns to the Inbox and is filed again cannot have its
  // original proposal misattributed to a decision it was never shown for.
  tx.update(items)
    .set({ proposedPanelId: null, proposedPanelReason: null, proposedPanelFit: null })
    .where(and(eq(items.tenantId, tenantId), eq(items.id, itemId)))
    .run();
}

/**
 * A Panel a captured note named, as it stands now: null where it has gone, or
 * where it, its Dashboard or the Workspace is not live in the Workspace the
 * Item is in. Never propose is not read: the note chose it (issue 1116).
 */
function panelNamedFor(db: AccountDb, tenantId: string, workspaceId: string, panelId: string): NamedPanel | null {
  if (!getWorkspace(db, tenantId, workspaceId)) return null;
  const panel = getPanel(db, tenantId, panelId);
  if (!panel || !getDashboard(db, tenantId, workspaceId, panel.dashboardId)) return null;
  return { id: panel.id, name: panel.name, kind: panel.kind, held: listFilingsOnPanel(db, tenantId, panel.id) };
}

/**
 * Writes a captured note's filing on the Panels it named, inside the
 * transaction of the change that settles it: each Panel's order whole, the one
 * decision, and the proposal withdrawn - as `writeFiling` does for a person's.
 */
function writeFilingWhereSaid(tx: InATransaction, tenantId: string, itemId: string, filed: FiledWhereSaid): void {
  writePanelOrders(tx, tenantId, filed.panels);
  tx.insert(decisionHistory).values(filed.decision).onConflictDoNothing().run();
  tx.update(items)
    .set({ proposedPanelId: null, proposedPanelReason: null, proposedPanelFit: null })
    .where(and(eq(items.tenantId, tenantId), eq(items.id, itemId)))
    .run();
}

/** Each Panel's order written whole: its filings taken out, and the order it is left with put in. */
function writePanelOrders(tx: InATransaction, tenantId: string, panels: readonly { panelId: string; rows: FilingRow[] }[]): void {
  for (const panel of panels) {
    tx.delete(panelItems)
      .where(and(eq(panelItems.tenantId, tenantId), eq(panelItems.panelId, panel.panelId)))
      .run();
    for (const batch of inBatchesOf(panel.rows, FILING_VALUES_PER_ROW)) {
      tx.insert(panelItems).values(batch).run();
    }
  }
}

/** What a series' day comes to, read from the store before anything is written (`bring_back_occurrence`). */
type OccurrenceBrought =
  /** Stopped, or its Next on moved, since the alarm read it. */
  | { kind: 'not due' }
  /** A series holding nothing to copy, or whose Workspace is gone: it stops rather than write an Item. */
  | { kind: 'stops'; because: string; workspaceId: string | null }
  /**
   * The previous occurrence still open, or this day's Item already written:
   * Next on moves on, and nothing is added.
   */
  | { kind: 'passes over'; nextOn: string; anchorOn: string; workspaceId: string | null }
  | {
      kind: 'writes';
      nextOn: string;
      anchorOn: string;
      /** Where it is told: null for every Workspace. */
      workspaceId: string | null;
      item: Item;
      panels: { panelId: string; rows: FilingRow[] }[];
    };

/**
 * Reads what a series' day comes to ("Make each copy of a recurring item from
 * its own series", issue 1448), for `bring_back_occurrence` to write in one
 * transaction.
 *
 * **A copy is made from the series, never from an earlier copy**: its title,
 * description, priority and Workspace, **at the top of each of its Panels
 * still live in that Workspace, or in the Inbox where none is**, and no files.
 * **Never more than one open**: the latest copy still To do or In progress
 * means nothing is added; finished with or dismissed, it counts as handled.
 * Either way Next on moves to the first day the series comes round after today
 * on its own calendar, so a store asleep for a week brings back one
 * occurrence, not seven, and none on a day already passed. **A day whose Item
 * is already written is passed over** - its Next on put back on it after it
 * came round - so it is never written twice. The day it is counted from is
 * kept as it was read (`countedFrom`), so a series set before it was stored
 * counts from the same day ever after.
 */
function decideOccurrence(db: AccountDb, tenantId: string, cmd: CommandPayload<'bring_back_occurrence'>): OccurrenceBrought {
  const own = getSeries(db, tenantId, cmd.seriesId);
  if (!own || own.stoppedAt !== null || own.nextOn !== cmd.day) return { kind: 'not due' };
  if (occurrenceDueAt(own) > Date.parse(cmd.issuedAt)) return { kind: 'not due' };
  const today = captureDay(cmd.issuedAt, own.timeZone);
  const { workspaceId, title } = own;
  const previous = latestOccurrence(db, tenantId, own.id);
  // Told to the series' Workspace, where its copies land, unless the latest is
  // drawn elsewhere too - filed in another, or in every Inbox - when every one is.
  const toldIn =
    previous === null || (previous.workspaceDecided && previous.workspaceId === workspaceId) ? workspaceId : null;
  if (today === null) return { kind: 'stops', because: 'its time zone cannot be read', workspaceId: toldIn };
  // Only a series an older release set after the store changed over holds nothing.
  if (title === null || workspaceId === null) {
    return { kind: 'stops', because: 'it holds nothing to copy', workspaceId: toldIn };
  }
  if (!getWorkspace(db, tenantId, workspaceId)) return { kind: 'stops', because: 'its Workspace is gone', workspaceId: toldIn };
  const anchorOn = countedFrom(own);
  const nextOn = firstDayAfter(anchorOn, own.frequency, today.date);
  // A latest copy left in a Workspace deleted since can no longer be finished, so it counts as handled.
  const previousOpen =
    previous !== null &&
    couldStillBeActedOn(previous) &&
    (!previous.workspaceDecided || previous.workspaceId === workspaceId || getWorkspace(db, tenantId, previous.workspaceId) !== null);
  if (getItem(db, tenantId, cmd.itemId) || previousOpen) {
    return { kind: 'passes over', nextOn, anchorOn, workspaceId: toldIn };
  }

  const copied = occurrenceOf({ ...own, workspaceId, title }, previous, {
    itemId: cmd.itemId,
    at: cmd.issuedAt,
    today: today.date,
  });
  const panels = masterPanelIdsOf(db, tenantId, own.id).flatMap((panelId) => {
    const panel = panelNamedFor(db, tenantId, workspaceId, panelId);
    if (!panel || !panelTakesItems(panel)) return [];
    const order = [copied.id, ...panel.held.map((filing) => filing.itemId)];
    return [{ panelId: panel.id, rows: filingRows(tenantId, { itemId: copied.id, panelId: panel.id, order, issuedAt: cmd.issuedAt }) }];
  });
  return { kind: 'writes', nextOn, anchorOn, workspaceId: toldIn, item: copied, panels };
}

/**
 * The Panels the Repeats chip gives a series from the Item it is set on: the
 * Item's own, still live in its Workspace and taking Items, in the order it was
 * filed on them ("Make each copy of a recurring item from its own series",
 * issue 1448).
 */
function masterPanelsFrom(db: AccountDb, tenantId: string, item: Item, seriesId: string, at: string) {
  return panelIdsOf(db, tenantId, item.id)
    .filter((panelId) => {
      const panel = panelNamedFor(db, tenantId, item.workspaceId, panelId);
      return panel !== null && panelTakesItems(panel);
    })
    .map((panelId, position) => ({ tenantId, seriesId, panelId, position, createdAt: at }));
}

/**
 * The command as the log keeps it, which is the command itself for all but
 * one of them.
 *
 * **`connect_source_account` is logged without its sealed credential**
 * ("Connect a Microsoft Teams source account", issue 485). The log is an
 * audit trail that outlives what it refers to, and a credential left in it
 * would still be there after the row holding it was disconnected - which
 * would make disconnecting a lie, since deleting the credential outright is
 * the whole of what it promises. What the entry still says is that a Teams
 * account was connected, which account, and when.
 *
 * **`send_item_to_claude` is logged without its prompts** ("Learn from what you
 * sent to Claude", issue 1162): up to 100,000 characters twice, kept by the
 * send's own record in the shape a proposal learns from, and not worth a second
 * copy in an audit trail that is never read for them.
 */
function forTheLog<N extends CommandName>(name: N, payload: CommandPayload<N>): object {
  if (name === 'send_item_to_claude') {
    const { prompt: _sent, proposed: _proposed, ...rest } = payload as CommandPayload<'send_item_to_claude'>;
    return rest;
  }
  if (name !== 'connect_source_account') return payload;
  const { sealedCredential: _sealed, credentialNonce: _nonce, ...rest } =
    payload as CommandPayload<'connect_source_account'>;
  return rest;
}

/**
 * Ends the Item's open run, if it has one, in the transaction of the change
 * that ends it: Done, To do or Dismiss ("End an Item's agent run from its
 * Status", issue 833). Whatever the run's state - starting, working, waiting
 * on you or refused - and nothing where there is none.
 */
function endTheOpenRun(tx: InATransaction, tenantId: string, itemId: string, at: string): void {
  tx.update(agentRuns)
    .set({ endedAt: at })
    .where(and(eq(agentRuns.tenantId, tenantId), eq(agentRuns.itemId, itemId), isNull(agentRuns.endedAt)))
    .run();
}

/**
 * The run an undo names and may have back, or null.
 *
 * **Only the run the undone change ended**: its end is the very moment the
 * Item was closed (`closedAt`), so a run To do ended earlier, or one a Done
 * never touched, stays ended. Only if the Item is open afterwards, and nothing
 * else has run on it since - a plain Status To do on a Done Item names no run
 * and so revives none.
 */
function runToReopen(
  db: AccountDb,
  tenantId: string,
  cmd: { workspaceId: string; itemId: string; reopensRunId?: string | undefined },
  closedAt: string | null,
  after: { completedAt: string | null; deletedAt: string | null },
): string | null {
  if (!cmd.reopensRunId || closedAt === null || after.completedAt !== null || after.deletedAt !== null) return null;
  const run = getAgentRun(db, tenantId, cmd.reopensRunId);
  if (!run || run.itemId !== cmd.itemId || run.workspaceId !== cmd.workspaceId) return null;
  if (run.endedAt !== closedAt) return null;
  if (openAgentRunOn(db, tenantId, cmd.itemId)) return null;
  if (anotherRunStartedSince(db, tenantId, cmd.itemId, run.id, run.endedAt)) return null;
  return run.id;
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
 *
 * **`fromTheSource`** marks a change a source reported rather than one a
 * person made (issue 728): what the source says is already so there, so it
 * asks nothing of the source in return; and a filing it makes records no
 * routing decision (issue 1146).
 *
 * **`mirroring`** is which pulled connectors mirror open state, the registry's
 * to say: a person's Done, Dismiss or their undo records the wanted state on
 * the Item's link at one of them, in the same transaction
 * (`pulled-open-state.ts`, issue 893).
 */
export function runCommand<N extends CommandName>(
  db: AccountDb,
  tenantId: string,
  name: N,
  payload: CommandPayload<N>,
  { fromTheSource = false, mirroring = [] }: { fromTheSource?: boolean; mirroring?: readonly string[] } = {},
): CommandResult {
  if (commandAlreadyApplied(db, payload.commandId)) {
    return { ok: true, applied: false };
  }

  const commandRow = {
    commandId: payload.commandId,
    tenantId,
    workspaceId: payload.workspaceId,
    name,
    payload: JSON.stringify(forTheLog(name, payload)),
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
  // Set only by `set_title`/`set_description`, and only where a
  // `text_corrections` row was actually inserted or updated below - the same
  // signal the HTTP layer needs to know a correction was genuinely recorded
  // just now, read off this atomic call rather than by asking separately
  // whether `textsProposedAt` was set before this write landed ("Re-read the
  // rest of the inbox the moment you fix a title", issue 399).
  let recordedCorrection = false;
  // Set only by `propose_item_fields`, where it applied.
  let fieldsSet: FieldsSet | null = null;

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
      // The conflict target (`ON CONFLICT (id)` in `insertWorkspace`) is
      // load-bearing, and this is the one table where leaving it off is
      // dangerous. A bare `DO NOTHING` means *any* conflict,
      // and workspaces now carry a second unique index - the one on the name.
      // Two creates of the same name racing past the check above would then
      // both answer "done" while the second wrote nothing at all: the box
      // clears, the list is re-read, and the workspace is simply not there.
      // Named at the primary key, the id replay stays a no-op and a name
      // collision raises, which is what the index is for. (`items` and
      // `associations` have no second unique index, so their bare calls below
      // mean only what they say.)
      db.transaction((tx) => {
        insertWorkspace(tx, workspace);
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
      // After every dashboard this workspace has ever had, so a new one turns
      // up at the end of the bar rather than in the middle of it.
      const goesAfter = nextPosition(lastDashboardPosition(db, tenantId, cmd.workspaceId));
      db.transaction((tx) => {
        const dashboard = dashboardFromCommand(cmd, tenantId, goesAfter);
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
    case 'reorder_dashboards': {
      const cmd = payload as CommandPayload<'reorder_dashboards'>;
      if (!getWorkspace(db, tenantId, cmd.workspaceId)) {
        throw new WorkspaceNotFoundError(cmd.workspaceId);
      }
      // One list, one question: is this an order of the dashboards this
      // workspace actually has? It answers "is the dashboard that moved still
      // there" at the same time, because the wire schema has already made that
      // id one of the ones in the list - and it is what refuses an order
      // naming another workspace's dashboard, since the list is read per
      // workspace.
      const live = listDashboards(db, tenantId, cmd.workspaceId);
      if (!ordersDashboardsExactly(live, cmd.dashboardIds)) throw new DashboardOrderStaleError();
      db.transaction((tx) => {
        // Every dashboard written, not only the ones that moved, for the reason
        // `reorder_workspaces` writes them all: working out which those are
        // would be a second implementation of the order that could disagree
        // with the first, and it is at most a handful of rows.
        cmd.dashboardIds.forEach((dashboardId, position) => {
          tx.update(dashboards)
            .set({ position })
            // The workspace as well as the id, though the check above has
            // already made every id one of this workspace's: it costs nothing,
            // and it means the write is scoped by itself rather than by an
            // argument about `id` being the primary key.
            .where(
              and(
                eq(dashboards.tenantId, tenantId),
                eq(dashboards.workspaceId, cmd.workspaceId),
                eq(dashboards.id, dashboardId),
              ),
            )
            .run();
        });
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
      // The dashboard's layout, where it has one, gets the new panel appended
      // in a row of its own, so it is drawn without anybody arranging it.
      const appended = appendedAcrossLayouts(db, tenantId, dashboard.id, cmd.panelId);
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
        insertAppended(tx, appended);
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
    case 'set_panel_filter': {
      const cmd = payload as CommandPayload<'set_panel_filter'>;
      const panel = panelTheChangeIsAbout(db, tenantId, cmd.workspaceId, cmd.panelId);
      // A panel that is not a Filter has nothing to gather, and setting this
      // column on one would turn it into a Filter after the fact - the one
      // thing "settled when the panel is made" rules out.
      refuseUnlessAFilter(panel);
      db.transaction((tx) => {
        tx.update(panels)
          // The whole Filter, over whatever is there: the question is saved at
          // once, so the later save standing is the same answer this app gives
          // everywhere else.
          .set({
            filterConditions: panelFilterAsStored(cmd.rows, cmd.groupBy),
          })
          .where(and(eq(panels.tenantId, tenantId), eq(panels.id, cmd.panelId)))
          .run();
        tx.insert(commands).values(commandRow).run();
      });
      break;
    }
    case 'set_panel_sort': {
      const cmd = payload as CommandPayload<'set_panel_sort'>;
      const panel = panelTheChangeIsAbout(db, tenantId, cmd.workspaceId, cmd.panelId);
      refuseUnlessSortable(panel, cmd.sort);
      db.transaction((tx) => {
        // The sort alone: the filings keep the order you set, which is what
        // going back to Manual gives back.
        tx.update(panels)
          .set({ sortCriteria: panelSortAsStored(cmd.sort) })
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
    case 'set_panel_never_propose': {
      const cmd = payload as CommandPayload<'set_panel_never_propose'>;
      const panel = panelTheChangeIsAbout(db, tenantId, cmd.workspaceId, cmd.panelId);
      // Nothing is filed onto a panel of text or a Filter, so nothing proposes
      // one, and a flag nobody reads is a state to explain later.
      refuseAPanelNothingIsFiledOn(panel);
      db.transaction((tx) => {
        // The flag alone. A proposal already naming this panel is left stored:
        // the browser hides its chip, and the next refresh overwrites it.
        tx.update(panels)
          .set({ neverPropose: cmd.neverPropose })
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
    case 'set_panel_settings': {
      const cmd = payload as CommandPayload<'set_panel_settings'>;
      const panel = panelTheChangeIsAbout(db, tenantId, cmd.workspaceId, cmd.panelId);
      // Every refusal is decided before the transaction opens, so a refused
      // field writes none of the others.
      if (cmd.neverPropose !== undefined) refuseAPanelNothingIsFiledOn(panel);
      if (cmd.readOnly !== undefined || cmd.format !== undefined) refuseUnlessPanelOfText(panel);
      // A Panel of text has no rows to split; items and Filters both draw some.
      if (cmd.columns !== undefined && panelHoldsText(panel)) {
        throw new PanelHoldsSomethingElseError(`${panel.name} holds text, so it has no rows to split into columns`);
      }
      if (cmd.name !== undefined) {
        const alreadyCalledThat = panelNamed(
          listPanels(db, tenantId, panel.dashboardId),
          cmd.name,
          panel.id,
        );
        if (alreadyCalledThat) throw new PanelNameTakenError(alreadyCalledThat.name);
      }
      db.transaction((tx) => {
        tx.update(panels)
          .set({
            // `foldedName` alongside `name`, as `rename_panel` writes them.
            ...(cmd.name !== undefined ? { name: cmd.name, foldedName: foldName(cmd.name) } : {}),
            ...(cmd.neverPropose !== undefined ? { neverPropose: cmd.neverPropose } : {}),
            ...(cmd.readOnly !== undefined ? { readOnly: cmd.readOnly } : {}),
            ...(cmd.format !== undefined ? { format: cmd.format } : {}),
            ...(cmd.columns !== undefined ? { columns: cmd.columns } : {}),
          })
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
        removedFromItsLayouts(tx, tenantId, going.dashboardId, cmd.panelId);
        tx.update(panels)
          .set({ deletedAt: cmd.issuedAt })
          .where(and(eq(panels.tenantId, tenantId), eq(panels.id, cmd.panelId)))
          .run();
        tx.insert(commands).values(commandRow).run();
      });
      break;
    }
    /**
     * move_panel_to_dashboard - a panel taken off the dashboard it was on and
     * given to another of the same workspace ("Move a panel to another
     * dashboard, from its menu or by dragging it onto a tab", issue 439).
     *
     * Its own dashboard is refused rather than a no-op move (`target.id ===
     * panel.dashboardId`), and a name already taken on the target is renamed
     * rather than refused: unlike adding or renaming a panel, the person
     * moving one is not the one who typed this name and has nothing to
     * retype it into. Everything else about the panel - its items and their
     * order, its kind, text, format and read-only state - is untouched: this
     * changes `dashboardId` and, only where it collided, the name.
     */
    case 'move_panel_to_dashboard': {
      const cmd = payload as CommandPayload<'move_panel_to_dashboard'>;
      const panel = panelTheChangeIsAbout(db, tenantId, cmd.workspaceId, cmd.panelId);
      const target = dashboardTheChangeIsAbout(db, tenantId, cmd.workspaceId, cmd.dashboardId);
      if (target.id === panel.dashboardId) {
        throw new PanelAlreadyOnDashboardError(panel.name, target.name);
      }
      const name = panelNameForMove(listPanels(db, tenantId, target.id), panel.name);
      // The target's layout, where it has one, gets it appended - the same
      // reason `add_panel` does.
      const appended = appendedAcrossLayouts(db, tenantId, target.id, cmd.panelId);
      db.transaction((tx) => {
        // Out of every layout of the dashboard it left, and any row that was
        // holding only this panel - `delete_panel`'s own cleanup, scoped to
        // the dashboard being left rather than the one being tombstoned.
        removedFromItsLayouts(tx, tenantId, panel.dashboardId, cmd.panelId);
        tx.update(panels)
          .set({ dashboardId: target.id, name, foldedName: foldName(name) })
          .where(and(eq(panels.tenantId, tenantId), eq(panels.id, cmd.panelId)))
          .run();
        insertAppended(tx, appended);
        tx.insert(commands).values(commandRow).run();
      });
      break;
    }
    case 'save_layout': {
      const cmd = payload as CommandPayload<'save_layout'>;
      const dashboard = dashboardTheChangeIsAbout(db, tenantId, cmd.workspaceId, cmd.dashboardId);
      // Loaded here, decided in the domain: which panels and layout the save may
      // name, and which layout it means, are `decideLayoutSave`'s.
      const ownLayout = layoutOfDashboard(db, tenantId, dashboard.id);
      const saved = decideLayoutSave(tenantId, dashboard.id, cmd, {
        panels: listPanels(db, tenantId, dashboard.id),
        heldLayoutDashboardId: getLayout(db, tenantId, cmd.layoutId)?.dashboardId ?? null,
        ownLayoutId: ownLayout?.id ?? null,
        // A dashboard with no layout has no rows stored; one read, and only
        // for a save that does not carry its own Sections.
        storedRows: ownLayout && !cmd.carriesSections ? storedRowsOf(db, tenantId, ownLayout.id) : [],
      });
      if (saved.refusal === 'panel-not-found') throw new PanelNotFoundError(saved.id);
      if (saved.refusal === 'layout-not-found') throw new LayoutNotFoundError(saved.id);
      const { layoutId, arrangement } = saved;
      db.transaction((tx) => {
        tx.insert(layouts)
          .values({ id: layoutId, tenantId, dashboardId: dashboard.id, createdAt: cmd.issuedAt })
          // A layout keeps the moment it was first made; changing its
          // arrangement leaves its row alone.
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
          .where(and(eq(panelPlacements.tenantId, tenantId), eq(panelPlacements.layoutId, layoutId)))
          .run();
        tx.delete(layoutRows)
          .where(and(eq(layoutRows.tenantId, tenantId), eq(layoutRows.layoutId, layoutId)))
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
        // **The one exception to the tombstone above, in the same act**
        // ("Connect a Microsoft Teams source account", issue 485). Everything
        // else this Workspace held is kept because the history of it is the
        // product; a connection is a credential, and what makes deleting a
        // Workspace mean anything is that the credentials it connected stop
        // existing rather than sitting in a tombstoned Workspace nobody can
        // see. Inside the same transaction, so there is no moment where the
        // Workspace is gone and its credentials are not.
        tx.delete(connectorAccounts)
          .where(
            and(
              eq(connectorAccounts.tenantId, tenantId),
              eq(connectorAccounts.workspaceId, cmd.workspaceId),
            ),
          )
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
      // The accent is what a theme is picked by: only a palette accent may be
      // stored, which is how "picked from designed options" holds once a wire
      // format can carry anything. The other three colours are not trusted - a
      // tab opened before the palette changed, or a pick replayed from the
      // offline queue, carries an older set - so they are ignored, and only the
      // accent is stored: the rest is the palette's, found by it on every read.
      // The day mixing your own is wanted, this check is what relaxes.
      if (!isPaletteTint(cmd.color)) {
        throw new UnknownThemeError();
      }
      db.transaction((tx) => {
        tx.update(workspaces)
          .set({ color: cmd.color })
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
      // Panels the capture names, read before it is decided and not one of them
      // a reason to refuse it (issue 1101): gone, of another Workspace or an
      // Item already made by an earlier send of this capture all read as
      // nothing to file on. A Panel is the Workspace's only where its dashboard is.
      const named = getItem(db, tenantId, cmd.itemId) ? [] : [...new Set(cmd.panelIds ?? [])];
      const targets = named.flatMap((id) => {
        const panel = getPanel(db, tenantId, id);
        if (!panel || !getDashboard(db, tenantId, cmd.workspaceId, panel.dashboardId)) return [];
        return [{ id: panel.id, name: panel.name, kind: panel.kind, held: listFilingsOnPanel(db, tenantId, panel.id) }];
      });
      const { item, filings } = decideCaptureFiling(captureItem(cmd, tenantId), cmd, targets);
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
        tx.insert(items).values({ ...asStored(item), status: DEAD_STATUS_VALUE }).onConflictDoNothing().run();
        for (const decided of filings) writeFiling(tx, tenantId, item.id, asTheSourceFiles(decided, fromTheSource));
        tx.insert(commands).values(commandRow).run();
      });
      break;
    }
    case 'move_item_to_panel': {
      const cmd = payload as CommandPayload<'move_item_to_panel'>;
      // Loaded here, decided in the domain (`decideMoveToPanel`): every refusal,
      // what settles the Item's Workspace and whether a routing is recorded.
      const named = cmd.panelId === null ? [] : (cmd.fromPanelIds ?? []);
      const decided = refusedOrFiling(decideMoveToPanel(cmd, filingFactsFor(db, tenantId, cmd, named)));
      // It has just left every other workspace's Inbox, so their snapshots are
      // stale too - the same reason a capture with no workspace carries this.
      if (decided.workspaceSettled) everyWorkspaceSees(commandRow);

      db.transaction((tx) => {
        writeFiling(tx, tenantId, cmd.itemId, decided);
        tx.insert(commands).values(commandRow).run();
      });
      if (decided.decision) settledRouting = true;
      break;
    }
    case 'add_item_to_panel': {
      const cmd = payload as CommandPayload<'add_item_to_panel'>;
      // Reachable from every workspace while it belongs to none, and settled by
      // landing on a panel - exactly as a move, because putting an item on a
      // panel is putting it on a panel whichever of the two commands says so.
      const decided = asTheSourceFiles(
        refusedOrFiling(decideAddToPanel(cmd, filingFactsFor(db, tenantId, cmd, []))),
        fromTheSource,
      );
      if (decided.workspaceSettled) everyWorkspaceSees(commandRow);
      db.transaction((tx) => {
        writeFiling(tx, tenantId, cmd.itemId, decided);
        tx.insert(commands).values(commandRow).run();
      });
      if (decided.decision) settledRouting = true;
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
            // Both source columns, as the capture above (`asStored`, domain/items.ts).
            .set(asStored(updated))
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
            // Both source columns, as the capture above (`asStored`, domain/items.ts).
            .set(asStored(updated))
            .where(and(eq(items.tenantId, tenantId), eq(items.id, cmd.itemId)))
            .run();
          tx.insert(commands).values(commandRow).run();
        });
      }
      break;
    }
    case 'propose_item_for_claude': {
      const cmd = payload as CommandPayload<'propose_item_for_claude'>;
      const existing = getItem(db, tenantId, cmd.itemId);
      // The same 404, for the reason `propose_item_panel` above gives.
      if (!existing) throw new ItemNotFoundError(cmd.itemId);
      if (!existing.workspaceDecided) everyWorkspaceSees(commandRow);

      const updated = applyClaudeProposals(existing, cmd);
      if (updated === null) {
        // Discarded rather than refused, as a stale Panel proposal is: the
        // change that made it stale queued the proposal that replaces it.
        db.insert(commands).values(commandRow).run();
        applied = false;
      } else {
        db.transaction((tx) => {
          tx.update(items)
            .set(asStored(updated))
            .where(and(eq(items.tenantId, tenantId), eq(items.id, cmd.itemId)))
            .run();
          // Counted only for a proposal that was written, so a replay or a
          // proposal discarded for a later change uses nothing (issue 1163).
          countSentencesUsed(tx, tenantId, cmd.usedSentenceIds ?? [], cmd.issuedAt);
          tx.insert(commands).values(commandRow).run();
        });
      }
      break;
    }
    case 'edit_remembered_sentence': {
      const cmd = payload as CommandPayload<'edit_remembered_sentence'>;
      everyWorkspaceSees(commandRow);
      // The checks a sentence is kept under, again: what is typed here may have been pasted.
      const sentence = onOneLine(cmd.sentence);
      if (!sentenceMayBeKept(sentence)) throw new SentenceRefusedError(SENTENCE_POINTS_SOMEWHERE);
      db.transaction((tx) => {
        if (!editRememberedSentence(tx, tenantId, cmd.sentenceId, sentence)) throw new SentenceNotFoundError(cmd.sentenceId);
        tx.insert(commands).values(commandRow).run();
      });
      break;
    }
    case 'delete_remembered_sentence': {
      const cmd = payload as CommandPayload<'delete_remembered_sentence'>;
      everyWorkspaceSees(commandRow);
      // Gone already - another tab, or a replay under a new id - is as good as done.
      db.transaction((tx) => {
        deleteRememberedSentence(tx, tenantId, cmd.sentenceId);
        tx.insert(commands).values(commandRow).run();
      });
      break;
    }
    case 'propose_item_fields': {
      const cmd = payload as CommandPayload<'propose_item_fields'>;
      const existing = getItem(db, tenantId, cmd.itemId);
      // The same 404, for the reason `propose_item_texts` above gives.
      if (!existing) throw new ItemNotFoundError(cmd.itemId);
      if (!existing.workspaceDecided) everyWorkspaceSees(commandRow);

      // Decided here, against the Item as it stands, for the reason
      // `propose_item_texts` gives: a priority the person set while the model
      // was reading is already here, and one set after this waits for it.
      const proposed = applyProposedFields(
        existing,
        cmd,
        // Live at the moment of writing, whatever it was when the model was
        // shown its name ("Settle an Any workspace capture in the workspace you
        // name", issue 1078).
        cmd.settleInWorkspaceId !== undefined && !!getWorkspace(db, tenantId, cmd.settleInWorkspaceId),
        // A date still the one its connection gave is open to the reading
        // (issue 1409).
        givenDueDateOf(db, tenantId, cmd.itemId),
      );
      // The Panels the note named, filed on in the same act as the Workspace
      // it settles, each checked as it stands now ("File a capture on the
      // panels you name, read from the spoken path", issue 1116).
      const settledItem = proposed?.item ?? existing;
      const filed =
        cmd.fileOnPanelIds === undefined || cmd.fileOnPanelIds.length === 0
          ? null
          : decideFilingWhereSaid(
              settledItem,
              cmd,
              cmd.fileOnPanelIds.map((panelId) => panelNamedFor(db, tenantId, settledItem.workspaceId, panelId)),
              isItemFiled(db, tenantId, cmd.itemId),
            );
      if (proposed === null && filed === null) {
        // Logged all the same, so a redelivery is a replay.
        db.insert(commands).values(commandRow).run();
        applied = false;
      } else {
        db.transaction((tx) => {
          if (proposed !== null) {
            tx.update(items)
              .set(asStored(proposed.item))
              .where(and(eq(items.tenantId, tenantId), eq(items.id, cmd.itemId)))
              .run();
          }
          if (filed !== null) writeFilingWhereSaid(tx, tenantId, cmd.itemId, filed);
          tx.insert(commands).values(commandRow).run();
        });
        fieldsSet = {
          ...(proposed?.set ?? {}),
          ...(filed === null ? {} : { filedOnPanelIds: filed.panels.map((panel) => panel.panelId) }),
        };
        if (filed !== null) settledRouting = true;
      }
      break;
    }
    case 'set_duplicate_settled': {
      const cmd = payload as CommandPayload<'set_duplicate_settled'>;
      // Both items, because a pair is a fact about two of them and either one
      // may be the one this command was sent from (`ItemForm.tsx`'s "Not a
      // duplicate" next to the *other* Item's link, the row's own menu about
      // itself).
      const one = getItem(db, tenantId, cmd.itemId);
      const other = getItem(db, tenantId, cmd.otherItemId);
      if (!one || !other) throw new ItemNotFoundError(!one ? cmd.itemId : cmd.otherItemId);
      // The same reach `move_item_to_panel` above checks for one Item, here
      // for two: a decided Item belongs to the Workspace it names, and a pair
      // is only ever drawn where both halves could be - so a settle naming a
      // Workspace either decided Item does not belong to could not have come
      // from anything this pair was actually offered in.
      const strayed = [one, other].find(
        (side) => side.workspaceDecided && side.workspaceId !== cmd.workspaceId,
      );
      if (strayed) throw new ItemNotFoundError(strayed.id);
      // A pair drawn in every Workspace either Item belongs to no Workspace
      // yet is the same reach `associate` above answers for one Item - here
      // for two, so either being undecided is enough.
      if (!one.workspaceDecided || !other.workspaceDecided) everyWorkspaceSees(commandRow);

      db.transaction((tx) => {
        settleDuplicate(tx, tenantId, pairOf(cmd.itemId, cmd.otherItemId), cmd.settled, cmd.issuedAt);
        tx.insert(commands).values(commandRow).run();
      });
      break;
    }
    case 'remember_sentence': {
      const cmd = payload as CommandPayload<'remember_sentence'>;
      const workspaceId = cmd.workspaceId === ACCOUNT_WIDE ? null : cmd.workspaceId;
      // A sentence naming a Workspace that is gone has nothing to apply to.
      if (workspaceId !== null && !getWorkspace(db, tenantId, workspaceId)) throw new WorkspaceNotFoundError(workspaceId);
      // A sentence is for every Workspace's proposals unless it names one, and
      // what it changes is proposals, which no tab draws from the stream.
      everyWorkspaceSees(commandRow);
      // Read as an offer is read, though the person confirmed it: it is shown
      // to every later proposal, and what they confirm may have been pasted.
      const sentence = onOneLine(cmd.sentence);
      const action = onOneLine(cmd.action);
      if (!sentenceMayBeKept(sentence, action)) throw new SentenceRefusedError(SENTENCE_POINTS_SOMEWHERE);
      db.transaction((tx) => {
        const kept = rememberSentence(tx, tenantId, {
          id: cmd.sentenceId,
          workspaceId,
          sourceKind: cmd.sourceKind,
          action,
          sentence,
          createdAt: cmd.issuedAt,
        });
        if (kept === 'full') {
          throw new SentenceRefusedError(`Cockpit keeps at most ${REMEMBERED_SENTENCES_KEPT} remembered sentences. Remove one before adding another.`);
        }
        tx.insert(commands).values(commandRow).run();
      });
      break;
    }
    case 'set_item_form_presentation': {
      const cmd = payload as CommandPayload<'set_item_form_presentation'>;
      db.transaction((tx) => {
        // Upserted, because the row may not exist yet, which is every account's
        // starting condition (`schema.ts`'s own comment on
        // `accountItemFormPresentation`). Account-scoped, so `cmd.workspaceId`
        // is `ACCOUNT_WIDE` and never read here.
        tx.insert(accountItemFormPresentation)
          .values({ tenantId, presentation: cmd.presentation })
          .onConflictDoUpdate({
            target: accountItemFormPresentation.tenantId,
            set: { presentation: cmd.presentation },
          })
          .run();
        tx.insert(commands).values(commandRow).run();
      });
      break;
    }
    case 'connect_source_account': {
      const cmd = payload as CommandPayload<'connect_source_account'>;
      // The Workspace is what the connection belongs to, so one that has been
      // deleted while somebody was away at Microsoft is a 404 rather than a
      // row nothing can reach - the same check every other Workspace-scoped
      // command makes, and the reason this is a command at all rather than a
      // write the callback route does itself.
      if (!getWorkspace(db, tenantId, cmd.workspaceId)) {
        throw new WorkspaceNotFoundError(cmd.workspaceId);
      }
      db.transaction((tx) => {
        // The choice the account at this source already held in this Workspace,
        // to tell a reconnect that changes it from one that does not (issue 942).
        const heldRow = tx
          .select({ id: connectorAccounts.id, choice: connectorAccounts.choice })
          .from(connectorAccounts)
          .where(
            and(
              eq(connectorAccounts.tenantId, tenantId),
              eq(connectorAccounts.workspaceId, cmd.workspaceId),
              eq(connectorAccounts.connectorId, cmd.connectorId),
              eq(connectorAccounts.externalAccountKey, cmd.externalAccountKey),
            ),
          )
          .get();
        const decided = decideSourceConnection(
          {
            held: heldRow && {
              id: heldRow.id,
              choice: heldRow.choice,
              failing: !!tx
                .select({ id: connectionFailures.sourceAccountId })
                .from(connectionFailures)
                .where(eq(connectionFailures.sourceAccountId, heldRow.id))
                .get(),
            },
          },
          { sourceAccountId: cmd.sourceAccountId, choice: cmd.choice, issuedAt: cmd.issuedAt },
        );
        tx.insert(connectorAccounts)
          .values({
            id: decided.accountId,
            tenantId,
            workspaceId: cmd.workspaceId,
            connectorId: cmd.connectorId,
            externalAccountKey: cmd.externalAccountKey,
            displayName: cmd.displayName,
            encryptedCredential: cmd.sealedCredential,
            credentialNonce: cmd.credentialNonce,
            connectedAt: cmd.issuedAt,
            updatedAt: cmd.issuedAt,
            // A connect is only ever written once whatever proved it worked
            // has already happened - Microsoft's own identity token here,
            // Claude accepting a test session for Claude Code
            // ("Connect a workspace to Claude Code", issue 569) - so
            // `issuedAt` is as true a "last worked" as a dedicated test.
            lastTestedAt: cmd.issuedAt,
            // What the Connect window asked of a connector that declares a
            // choice (issue 942).
            choice: cmd.choice ?? null,
            // And whether it files by name, answered the same way (issue 1147).
            filesByName: cmd.filesByName ?? false,
            // And whether it gives each Item a due date, and in how many days
            // (issue 1409).
            dueInDays: cmd.dueInDays ?? null,
          })
          // **Named at the account, not at the id, and that is the rule
          // rather than a detail**: connecting the same tenant+account again
          // refreshes the row that is already there ("Connect a Microsoft
          // Teams source account", issue 485) - a fresh
          // credential, a name that may have changed, and the same id it has
          // always had, so nothing pointing at it has to move. `connectedAt`
          // is deliberately left alone: when this Workspace first connected
          // that account is not changed by connecting it again.
          .onConflictDoUpdate({
            target: [
              connectorAccounts.tenantId,
              connectorAccounts.workspaceId,
              connectorAccounts.connectorId,
              connectorAccounts.externalAccountKey,
            ],
            set: {
              displayName: cmd.displayName,
              encryptedCredential: cmd.sealedCredential,
              credentialNonce: cmd.credentialNonce,
              updatedAt: cmd.issuedAt,
              lastTestedAt: cmd.issuedAt,
              // Asked again on a reconnect, so the answer replaces the stored
              // one; a reconnect that asked nothing leaves it.
              ...(decided.choiceOnRefresh !== undefined ? { choice: decided.choiceOnRefresh } : {}),
              // Asked again as well, so the answer given on this reconnect
              // is the one kept (issue 1147).
              ...(cmd.filesByName !== undefined ? { filesByName: cmd.filesByName } : {}),
              // And the days, answered the same way (issue 1409).
              ...(cmd.dueInDays !== undefined ? { dueInDays: cmd.dueInDays } : {}),
            },
          })
          .run();
        // A reconnect under another choice drops what was waiting for the
        // source, as changing it does: a change made under the old choice no
        // longer applies (issue 942).
        if (decided.dropWaiting) {
          dropPulledWanted(tx, tenantId, {
            workspaceId: cmd.workspaceId,
            connectorId: cmd.connectorId,
            externalAccountKey: cmd.externalAccountKey,
          });
        }
        // Reconnecting is proof it works again, so whatever said it was
        // failing ends ("Drop an agent on an item to start a Claude Code
        // session on it", issue 571). Named by the id the account already
        // held, not `sourceAccountId`, which a reconnect's upsert leaves unused.
        if (decided.clearFailure && heldRow) {
          tx.delete(connectionFailures).where(eq(connectionFailures.sourceAccountId, heldRow.id)).run();
        }
        // A pulled connection connected again is checked now with its new
        // sign-in rather than at its next check, which may be five minutes off
        // after a run that failed for want of it (issue 944). One already
        // queued or running keeps its time: that check ends by setting the
        // next, as every run does.
        tx.update(pulledConnections)
          .set({ dueAt: decided.nextCheckDueAt })
          .where(
            and(
              eq(pulledConnections.tenantId, tenantId),
              isNull(pulledConnections.queuedAt),
              isNull(pulledConnections.runId),
              gt(pulledConnections.dueAt, cmd.issuedAt),
              inArray(
                pulledConnections.sourceAccountId,
                tx
                  .select({ id: connectorAccounts.id })
                  .from(connectorAccounts)
                  .where(
                    and(
                      eq(connectorAccounts.tenantId, tenantId),
                      eq(connectorAccounts.workspaceId, cmd.workspaceId),
                      eq(connectorAccounts.connectorId, cmd.connectorId),
                      eq(connectorAccounts.externalAccountKey, cmd.externalAccountKey),
                    ),
                  ),
              ),
            ),
          )
          .run();
        tx.insert(commands).values(commandRow).run();
      });
      break;
    }
    case 'disconnect_source_account': {
      const cmd = payload as CommandPayload<'disconnect_source_account'>;
      // Deleted for real, so a disconnect naming a row that has already gone
      // is a 404 whether the replay carries the original request id (caught
      // above) or a fresh one (caught here).
      //
      // **The Workspace has to be the row's own**, and a mismatch is the same
      // 404 rather than a delete that quietly matches nothing: the id is the
      // one handle a request holds on a connection, so this is what stops one
      // Workspace disconnecting another's by naming it.
      const held = getSourceAccount(db, tenantId, cmd.sourceAccountId);
      if (!held || held.workspaceId !== cmd.workspaceId) {
        throw new SourceAccountNotFoundError(cmd.sourceAccountId);
      }
      db.transaction((tx) => {
        tx.delete(connectorAccounts)
          .where(
            and(
              eq(connectorAccounts.tenantId, tenantId),
              eq(connectorAccounts.id, cmd.sourceAccountId),
              eq(connectorAccounts.workspaceId, cmd.workspaceId),
            ),
          )
          .run();
        // Disconnecting stops the mirroring: a later connection of the
        // account never pushes what a person changed before this one went
        // (issue 893).
        if (held.externalAccountKey) {
          dropPulledWanted(tx, tenantId, {
            workspaceId: held.workspaceId,
            connectorId: held.connectorId,
            externalAccountKey: held.externalAccountKey,
          });
        }
        tx.insert(commands).values(commandRow).run();
      });
      break;
    }
    case 'set_connection_choice': {
      const cmd = payload as CommandPayload<'set_connection_choice'>;
      // The same 404 Disconnect gives: a connection gone meanwhile or another
      // Workspace's is refused and nothing is stored. That the value is one of
      // the connector's options is the route's to check, the store being
      // blind to connectors ("Ask a connection's one choice on connecting, and
      // change it later", issue 942).
      const held = getSourceAccount(db, tenantId, cmd.sourceAccountId);
      if (!held || held.workspaceId !== cmd.workspaceId || !held.externalAccountKey) {
        throw new SourceAccountNotFoundError(cmd.sourceAccountId);
      }
      const externalAccountKey = held.externalAccountKey;
      db.transaction((tx) => {
        // The choice already held changes nothing, what is waiting included.
        if (held.choice !== cmd.choice) {
          tx.update(connectorAccounts)
            .set({ choice: cmd.choice, updatedAt: cmd.issuedAt })
            .where(and(eq(connectorAccounts.tenantId, tenantId), eq(connectorAccounts.id, cmd.sourceAccountId)))
            .run();
          // What was still to reach the source was decided under the old
          // choice, so it is dropped, as disconnecting drops it.
          dropPulledWanted(tx, tenantId, {
            workspaceId: held.workspaceId,
            connectorId: held.connectorId,
            externalAccountKey,
          });
        }
        tx.insert(commands).values(commandRow).run();
      });
      break;
    }
    case 'set_connection_files_by_name': {
      const cmd = payload as CommandPayload<'set_connection_files_by_name'>;
      // Refused as `set_connection_choice` refuses; that the connector reports
      // names at all is the route's to check (issue 1146). Nothing already in
      // is filed: the names each link recorded are the baseline from here.
      const held = getSourceAccount(db, tenantId, cmd.sourceAccountId);
      if (!held || held.workspaceId !== cmd.workspaceId) throw new SourceAccountNotFoundError(cmd.sourceAccountId);
      db.transaction((tx) => {
        if (held.filesByName !== cmd.filesByName) {
          tx.update(connectorAccounts)
            .set({ filesByName: cmd.filesByName, updatedAt: cmd.issuedAt })
            .where(and(eq(connectorAccounts.tenantId, tenantId), eq(connectorAccounts.id, cmd.sourceAccountId)))
            .run();
        }
        tx.insert(commands).values(commandRow).run();
      });
      break;
    }
    case 'set_connection_due_in_days': {
      const cmd = payload as CommandPayload<'set_connection_due_in_days'>;
      // Refused as `set_connection_files_by_name` refuses; that the connector is
      // pulled is the route's to check (issue 1409). Counts from now: no Item
      // already in is given a date, and a date already given stays.
      const held = getSourceAccount(db, tenantId, cmd.sourceAccountId);
      if (!held || held.workspaceId !== cmd.workspaceId) throw new SourceAccountNotFoundError(cmd.sourceAccountId);
      db.transaction((tx) => {
        if (held.dueInDays !== cmd.dueInDays) {
          tx.update(connectorAccounts)
            .set({ dueInDays: cmd.dueInDays, updatedAt: cmd.issuedAt })
            .where(and(eq(connectorAccounts.tenantId, tenantId), eq(connectorAccounts.id, cmd.sourceAccountId)))
            .run();
        }
        tx.insert(commands).values(commandRow).run();
      });
      break;
    }
    case 'add_attachment': {
      const cmd = payload as CommandPayload<'add_attachment'>;
      // Written by the upload route once a file's bytes have already
      // streamed to R2 (`addAttachmentSchema`'s own comment,
      // `@cockpit/shared`), so a missing item here means it was dismissed in
      // the moment between the route's own pre-check and this write -
      // narrow, and left as an orphaned R2 object rather than something
      // this build tries to clean up (issue 441, "Out of scope"). Checked
      // the same way the route's own pre-check does (`item.deletedAt`
      // included, `app.ts`) - an Item is tombstoned, not hard-deleted, so
      // `getItem` alone would otherwise let this race land a file on an
      // Item nothing can reach it through again (`getAttachmentForDownload`
      // excludes a deleted Item's attachments outright).
      const item = getItem(db, tenantId, cmd.itemId);
      if (!item || item.deletedAt) throw new ItemNotFoundError(cmd.itemId);
      // Its attachments are read in every workspace the item is drawn in
      // (`listAttachmentsInWorkspace`, repo.ts), so for one that belongs to
      // none that is all of them - the same rule `associate` above carries.
      if (!item.workspaceDecided) everyWorkspaceSees(commandRow);

      const row = attachmentFromCommand(cmd, tenantId);
      const existing = getAttachment(db, tenantId, cmd.attachmentId);
      // A retried upload sharing the same attachmentId (a client that never
      // saw this call's response and tried the whole upload again) lands on
      // a row already there rather than a conflict - but only where it is
      // genuinely the same upload. `attachmentId` is client-generated, so a
      // *different* commandId naming one an account already has is refused
      // rather than silently accepted: R2 has already been written by the
      // time this runs, and a mismatched row here would leave it describing
      // an upload that never happened.
      if (
        existing &&
        (existing.itemId !== row.itemId ||
          existing.filename !== row.filename ||
          existing.size !== row.size ||
          existing.contentType !== row.contentType)
      ) {
        throw new AttachmentIdTakenError(cmd.attachmentId);
      }
      db.transaction((tx) => {
        if (!existing) tx.insert(attachments).values(row).run();
        tx.insert(commands).values(commandRow).run();
      });
      break;
    }
    case 'remove_attachment': {
      const cmd = payload as CommandPayload<'remove_attachment'>;
      const item = getItem(db, tenantId, cmd.itemId);
      if (!item) throw new ItemNotFoundError(cmd.itemId);
      if (!item.workspaceDecided) everyWorkspaceSees(commandRow);
      db.transaction((tx) => {
        // One row, deleted if it is still there - not refused if it is
        // not: a retried removal (a different commandId naming an
        // attachment this account already removed) is exactly the
        // "idempotent - no error, no second effect" issue 441 asks for,
        // the same shape `remove_item_from_panel` above already takes.
        tx.delete(attachments)
          .where(
            and(
              eq(attachments.tenantId, tenantId),
              eq(attachments.id, cmd.attachmentId),
              eq(attachments.itemId, cmd.itemId),
            ),
          )
          .run();
        tx.insert(commands).values(commandRow).run();
      });
      break;
    }
    case 'set_started': {
      const cmd = payload as CommandPayload<'set_started'>;
      // The same rule `couldStillBeActedOn` already states for a possible
      // duplicate (domain/duplicates.ts): a dismissed Item is not one work can
      // be said to have started on, the same reach `add_attachment` above
      // already refuses on one - and neither is a finished one, which
      // `set_started` alone among the sibling commands here has reason to
      // check: left unrefused, starting an Item already done would sit
      // invisibly behind `itemStatus`'s completedAt-first reading until the
      // Item was undone, and then read as In progress from a moment nothing
      // about undoing Done ever meant to record ("Mark an item In progress,
      // and see since when", issue 568).
      const existing = getItem(db, tenantId, cmd.itemId);
      if (!existing || !couldStillBeActedOn(existing)) throw new ItemNotFoundError(cmd.itemId);
      if (!existing.workspaceDecided) everyWorkspaceSees(commandRow);

      const updated = applySetStarted(existing, cmd);
      if (updated === null) {
        // Stale by last-write-wins: log the command, change nothing.
        db.insert(commands).values(commandRow).run();
        applied = false;
      } else {
        db.transaction((tx) => {
          tx.update(items)
            .set(asStored(updated))
            .where(and(eq(items.tenantId, tenantId), eq(items.id, cmd.itemId)))
            .run();
          // To do ends the run; In progress leaves it open.
          if (!cmd.started) endTheOpenRun(tx, tenantId, cmd.itemId, cmd.issuedAt);
          tx.insert(commands).values(commandRow).run();
        });
      }
      break;
    }
    case 'wait_for_reply': {
      const cmd = payload as CommandPayload<'wait_for_reply'>;
      // Refused on a finished or dismissed Item, for the reason `set_started`
      // above gives: a wait on one would sit unseen behind Done, and read as
      // Waiting for reply from a moment undoing Done never meant ("Set an Item
      // Waiting for reply", issue 1463). The Status control reopens one first.
      const existing = getItem(db, tenantId, cmd.itemId);
      if (!existing || !couldStillBeActedOn(existing)) throw new ItemNotFoundError(cmd.itemId);
      if (!existing.workspaceDecided) everyWorkspaceSees(commandRow);
      const today = captureDay(cmd.issuedAt, cmd.timeZone);
      if (today === null) throw new WaitRefusedError(UNKNOWN_TIME_ZONE);

      const updated = applyWaitForReply(existing, cmd, today.date);
      if (updated === null) {
        // Stale by last-write-wins: log the command, change nothing.
        db.insert(commands).values(commandRow).run();
        applied = false;
      } else {
        // Open before and after, so nothing is mirrored at the source and no run ends.
        db.transaction((tx) => {
          tx.update(items)
            .set(asStored(updated))
            .where(and(eq(items.tenantId, tenantId), eq(items.id, cmd.itemId)))
            .run();
          tx.insert(commands).values(commandRow).run();
        });
      }
      break;
    }
    case 'set_repeat': {
      const cmd = payload as CommandPayload<'set_repeat'>;
      const item = getItem(db, tenantId, cmd.itemId);
      if (!item) throw new ItemNotFoundError(cmd.itemId);
      if (!item.workspaceDecided) everyWorkspaceSees(commandRow);
      const own = item.seriesId === null ? null : getSeries(db, tenantId, item.seriesId);
      // The id the tab made up is a series of another Item's, not a retry of this one.
      if (own === null && cmd.repeat !== null && getSeries(db, tenantId, cmd.seriesId)) {
        throw new RepeatRefusedError('That repeat could not be set. Try again.');
      }
      const decision = decideRepeat(own, cmd, tenantId);
      if (decision.kind === 'refused') throw new RepeatRefusedError(decision.why);
      if (decision.kind !== 'write') {
        // Stale by last-write-wins, or nothing to stop: log the command, change nothing.
        db.insert(commands).values(commandRow).run();
        applied = decision.kind === 'nothing';
        break;
      }
      const { row } = decision;
      // Until the Recurring items modal replaces it, a series the chip sets that
      // holds nothing yet - a new one, or one stopped empty - takes the Item's
      // content and Panels once; a rule changed later leaves them as taken
      // ("Make each copy of a recurring item from its own series", issue 1448).
      const fills = cmd.repeat !== null && (own === null || own.title === null);
      const content = fills ? masterContentOf(item) : null;
      const filedOn = fills ? masterPanelsFrom(db, tenantId, item, row.id, cmd.issuedAt) : [];
      db.transaction((tx) => {
        if (decision.isNew) {
          tx.insert(series).values({ ...row, ...content }).run();
          // The Item's own `updated_at` is left alone: a repeat is the series', and a title edit in flight must not go stale for it.
          tx.update(items)
            .set({ seriesId: row.id })
            .where(and(eq(items.tenantId, tenantId), eq(items.id, cmd.itemId)))
            .run();
        } else {
          tx.update(series)
            .set({ ...row, ...content })
            .where(and(eq(series.tenantId, tenantId), eq(series.id, row.id)))
            .run();
        }
        if (fills) {
          tx.delete(seriesPanels)
            .where(and(eq(seriesPanels.tenantId, tenantId), eq(seriesPanels.seriesId, row.id)))
            .run();
          for (const filing of filedOn) tx.insert(seriesPanels).values(filing).run();
        }
        tx.insert(commands).values(commandRow).run();
      });
      break;
    }
    case 'bring_back_occurrence': {
      const cmd = payload as CommandPayload<'bring_back_occurrence'>;
      const brought = decideOccurrence(db, tenantId, cmd);
      if (brought.kind === 'not due') {
        // Stopped or moved since the alarm read it: nothing happened, so nothing is logged.
        applied = false;
        break;
      }
      // Logged against the Workspace whose tabs draw the series, or every one
      // where its latest copy is drawn outside the series' own.
      if (brought.workspaceId !== null) commandRow.workspaceId = brought.workspaceId;
      // Only a written Item spends the series' day: a day passed over leaves it
      // for a Next on moved back to it, under an id of the log's own.
      if (brought.kind !== 'writes') commandRow.commandId = uuidv7();
      db.transaction((tx) => {
        if (brought.kind === 'writes') {
          tx.insert(items).values({ ...asStored(brought.item), status: DEAD_STATUS_VALUE }).run();
          writePanelOrders(tx, tenantId, brought.panels);
        }
        tx.update(series)
          .set(
            brought.kind === 'stops'
              ? { stoppedAt: cmd.issuedAt, lastOn: cmd.day }
              : { nextOn: brought.nextOn, anchorOn: brought.anchorOn, lastOn: cmd.day },
          )
          .where(and(eq(series.tenantId, tenantId), eq(series.id, cmd.seriesId)))
          .run();
        tx.insert(commands).values(commandRow).run();
      });
      if (brought.kind === 'stops') {
        console.warn(
          JSON.stringify({
            level: 'warn',
            message: 'a series stopped, as it had nothing left to bring back',
            data: { seriesId: cmd.seriesId, because: brought.because },
          }),
        );
      }
      break;
    }
    case 'send_item_to_claude': {
      const cmd = payload as CommandPayload<'send_item_to_claude'>;
      // Decided here, inside the one call the object runs at a time, so two
      // tabs sending the same Item are two of these run one after the other
      // and the second meets the first's Run ("Send an item to Cowork or
      // Claude Code with its prompt reviewed first", issue 1159). An Item
      // that belongs to no Workspace yet is sent from whichever Inbox shows it.
      const item = getItem(db, tenantId, cmd.itemId);
      if (
        !item ||
        !getWorkspace(db, tenantId, cmd.workspaceId) ||
        (item.workspaceDecided && item.workspaceId !== cmd.workspaceId)
      ) {
        throw new ItemNotFoundError(cmd.itemId);
      }
      // An Item that belongs to no Workspace is drawn in every Inbox, so every
      // tab is told its Run is there.
      if (!item.workspaceDecided) everyWorkspaceSees(commandRow);
      const open = openAgentRunOn(db, tenantId, cmd.itemId);
      // The same send again under a new command id - the window keeps one run
      // id, so a retry after a lost answer lands here - is the Run already
      // made, not a second one for Claude to be refused on.
      if (open?.id === cmd.runId) {
        db.insert(commands).values(commandRow).run();
        applied = false;
        break;
      }
      const decided = decideClaudeSend({ item, openRun: open });
      switch (decided.refusal) {
        case null:
          break;
        case 'item-not-to-be-done':
          throw new AgentRunRefusedError('Claude only takes an item still to be done.');
        case 'claude-already-on-item':
          throw new AgentRunRefusedError('Claude is already on this item.');
      }
      db.transaction((tx) => {
        // A run Claude refused started nothing, so a send replaces it.
        if (open) {
          tx.update(agentRuns)
            .set({ endedAt: cmd.issuedAt })
            .where(and(eq(agentRuns.tenantId, tenantId), eq(agentRuns.id, open.id)))
            .run();
        }
        tx.insert(agentRuns)
          .values({
            id: cmd.runId,
            tenantId,
            workspaceId: cmd.workspaceId,
            itemId: cmd.itemId,
            // No Agent: the column is NOT NULL and cannot be widened.
            agentId: '',
            status: 'working',
            startedAt: cmd.issuedAt,
            destination: cmd.destination,
            folder: cmd.folder === '' ? null : cmd.folder,
            stage: 'sent',
          })
          .run();
        // Kept as an example for later proposals, in the same transaction as
        // the Run it belongs to (issue 1162): a send that opened Claude has
        // its record, and one the server refused has none.
        const kept = recordOfSend(cmd, item);
        if (kept) recordClaudeSend(tx, tenantId, kept);
        tx.insert(commands).values(commandRow).run();
      });
      break;
    }
    case 'report_claude_run': {
      const cmd = payload as CommandPayload<'report_claude_run'>;
      // Held to the contract here as well as at the tool: this is the one
      // place a stage or a link reaches the table ("Follow on the row what
      // Claude reports back", issue 1160).
      if (
        !CLAUDE_REPORTED_STAGES.includes(cmd.stage) ||
        (cmd.sessionUrl !== undefined && claudeSessionLink(cmd.sessionUrl) === null) ||
        (cmd.resultUrl !== undefined && claudeResultLink(cmd.resultUrl) === null) ||
        (cmd.note ?? '').length > REPORT_NOTE_LIMIT
      ) {
        throw new AgentRunRefusedError('That report is not one Cockpit takes.');
      }
      // Only a Run sent to Claude, still open: unknown, ended and an Agent's
      // run are refused alike, so the answer tells nobody which it was.
      const run = getAgentRun(db, tenantId, cmd.runId);
      if (!run || run.endedAt !== null || !run.destination) throw new AgentRunNotFoundError(cmd.runId);
      const sessionUrl = cmd.sessionUrl ?? run.sessionUrl;
      const resultUrl = cmd.resultUrl ?? run.resultUrl ?? null;
      const note = cmd.note === undefined || cmd.note.trim() === '' ? null : cmd.note.trim();
      // Logged against the Run's own Workspace, or every one for an Item that
      // belongs to none, which is drawn in every Inbox.
      commandRow.workspaceId = run.workspaceId;
      const item = getItem(db, tenantId, run.itemId);
      if (item && !item.workspaceDecided) everyWorkspaceSees(commandRow);
      // The same report again is the Run as it stands: nothing is written and
      // nothing is announced.
      if (
        run.stage === cmd.stage &&
        (run.sessionUrl ?? null) === (sessionUrl ?? null) &&
        (run.resultUrl ?? null) === resultUrl &&
        (run.note ?? null) === note
      ) {
        applied = false;
        break;
      }
      db.transaction((tx) => {
        tx.update(agentRuns)
          .set({ stage: cmd.stage, sessionUrl: sessionUrl ?? null, resultUrl, note })
          .where(and(eq(agentRuns.tenantId, tenantId), eq(agentRuns.id, cmd.runId)))
          .run();
        tx.insert(commands).values(commandRow).run();
      });
      break;
    }
    case 'finish_agent_run': {
      const cmd = payload as CommandPayload<'finish_agent_run'>;
      const run = getAgentRun(db, tenantId, cmd.runId);
      if (!run || run.workspaceId !== cmd.workspaceId || run.itemId !== cmd.itemId || run.endedAt !== null) {
        throw new AgentRunNotFoundError(cmd.runId);
      }
      const item = getItem(db, tenantId, cmd.itemId);
      if (!item) throw new ItemNotFoundError(cmd.itemId);
      // Done is marking it done; Still to do is back to To do, from In
      // progress or from Done alike - the two things "Agent finished" can say
      // about the Item (issue 571, rule 4). Stale by last-write-wins leaves the
      // Item as a newer change put it, and still ends the run.
      const settled =
        cmd.outcome === 'done'
          ? applySetDone(item, { ...cmd, done: true })
          : (() => {
              const toDo = applySetStarted(item, { ...cmd, started: false });
              return toDo && { ...toDo, completedAt: null };
            })();
      db.transaction((tx) => {
        tx.update(agentRuns)
          .set({ endedAt: cmd.issuedAt })
          .where(and(eq(agentRuns.tenantId, tenantId), eq(agentRuns.id, cmd.runId)))
          .run();
        if (settled) {
          tx.update(items)
            .set(asStored(settled))
            .where(and(eq(items.tenantId, tenantId), eq(items.id, cmd.itemId)))
            .run();
          // As set_done records it: "Agent finished: Done" on a Gmail Task
          // takes its label off (issue 944).
          wantPulledOpenStateMirrored(tx, tenantId, item, settled, mirroring);
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
        | CommandPayload<'set_priority'>
        | CommandPayload<'set_due_date'>
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
                  : name === 'set_priority'
                    ? applySetPriority(existing, cmd as CommandPayload<'set_priority'>)
                    : applySetDueDate(existing, cmd as CommandPayload<'set_due_date'>, fromTheSource);

      if (updated === null) {
        // Stale by last-write-wins: log the command, change nothing.
        db.insert(commands).values(commandRow).run();
        applied = false;
      } else {
        // A correction only for the two texts, and only where Cockpit had
        // actually proposed something to correct - an Item it never proposed
        // for teaches nothing ("Learn how you write from the titles you
        // correct", issue 394; `docs/text-learning.md`, "The rules").
        const correction =
          (name === 'set_title' || name === 'set_description') && existing.textsProposedAt !== null
            ? textCorrectionFor(existing, updated, cmd.issuedAt)
            : null;
        // Not simply `correction !== null`: where this is *not* the true
        // first edit, the write below is a documented no-op unless the true
        // first edit already created a row (see the `else` branch's own
        // comment) - and a correction nothing was recorded for is nothing
        // the re-read below has anything new to learn from.
        recordedCorrection =
          correction !== null &&
          (existing.textsSettledAt === null || textCorrectionExistsFor(db, tenantId, correction.itemId));
        const reopened =
          name === 'set_done' && !(cmd as CommandPayload<'set_done'>).done
            ? runToReopen(db, tenantId, cmd, existing.completedAt, updated)
            : name === 'set_dismissed' && !(cmd as CommandPayload<'set_dismissed'>).dismissed
              ? runToReopen(db, tenantId, cmd, existing.deletedAt, updated)
              : null;
        db.transaction((tx) => {
          tx.update(items)
            // Both source columns, as the capture above (`asStored`, domain/items.ts).
            .set(asStored(updated))
            .where(and(eq(items.tenantId, tenantId), eq(items.id, cmd.itemId)))
            .run();
          if (!fromTheSource) {
            wantPulledOpenStateMirrored(tx, tenantId, existing, updated, mirroring);
          }
          // The Item's Status is what ends a run, in the one transaction as the
          // change; an Undo that names a run it ended brings it back.
          if (
            (name === 'set_done' && (cmd as CommandPayload<'set_done'>).done) ||
            (name === 'set_dismissed' && (cmd as CommandPayload<'set_dismissed'>).dismissed)
          ) {
            endTheOpenRun(tx, tenantId, cmd.itemId, cmd.issuedAt);
          } else if (reopened) {
            tx.update(agentRuns)
              .set({ endedAt: null })
              .where(and(eq(agentRuns.tenantId, tenantId), eq(agentRuns.id, reopened)))
              .run();
          }
          if (correction) {
            if (existing.textsSettledAt === null) {
              // The true first edit, and the only moment `existing.title`/
              // `existing.description` are guaranteed to still be Cockpit's
              // own proposal - so this is the only moment a row may be
              // *created* from them (`docs/text-learning.md`, "The proposal
              // is frozen at your first edit; your side stays live").
              // `onConflictDoNothing` is a defensive no-op: nothing else can
              // have written a row this early, since one is only ever
              // created in this same branch.
              tx.insert(textCorrections).values(correction).onConflictDoNothing().run();
            } else {
              // A later edit updates only the settled half of a row the true
              // first edit already created - never inserts one. Without this
              // split, an edit reachable only because an earlier one (e.g.
              // clearing the title) settled the texts without itself
              // recording anything would insert a row whose frozen
              // `proposedTitle`/`proposedDescription` were read off values
              // that had already drifted from what Cockpit actually
              // proposed. A plain `UPDATE ... WHERE` simply touches nothing
              // where the true first edit never created a row - which is the
              // right outcome: a proposal this account can no longer verify
              // is not one it should teach from.
              tx.update(textCorrections)
                .set({
                  settledTitle: correction.settledTitle,
                  settledDescription: correction.settledDescription,
                  updatedAt: correction.updatedAt,
                })
                .where(and(eq(textCorrections.tenantId, tenantId), eq(textCorrections.itemId, correction.itemId)))
                .run();
            }
          }
          tx.insert(commands).values(commandRow).run();
        });
      }
      break;
    }
  }

  // No explicit broadcast: SSE connections derive invalidations from the
  // command log itself (see events.ts for why in-memory fan-out can't work).
  return {
    ok: true,
    applied,
    // The stamp the change's announcement carries (`collectInvalidations`),
    // so a tab can tell the announcement is its own.
    at: commandRow.receivedAt,
    ...(settledRouting ? { settledRouting } : {}),
    ...(recordedCorrection ? { recordedCorrection } : {}),
    ...(fieldsSet ? { fieldsSet } : {}),
  };
}
