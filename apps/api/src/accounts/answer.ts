import type {
  Association,
  Dashboard,
  Filing,
  Item,
  ItemType,
  Layout,
  Panel,
  Workspace,
} from '@cockpit/shared';

/** The full read model for one workspace, as the store answers it. */
export interface AccountSnapshot {
  workspace: Workspace;
  items: Item[];
  /** The workspace's dashboards, oldest first: the bar under the tabs. */
  dashboards: Dashboard[];
  /**
   * Every panel of every one of those dashboards, oldest first, and every
   * layout arranging them - the whole workspace rather than the dashboard being
   * looked at, because switching between dashboards happens without a round
   * trip.
   */
  panels: Panel[];
  layouts: Layout[];
  /** Which items are filed on which of those panels, and in what order. */
  filings: Filing[];
  associations: Association[];
  /** Every live Type of the account, in the order they are offered in. */
  itemTypes: ItemType[];
}

/**
 * What every call on an account's store answers with.
 *
 * `not-up-to-date` carries a sentence naming the change that failed and the
 * underlying cause, and that is the whole reason a failure is a value here
 * rather than an exception: an exception crossing the binding arrives as a
 * plain `Error` with nothing left on it to branch on, so anything the caller
 * has to *decide* on has to be in the answer.
 */
export type Answer<T> =
  | { status: 'ok'; value: T }
  | { status: 'missing'; what: string }
  | { status: 'conflict'; what: string }
  | { status: 'refused'; what: string }
  | { status: 'not-up-to-date'; failure: string };
