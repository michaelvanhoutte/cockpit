import type {
  AgentRun,
  Association,
  Dashboard,
  Filing,
  Item,
  Layout,
  Panel,
  PossibleDuplicate,
  Workspace,
} from '@cockpit/shared';

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
  /**
   * Which of the Items above say the same thing as which ("Flag a captured
   * note that says what another one already said", issue 407) - both halves of
   * every pair are Items this snapshot already carries.
   */
  duplicates: PossibleDuplicate[];
  /** Every open run on this Workspace's Items: sent to Claude, or started by an Agent before Agents were retired (issue 1165). */
  agentRuns: AgentRun[];
  /** POC (own-event refetch): the newest change this snapshot is built on. */
  upTo: string | undefined;
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
  | { status: 'conflict'; what: string }
  | { status: 'refused'; what: string }
  | { status: 'not-up-to-date'; failure: string }
  | { status: 'allowance-spent' };
