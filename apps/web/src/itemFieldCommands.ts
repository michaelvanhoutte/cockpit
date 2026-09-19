import type { Priority } from '@cockpit/shared';
import type { CommandArgs } from './api/queries';

/** What the two boxes, the priority control and the due date hold, before anything is sent. */
export interface Draft {
  title: string;
  description: string;
  priority: Priority | null;
  /** ISO calendar date (`2026-09-30`), or `null` for none - the empty string the date input shows for "unset" is never stored in the draft. */
  dueDate: string | null;
}

/** The four fields the item's form edits, in the order they are sent. */
export const FIELDS = ['title', 'description', 'priority', 'dueDate'] as const;
export type Field = (typeof FIELDS)[number];

/** What each field is called where a person is told it changed. */
export const FIELD_NAMES: Record<Field, string> = {
  title: 'title',
  description: 'description',
  priority: 'priority',
  dueDate: 'due date',
};

/**
 * What a field is stored as: the text trimmed, an empty description as none -
 * the same reading `whatChanged` compares on, so a value sent and a value
 * compared can never differ.
 */
export function asStored(draft: Draft, field: Field): string | Priority | null {
  if (field === 'title') return draft.title.trim();
  if (field === 'description') return draft.description.trim() || null;
  return draft[field];
}

/**
 * The change that sets one field to a value: what the batched Save and the
 * docked form's per-field commits both send, and what an undo sends back.
 */
export function fieldCommand(
  field: Field,
  envelope: {
    commandId: string;
    issuedAt: string;
    workspaceId: string;
    itemId: string;
  },
  value: string | Priority | null,
): CommandArgs {
  switch (field) {
    case 'title':
      return {
        name: 'set_title',
        payload: { ...envelope, title: value as string },
      };
    case 'description':
      return {
        name: 'set_description',
        payload: { ...envelope, description: value as string | null },
      };
    case 'priority':
      return {
        name: 'set_priority',
        payload: { ...envelope, priority: value as Priority | null },
      };
    case 'dueDate':
      return {
        name: 'set_due_date',
        payload: { ...envelope, dueDate: value as string | null },
      };
  }
}
