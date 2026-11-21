import type {
  AgentRun,
  CommandName,
  CommandPayload,
  CommandResult,
  Association,
  Dashboard,
  Filing,
  Item,
  Layout,
  Panel,
  PossibleDuplicate,
  Series,
  Workspace,
} from '@cockpit/shared';
import type { ItemOnWhiteboards, Whiteboards } from '@cockpit/shared/board';

/** The full read model for one workspace, as the store answers it. */
export interface AccountSnapshot {
  workspace: Workspace;
  items: Item[];
  /** The workspace's dashboards, oldest first: the bar under the tabs. */
  dashboards: Dashboard[];
  /**
   * Every panel of every one of those dashboards, oldest first, and each one's
   * layout where it has one - the whole workspace rather than the dashboard being
   * looked at, because switching between dashboards happens without a round
   * trip.
   */
  panels: Panel[];
  layouts: Layout[];
  /** Which items are filed on which of those panels, and in what order. */
  filings: Filing[];
  associations: Association[];
  /** The series the Items above name, stopped ones too ("Repeat an Item on a schedule", issue 1405). */
  series: Series[];
  /**
   * Which of the Items above say the same thing as which ("Flag a captured
   * note that says what another one already said", issue 407) - both halves of
   * every pair are Items this snapshot already carries.
   */
  duplicates: PossibleDuplicate[];
  /** Every open run on this Workspace's Items: sent to Claude, or started by an Agent before Agents were retired (issue 1165). */
  agentRuns: AgentRun[];
  /** Every whiteboard of the Workspace's Dashboards ("Brainstorming: give every Dashboard a whiteboard of its own", issue 1829). */
  whiteboards: Whiteboards;
  /** POC (own-event refetch): the newest change this snapshot is built on. */
  upTo: string | undefined;
  /**
   * The Workspace's connections, oldest first, for the Worker to say which
   * *Email…* may use ("Email… makes a Gmail draft the Item then follows", issue
   * 1708): never sent on as they are. Optional, so a fixture without it is a
   * Workspace with nothing connected.
   */
  connections?: { id: string; connectorId: string; displayName: string; follows: string | null }[];
}

/**
 * What every call on an account's store answers with.
 *
 * `not-up-to-date` carries a sentence naming the change that failed and the
 * underlying cause, and that is the whole reason a failure is a value here
 * rather than an exception: an exception crossing the binding arrives as a
 * plain `Error` with nothing left on it to branch on, so anything the caller
 * has to *decide* on has to be in the answer.
 *
 * `allowance-spent` is the free tier's daily reads or writes running out,
 * whether it happened while bringing the store up to date or while doing the
 * work - its own answer so nothing mistakes it for a change that will not apply.
 */
export type Answer<T> =
  | { status: 'ok'; value: T }
  | { status: 'missing'; what: string }
  | { status: 'conflict'; what: string; onWhiteboards?: ItemOnWhiteboards[] }
  | { status: 'refused'; what: string }
  | { status: 'not-up-to-date'; failure: string }
  | { status: 'allowance-spent' };

/** One command and its payload, as `applyChanges` takes a list of them. */
export type CommandToRun = { [N in CommandName]: { name: N; payload: CommandPayload<N> } }[CommandName];

/**
 * A filing whose Panel order the store builds at the moment it is written
 * ("MCP changes and deletes: name Panels in update_item and create_item",
 * issue 1812): the Item on top and what the Panel holds then below it, read
 * where the command is applied, so nothing the caller read earlier can have
 * gone stale. An Item finished more than a day ago and left out of the Workspace's
 * read keeps its place, as `move_item_to_panel`'s order allows. Never a move to
 * the Inbox, whose order is empty: that is a plain `CommandToRun`.
 */
export type FilingOnTop =
  | { name: 'add_item_to_panel'; onTop: true; payload: Omit<CommandPayload<'add_item_to_panel'>, 'order'> }
  | { name: 'move_item_to_panel'; onTop: true; payload: Omit<CommandPayload<'move_item_to_panel'>, 'order'> & { panelId: string } };

/** One change of `applyChanges`: a command as it is, or a filing whose order the store builds. */
export type ChangeToRun = CommandToRun | FilingOnTop;

/**
 * What `applyChanges` ran: the result of each command that was applied, in
 * order, and - where a command was refused partway - which one stopped the
 * rest and why. **What applied before it stays applied**: each command is its
 * own transaction, as when a tab sends them one by one.
 */
export interface ChangesApplied {
  results: CommandResult[];
  /** The command that stopped the call, by its place in the list, and why; absent where every command ran. */
  stopped?: { at: number; because: 'missing' | 'conflict' | 'refused' | 'unavailable'; what: string };
}
