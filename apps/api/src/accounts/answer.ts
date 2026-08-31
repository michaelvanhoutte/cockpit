import type { Association, Item, Workspace } from '@cockpit/shared';

/** The full read model for one workspace, as the store answers it. */
export interface AccountSnapshot {
  workspace: Workspace;
  items: Item[];
  associations: Association[];
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
  | { status: 'not-up-to-date'; failure: string };
