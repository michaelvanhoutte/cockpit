import type { ItemStatus } from './item.js';

/**
 * Where an Item stands, and the two times beside its finish that the row's
 * commands act on: a start, and a wait for a reply. Done may or may not have
 * kept either.
 *
 * Shared by the Item's form and by a connected app's `update_item` ("MCP
 * changes and deletes: add update_item", issue 1811), so both compose the same
 * `set_done`, `set_started` and `wait_for_reply` for a status.
 */
export interface StatusState {
  status: ItemStatus;
  started: boolean;
  /** Whether it carries a wait for a reply ("Set an Item Waiting for reply", issue 1463), which Done keeps. */
  waiting: boolean;
}

/** The commands a row sends, as the steps a status change is made of. */
export type StatusStep =
  | { name: 'set_done'; done: boolean }
  | { name: 'set_started'; started: boolean; keepsRun?: true }
  | { name: 'wait_for_reply'; days: number };

/**
 * What a step leaves the Item as. `set_done` never touches the start time or
 * the wait, and undoing Done reads whichever the Item carries ("Mark an item In
 * progress, and see since when", issue 568); `set_started` ends a wait either
 * way, and a wait leaves the start alone ("Set an Item Waiting for reply",
 * issue 1463).
 */
export function afterStep(state: StatusState, step: StatusStep): StatusState {
  if (step.name === 'set_done') {
    if (step.done) return { ...state, status: 'done' };
    return { ...state, status: state.waiting ? 'waiting' : state.started ? 'in_progress' : 'to_do' };
  }
  if (step.name === 'wait_for_reply') return { ...state, waiting: true, status: 'waiting' };
  return { started: step.started, waiting: false, status: step.started ? 'in_progress' : 'to_do' };
}

/** Said where a status change would have to bring a wait back without knowing how long to wait. */
export const WAIT_NOT_PUT_BACK = 'A wait for a reply cannot be put back. Choose Wait for reply… again.';

/**
 * The commands that take an Item from one status to another, the row's own:
 * *In progress* keeps a start time the Item still carries and starts now where
 * it has none, *To do* clears it, both end a wait, and a finished Item is
 * reopened first because `set_started` and `wait_for_reply` refuse one. Nothing
 * for the status it already has.
 *
 * **Waiting for reply needs its days** (`waitSteps`): a status reaches it here
 * only by reopening an Item finished from it, and throws otherwise, since
 * waiting again would move the due date.
 */
export function statusSteps(from: StatusState, to: ItemStatus): StatusStep[] {
  if (to === from.status) return [];
  const reopen: StatusStep[] = from.status === 'done' ? [{ name: 'set_done', done: false }] : [];
  const reopened = reopen.reduce(afterStep, from);
  if (to === 'done') return [{ name: 'set_done', done: true }];
  if (to === reopened.status) return reopen;
  if (to === 'waiting') throw new Error(WAIT_NOT_PUT_BACK);
  return [...reopen, { name: 'set_started', started: to === 'in_progress' }];
}

/** *Wait for reply…* or *Wait again…*: a finished Item reopened first, then one wait of `days`. */
export function waitSteps(from: StatusState, days: number): StatusStep[] {
  const reopen: StatusStep[] = from.status === 'done' ? [{ name: 'set_done', done: false }] : [];
  return [...reopen, { name: 'wait_for_reply', days }];
}
