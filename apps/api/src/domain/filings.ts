import { panelGathers, panelTakesItems } from '@cockpit/shared';
import type {
  AddItemToPanelCommand,
  Filing,
  Item,
  MoveItemToPanelCommand,
  PanelKind,
} from '@cockpit/shared';
import { decisionHistoryEntryFor, type DecisionHistoryRow } from './decision-history.js';
import { decideWorkspace } from './items.js';

/**
 * Pure handlers for filing an item on a panel (architecture, "Hono + Zod on
 * Cloudflare Workers": domain imports nothing from the other layers).
 *
 * A filing is one item on one panel, with a position in that panel's order
 * ("Panels hold the items filed into them, and the Inbox holds the rest",
 * issue 36). The Inbox is the absence of one.
 */

/**
 * What both functions below need of a change: which item, which panel it is
 * landing on, and the panel's whole order afterwards.
 *
 * Written out rather than naming a command, because moving an item to a panel
 * and adding it to one differ only in what happens to the panels it was already
 * on ("Ask whether to move an item to a panel or add it to one", issue 142) -
 * and neither of those functions is about that half.
 */
export interface Arriving {
  itemId: string;
  panelId: string | null;
  order: readonly string[];
  issuedAt: string;
}

export interface FilingRow {
  tenantId: string;
  panelId: string;
  itemId: string;
  position: number;
  createdAt: string;
}

/**
 * The rows one panel's order becomes: the list's own order written down as
 * `position`, because nothing else carries it.
 *
 * The index is used as written rather than renumbered from what was there
 * before, so an order is always a whole answer and never a patch on one — which
 * is what makes sending the same move twice land on the same rows.
 * `placementRows` is the same function for the same reason.
 *
 * `createdAt` is the client's own timestamp, like every other command, so a
 * filing made offline records when it was made rather than when it arrived.
 */
/**
 * The values one filing row binds, which is what decides how many of them fit
 * in a statement (`inBatchesOf`). Counted from the row built below; a column
 * added there is a value added here.
 */
export const FILING_VALUES_PER_ROW = 5;

export function filingRows(tenantId: string, cmd: Arriving): FilingRow[] {
  if (cmd.panelId === null) return [];
  const panelId = cmd.panelId;
  return cmd.order.map((itemId, position) => ({
    tenantId,
    panelId,
    itemId,
    position,
    createdAt: cmd.issuedAt,
  }));
}

/**
 * Why the order sent is not an order of this panel, or null when it is.
 *
 * **An order must name exactly the panel's items plus the one arriving.** It is
 * the panel's whole arrangement afterwards, so an item left out has no place in
 * it and its row would not survive — and a stranger in the list would file
 * something nobody moved. Both are the staleness the whole-order shape exists to
 * make visible (see `moveItemToPanelSchema`): a client working from a snapshot
 * that has moved on sends a list that no longer describes the panel, and is
 * told so rather than quietly overwriting it.
 *
 * The item arriving may already be on the panel, which is what a reorder is, so
 * it is added to the expected set rather than required to be absent from the
 * held one.
 *
 * **Except an Item in `mayLeaveOut`**, one finished more than a day ago: no
 * up-to-date read carries its filing, so an order may leave it out, and one
 * still naming it, as an app from before that read sends, is accepted too ("Open
 * a Workspace without its finished Items", issue 1435). The Item arriving is
 * never left out.
 *
 * Returned rather than thrown so the caller decides what it means, the way
 * `panelsNotOn` does.
 */
export function orderIsNotOfThePanel(
  held: readonly Filing[],
  cmd: Arriving,
  mayLeaveOut: ReadonlySet<string> = new Set(),
): string | null {
  if (cmd.panelId === null) return null;
  const expected = new Set(held.map((filing) => filing.itemId));
  expected.add(cmd.itemId);
  const named = new Set(cmd.order);

  // One comparison rather than two, because leaving an item out and naming one
  // that is not there are the same fault seen from either end - the list is not
  // this panel's - and they had the same answer.
  //
  // No id in the sentence. What comes back here is shown to the person who made
  // the move, and an item id tells them nothing and suggests nothing to do;
  // what they need to know is that the panel changed underneath them. The
  // shape check on the command has already ruled out a repeated id, so this is
  // a comparison of sets.
  const sameItems =
    cmd.order.every((itemId) => expected.has(itemId)) &&
    [...expected].every((itemId) => named.has(itemId) || (itemId !== cmd.itemId && mayLeaveOut.has(itemId)));

  return sameItems ? null : 'this panel changed while you were looking at it: try the move again';
}

/**
 * Why nothing is filed on this panel, or null where something can be: one of
 * text draws no items, and a Filter gathers what is filed elsewhere.
 *
 * Filing an item and adding it to one more panel are the same act with
 * different answers about where it was before ("Ask whether to move an item to
 * a panel or add it to one", issue 142), so they cannot be allowed to come to
 * disagree about what a panel will take. The kind is the contract's own type: a
 * mistyped literal would compile, never refuse, and reopen the hole this closes.
 */
export function whyNothingIsFiledOn(panel: { name: string; kind: PanelKind }): string | null {
  if (panelTakesItems(panel)) return null;
  return panelGathers(panel)
    ? `${panel.name} gathers what it shows, so nothing is filed on it`
    : `${panel.name} holds text, so nothing is filed on it`;
}

/** The Panel a filing lands on, as loaded. */
export interface FilingTarget {
  id: string;
  name: string;
  kind: PanelKind;
}

/** A Panel a move names to take the Item off, as loaded. */
export interface FilingSource {
  id: string;
  /** Live at all; one it has since left or that another tab deleted is ignored. */
  exists: boolean;
  /** Live, on a dashboard of the Workspace the change names. */
  ofTheWorkspace: boolean;
}

/**
 * What a filing needs of the store, loaded before it is decided so that nothing
 * here reads anything. Every refusal below is decided from these.
 */
export interface FilingFacts {
  /** The Item the change names; null where there is none. */
  item: Item | null;
  workspaceExists: boolean;
  /**
   * The Panel the change names: null where the Inbox is meant, or where no
   * Panel of the Workspace has the id.
   */
  panel: FilingTarget | null;
  /** What that Panel holds now. */
  held: readonly Filing[];
  /**
   * Of those, the rows whose Item the Workspace's read leaves out, finished more
   * than a day ago: an order may leave them out, and they are then written back
   * as they were ("Open a Workspace without its finished Items", issue 1435).
   * None where not given.
   */
  heldOutOfTheRead?: readonly FilingRow[];
  /** Whether the Item is on a Panel already, read before anything moves it. */
  alreadyFiled: boolean;
  /** Whether the Panel its open proposal names is flagged Never propose. */
  proposedPanelNeverPropose: boolean;
  /** The Panels a move names to take the Item off. */
  sources: readonly FilingSource[];
}

/** Why a filing is refused, for the caller to say in the words its layer has for it. */
export type FilingRefusal =
  | { refusal: 'item-not-found'; id: string }
  | { refusal: 'workspace-not-found'; id: string }
  | { refusal: 'panel-not-found'; id: string }
  | { refusal: 'panel-holds-something-else'; why: string }
  | { refusal: 'order-stale'; why: string };

/** What a filing that is accepted writes. */
export interface FilingDecided {
  refusal: null;
  /** The Item with its Workspace settled by this filing, or null where it already belonged somewhere. */
  workspaceSettled: Item | null;
  /** The Panels to take the Item off; undefined takes it off every one. */
  fromPanelIds: string[] | undefined;
  /** Whether any Panel it was on is cleared at all. */
  takesItOffPanels: boolean;
  /** The Panel whose order is written whole, or null for a move to the Inbox. */
  panelId: string | null;
  rows: FilingRow[];
  /** The decision to record: only the first filing out of the Inbox settles one. */
  decision: DecisionHistoryRow | null;
}

/**
 * The Item's proposal as its Inbox chip showed it: none where the proposed
 * Panel is flagged Never propose, whose chip is not drawn ("Keep a Panel out of
 * proposals with Never propose", issue 848). Otherwise the history would record
 * an override of a chip nobody saw.
 */
function proposalAsShown(item: Item, proposedPanelNeverPropose: boolean): Item {
  return item.proposedPanelId && proposedPanelNeverPropose
    ? { ...item, proposedPanelId: null, proposedPanelReason: null, proposedPanelFit: null }
    : item;
}

/**
 * The refusals both commands share, in the order a person meets them, and what
 * settles once the filing lands. Never reads: `facts` says what the store holds.
 *
 * **A routing settles exactly once** - the first time an Item leaves the Inbox
 * for a real Panel - and `alreadyFiled` is what tells that filing from every
 * reorganizing move after it ("Learn where notes belong from where you actually
 * file them", issue 299). Recording a later move would misattribute a stale
 * proposal to a decision it was never shown for.
 */
function decideFiling(
  cmd: MoveItemToPanelCommand | AddItemToPanelCommand,
  facts: FilingFacts,
): FilingRefusal | FilingDecided {
  const { item } = facts;
  // An item belonging to no workspace is reachable from every one of them,
  // because it is shown in every one of them ("Capture something before you
  // know which workspace it belongs to", issue 165) - and filing is what says
  // where it belongs.
  if (!item || (item.workspaceDecided && item.workspaceId !== cmd.workspaceId)) {
    return { refusal: 'item-not-found', id: cmd.itemId };
  }
  // The Workspace has to exist whether a Panel or the Inbox is meant.
  if (!facts.workspaceExists) return { refusal: 'workspace-not-found', id: cmd.workspaceId };
  if (cmd.panelId !== null && !facts.panel) return { refusal: 'panel-not-found', id: cmd.panelId };
  const panel = cmd.panelId === null ? null : facts.panel;
  const outOfTheRead = facts.heldOutOfTheRead ?? [];
  if (panel) {
    const why = whyNothingIsFiledOn(panel);
    if (why) return { refusal: 'panel-holds-something-else', why };
    const mayLeaveOut = new Set(outOfTheRead.map((row) => row.itemId));
    const stale = orderIsNotOfThePanel(facts.held, { ...cmd, panelId: panel.id }, mayLeaveOut);
    if (stale) return { refusal: 'order-stale', why: stale };
  }
  // The rows an order left out keep their place: the Panel's order is written
  // whole, and without them an Item reopened later would have lost its Panel.
  const inTheOrder = new Set(cmd.order);
  const keptAsTheyWere = panel ? outOfTheRead.filter((row) => !inTheOrder.has(row.itemId) && row.itemId !== cmd.itemId) : [];

  // One it has since left, or that was deleted in another tab, is no mistake
  // and is ignored; a live one must be a Panel of this Workspace. Naming none,
  // or moving to the Inbox, takes the Item off every Panel.
  const named = 'fromPanelIds' in cmd && cmd.panelId !== null ? (cmd.fromPanelIds ?? []) : [];
  let fromPanelIds: string[] | undefined;
  if (named.length > 0) {
    fromPanelIds = [];
    for (const from of facts.sources) {
      if (!from.exists) continue;
      if (!from.ofTheWorkspace) return { refusal: 'panel-not-found', id: from.id };
      fromPanelIds.push(from.id);
    }
  }

  return {
    refusal: null,
    // Null for an item that already belonged somewhere: nothing about its
    // workspace changes.
    workspaceSettled: decideWorkspace(item, cmd.workspaceId, cmd.issuedAt),
    fromPanelIds,
    // Every one named gone is nothing to take it off, not every Panel.
    takesItOffPanels: !fromPanelIds || fromPanelIds.length > 0,
    panelId: panel ? panel.id : null,
    rows: [...filingRows(item.tenantId, { ...cmd, panelId: panel ? panel.id : null }), ...keptAsTheyWere],
    decision:
      panel && !facts.alreadyFiled
        ? decisionHistoryEntryFor(proposalAsShown(item, facts.proposedPanelNeverPropose), cmd, panel.id)
        : null,
  };
}

/** A Panel a capture names, as loaded: live, on a Dashboard of the capture's Workspace, with what it holds. */
export interface CaptureTarget extends FilingTarget {
  held: readonly Filing[];
}

/**
 * Filing a capture on the Panels it names ("File a note on Panels from Capture,
 * skipping the Inbox", issue 1101): the Item itself, settled in the capture's
 * Workspace where it files at all, and one filing per Panel, each at the top.
 *
 * **Never refuses.** A Panel that takes no Items is skipped, and with none left
 * the capture is the Inbox's, unchanged. The decision-history entry is the first
 * filing's alone, as for any Item leaving the Inbox, and records no proposal
 * because a new Item has none.
 */
export function decideCaptureFiling(
  item: Item,
  cmd: { commandId: string; issuedAt: string; workspaceId: string },
  targets: readonly CaptureTarget[],
): { item: Item; filings: FilingDecided[] } {
  const usable = targets.filter((target) => whyNothingIsFiledOn(target) === null);
  if (usable.length === 0) return { item, filings: [] };
  const filed: Item = item.workspaceDecided ? item : { ...item, workspaceDecided: true };
  const filings = usable.map((target, index) => {
    const decided = decideAddToPanel(
      {
        commandId: cmd.commandId,
        issuedAt: cmd.issuedAt,
        workspaceId: cmd.workspaceId,
        itemId: item.id,
        panelId: target.id,
        order: [item.id, ...target.held.map((filing) => filing.itemId)],
      },
      {
        item: filed,
        workspaceExists: true,
        panel: target,
        held: target.held,
        alreadyFiled: index > 0,
        proposedPanelNeverPropose: false,
        sources: [],
      },
    );
    // Every refusal was ruled out above: the Item is decided, the Workspace is
    // the capture's own and the order is the Panel's held plus this Item.
    if (decided.refusal) throw new Error(`a capture's own filing was refused: ${decided.refusal}`);
    return decided;
  });
  return { item: filed, filings };
}

/** A Panel a note named, as loaded when the filing is written: null where it has gone or is not in the Item's Workspace. */
export interface NamedPanel extends FilingTarget {
  /** What it holds now, in order. */
  held: readonly Filing[];
}

/** What filing a note on the Panels it named writes: each Panel's whole order, and the one decision it settles. */
export interface FiledWhereSaid {
  panels: { panelId: string; rows: FilingRow[] }[];
  decision: DecisionHistoryRow;
}

/**
 * Filing a captured note on the Panels it named, as the person's own filing
 * ("File a capture on the panels you name, read from the spoken path", issue
 * 1116) - or null where nothing is filed. Never reads: `named` and
 * `alreadyFiled` say what the store holds when this is written.
 *
 * **First answer wins.** An Item already on a Panel, dismissed, finished with,
 * or in no Workspace yet is left alone, whatever the note said.
 *
 * **At the top of each Panel**, the rest of its order kept below. A Panel set
 * to Never propose is filed on all the same: that setting stops Cockpit
 * suggesting it, not the person choosing it. A Filter or a Panel of text never
 * is, and with no Panel left nothing is filed.
 *
 * **One decision, with no proposal**: the routing settles once, on the first
 * Panel named, as a person's first filing does, and whatever was proposed is
 * withdrawn rather than recorded as overridden - the note said where it goes,
 * so no proposal was weighed.
 */
export function decideFilingWhereSaid(
  item: Item,
  cmd: { commandId: string; issuedAt: string },
  named: readonly (NamedPanel | null)[],
  alreadyFiled: boolean,
): FiledWhereSaid | null {
  if (alreadyFiled || item.deletedAt !== null || item.completedAt !== null || !item.workspaceDecided) return null;
  const seen = new Set<string>();
  const panels = named.filter((panel): panel is NamedPanel => {
    if (panel === null || !panelTakesItems(panel) || seen.has(panel.id)) return false;
    seen.add(panel.id);
    return true;
  });
  const first = panels[0];
  if (!first) return null;
  return {
    panels: panels.map((panel) => ({
      panelId: panel.id,
      rows: filingRows(item.tenantId, {
        itemId: item.id,
        panelId: panel.id,
        order: [item.id, ...panel.held.map((filing) => filing.itemId).filter((id) => id !== item.id)],
        issuedAt: cmd.issuedAt,
      }),
    })),
    decision: decisionHistoryEntryFor(
      { ...item, proposedPanelId: null, proposedPanelReason: null, proposedPanelFit: null },
      { ...cmd, workspaceId: item.workspaceId },
      first.id,
    ),
  };
}

/** Moving an Item onto a Panel, or off every one to the Inbox: it is taken off the Panels it was on. */
export function decideMoveToPanel(
  cmd: MoveItemToPanelCommand,
  facts: FilingFacts,
): FilingRefusal | FilingDecided {
  return decideFiling(cmd, facts);
}

/**
 * Adding an Item to one more Panel. **The whole difference from a move is the
 * Panels it is taken off**: none, which is what makes one item on several
 * panels a thing at all.
 */
export function decideAddToPanel(
  cmd: AddItemToPanelCommand,
  facts: FilingFacts,
): FilingRefusal | FilingDecided {
  const decided = decideFiling(cmd, facts);
  return decided.refusal ? decided : { ...decided, takesItOffPanels: false, fromPanelIds: undefined };
}
