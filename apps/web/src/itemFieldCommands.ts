import type { ItemStatus, Priority, RepeatRule } from '@cockpit/shared';
import type { CommandArgs } from './api/queries';

/**
 * Where an Item stands, and the two times beside its finish that the row's
 * commands act on: a start, and a wait for a reply. Done may or may not have
 * kept either.
 */
export interface StatusState {
  status: ItemStatus;
  started: boolean;
  /** Whether it carries a wait for a reply ("Set an Item Waiting for reply", issue 1463), which Done keeps. */
  waiting: boolean;
}

/** A wait for a reply asked for in the form and not yet written: how many days, and the due date that gives. */
export interface Wait {
  days: number;
  dueDate: string;
}

/**
 * What the two boxes, the priority and status controls and the due date
 * hold, before anything is sent. `status` is what the Status control holds;
 * `started` and `waiting` are never picked, only what the item carries, and
 * move when a status write lands.
 */
export interface Draft extends StatusState {
  title: string;
  description: string;
  priority: Priority | null;
  /** ISO calendar date (`2026-09-30`), or `null` for none - the empty string the date input shows for "unset" is never stored in the draft. */
  dueDate: string | null;
  /** What the Item repeats by, or `null` for *Never* - the whole rule, written as one change ("Set an Item to repeat from its form", issue 1406). */
  repeat: RepeatRule | null;
  /** *Wait for reply…* or *Wait again…* as chosen here, written as one change with the due date it gives; `null` where none was chosen. */
  wait: Wait | null;
}

/** The fields the item's form edits, in the order they are sent: a wait before the due date, so a date typed after choosing one lands over it. */
export const FIELDS = ['title', 'description', 'priority', 'wait', 'dueDate', 'status', 'repeat'] as const;
export type Field = (typeof FIELDS)[number];
/** The fields a row, the selection bar and the form all write through `fieldWrites`: a repeat is the form's alone (`repeatWrites`). */
export type SimpleField = Exclude<Field, 'repeat'>;

/** What each field is called where a person is told it changed. */
export const FIELD_NAMES: Record<Field, string> = {
  title: 'title',
  description: 'description',
  priority: 'priority',
  wait: 'wait for a reply',
  dueDate: 'due date',
  status: 'status',
  repeat: 'repeat',
};

/** Where a wait goes back to when it is undone: the status and due date it replaced. */
export interface WaitPutBack {
  status: ItemStatus;
  started: boolean;
  waiting: boolean;
  dueDate: string | null;
}

/** What the wait field writes: a wait of so many days, or the state a wait is undone back to. */
export type WaitValue = number | WaitPutBack;

/**
 * What a field is stored as: the text trimmed, an empty description as none -
 * the same reading `whatChanged` compares on, so a value sent and a value
 * compared can never differ.
 */
export function asStored(draft: Draft, field: Field): string | Priority | ItemStatus | RepeatRule | number | null {
  if (field === 'title') return draft.title.trim();
  if (field === 'description') return draft.description.trim() || null;
  if (field === 'status') return draft.status;
  if (field === 'wait') return draft.wait?.days ?? null;
  return draft[field];
}

/** The commands a row sends, as the steps a status change is made of. */
export type StatusStep =
  | { name: 'set_done'; done: boolean }
  | { name: 'set_started'; started: boolean }
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

/**
 * A wait undone, from where it left the Item (`from`) to what it replaced
 * (`back`): the wait ended where there was none before - with the start the
 * Item had - then finished with again where it was Done. The due date goes
 * back separately.
 */
export function waitUndoneSteps(from: StatusState, back: WaitPutBack): StatusStep[] {
  const ended: StatusStep[] = back.waiting || !from.waiting ? [] : [{ name: 'set_started', started: back.started }];
  return back.status === 'done' ? [...ended, { name: 'set_done', done: true }] : ended;
}

type Envelope = {
  commandId: string;
  issuedAt: string;
  workspaceId: string;
  itemId: string;
};

/** One change, and what the Item holds once it has landed - `null` for a field that is not the status, which is simply its value. */
export interface FieldWrite {
  command: CommandArgs;
  held: StatusState | null;
}

/**
 * The changes that set one field to a value, in the order they are sent: what
 * the batched Save and the docked form's per-field commits both send, and what
 * an undo sends back. Every field is one change but the status and a wait, which
 * can be two or three, so each takes its own envelope. `timeZone` is the
 * device's, which a wait counts its days on.
 */
export function fieldWrites(
  field: SimpleField,
  envelope: () => Envelope,
  value: string | Priority | ItemStatus | WaitValue | null,
  from: StatusState,
  timeZone = 'UTC',
): FieldWrite[] {
  const one = (command: (e: Envelope) => CommandArgs): FieldWrite[] => [
    { command: command(envelope()), held: null },
  ];
  /** Where the Item stands, and nothing else a caller's draft carries beside it. */
  const standing: StatusState = { status: from.status, started: from.started, waiting: from.waiting };
  /** The steps as changes, each holding where the Item stands once it has landed. */
  const stepped = (steps: StatusStep[]): FieldWrite[] => {
    let state = standing;
    return steps.map((step) => {
      state = afterStep(state, step);
      const e = envelope();
      const command: CommandArgs =
        step.name === 'set_done'
          ? { name: 'set_done', payload: { ...e, done: step.done } }
          : step.name === 'set_started'
            ? { name: 'set_started', payload: { ...e, started: step.started } }
            : { name: 'wait_for_reply', payload: { ...e, days: step.days, timeZone } };
      return { command, held: state };
    });
  };
  switch (field) {
    case 'title':
      return one((e) => ({ name: 'set_title', payload: { ...e, title: value as string } }));
    case 'description':
      return one((e) => ({
        name: 'set_description',
        payload: { ...e, description: value as string | null },
      }));
    case 'priority':
      return one((e) => ({ name: 'set_priority', payload: { ...e, priority: value as Priority | null } }));
    case 'dueDate':
      return one((e) => ({ name: 'set_due_date', payload: { ...e, dueDate: value as string | null } }));
    case 'status':
      return stepped(statusSteps(from, value as ItemStatus));
    case 'wait': {
      if (typeof value === 'number') return stepped(waitSteps(from, value));
      const back = value as WaitPutBack;
      // The due date first, while the Item is still open to take it the way it was.
      const dueDate = one((e) => ({ name: 'set_due_date', payload: { ...e, dueDate: back.dueDate } }));
      return [...dueDate.map((write) => ({ ...write, held: standing })), ...stepped(waitUndoneSteps(standing, back))];
    }
  }
}

/**
 * The change that sets an Item's Repeats to a rule, or to *Never* with `null`
 * ("Set an Item to repeat from its form, and see the rule on its row", issue
 * 1406). **One change for the whole rule**: its frequency, *Next on* and
 * due-after are one thing the server checks together. `seriesId` is the series
 * the Item joins if it has none, and `timeZone` the device's, stored with the rule.
 */
export function repeatWrites(
  envelope: () => Envelope,
  rule: RepeatRule | null,
  series: { seriesId: string; timeZone: string },
): FieldWrite[] {
  return [
    {
      command: {
        name: 'set_repeat',
        payload: {
          ...envelope(),
          seriesId: series.seriesId,
          repeat: rule && { ...rule, timeZone: series.timeZone },
        },
      },
      held: null,
    },
  ];
}
