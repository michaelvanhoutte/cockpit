import type { ItemStatus, Priority, RepeatRule } from '@cockpit/shared';
import type { CommandArgs } from './api/queries';

/** Where an Item stands, and whether it carries a start time - the two things the row's commands act on. Done may or may not have kept one. */
export interface StatusState {
  status: ItemStatus;
  started: boolean;
}

/**
 * What the two boxes, the priority and status controls and the due date
 * hold, before anything is sent. `status` is what the Status control holds;
 * `started` is never picked, only what the item carries, and moves when a
 * status write lands.
 */
export interface Draft extends StatusState {
  title: string;
  description: string;
  priority: Priority | null;
  /** ISO calendar date (`2026-09-30`), or `null` for none - the empty string the date input shows for "unset" is never stored in the draft. */
  dueDate: string | null;
  /** What the Item repeats by, or `null` for *Never* - the whole rule, written as one change ("Set an Item to repeat from its form", issue 1406). */
  repeat: RepeatRule | null;
}

/** The six fields the item's form edits, in the order they are sent. */
export const FIELDS = ['title', 'description', 'priority', 'dueDate', 'status', 'repeat'] as const;
export type Field = (typeof FIELDS)[number];
/** The fields a row, the selection bar and the form all write through `fieldWrites`: a repeat is the form's alone (`repeatWrites`). */
export type SimpleField = Exclude<Field, 'repeat'>;

/** What each field is called where a person is told it changed. */
export const FIELD_NAMES: Record<Field, string> = {
  title: 'title',
  description: 'description',
  priority: 'priority',
  dueDate: 'due date',
  status: 'status',
  repeat: 'repeat',
};

/**
 * What a field is stored as: the text trimmed, an empty description as none -
 * the same reading `whatChanged` compares on, so a value sent and a value
 * compared can never differ.
 */
export function asStored(draft: Draft, field: Field): string | Priority | ItemStatus | RepeatRule | null {
  if (field === 'title') return draft.title.trim();
  if (field === 'description') return draft.description.trim() || null;
  if (field === 'status') return draft.status;
  return draft[field];
}

/** The two commands a row sends, as the steps a status change is made of. */
export type StatusStep = { name: 'set_done'; done: boolean } | { name: 'set_started'; started: boolean };

/**
 * What a step leaves the Item as. `set_done` never touches the start time, and
 * undoing Done reads whichever the Item carries ("Mark an item In progress, and
 * see since when", issue 568).
 */
export function afterStep(state: StatusState, step: StatusStep): StatusState {
  if (step.name === 'set_done') {
    if (step.done) return { ...state, status: 'done' };
    return { ...state, status: state.started ? 'in_progress' : 'to_do' };
  }
  return { started: step.started, status: step.started ? 'in_progress' : 'to_do' };
}

/**
 * The commands that take an Item from one status to another, the row's own:
 * *In progress* keeps a start time the Item still carries and starts now where
 * it has none, *To do* clears it, and a finished Item is reopened first because
 * `set_started` refuses one. Nothing for the status it already has.
 */
export function statusSteps(from: StatusState, to: ItemStatus): StatusStep[] {
  if (to === from.status) return [];
  const reopen: StatusStep[] = from.status === 'done' ? [{ name: 'set_done', done: false }] : [];
  const reopened = reopen.reduce(afterStep, from);
  if (to === 'done') return [{ name: 'set_done', done: true }];
  if (to === 'in_progress') {
    return reopened.started ? reopen : [...reopen, { name: 'set_started', started: true }];
  }
  return reopened.started ? [...reopen, { name: 'set_started', started: false }] : reopen;
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
 * an undo sends back. Every field is one change but the status, which can be
 * two, so each takes its own envelope.
 */
export function fieldWrites(
  field: SimpleField,
  envelope: () => Envelope,
  value: string | Priority | ItemStatus | null,
  from: StatusState,
): FieldWrite[] {
  const one = (command: (e: Envelope) => CommandArgs): FieldWrite[] => [
    { command: command(envelope()), held: null },
  ];
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
    case 'status': {
      let state = from;
      return statusSteps(from, value as ItemStatus).map((step) => {
        state = afterStep(state, step);
        const e = envelope();
        const command: CommandArgs =
          step.name === 'set_done'
            ? { name: 'set_done', payload: { ...e, done: step.done } }
            : { name: 'set_started', payload: { ...e, started: step.started } };
        return { command, held: state };
      });
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
