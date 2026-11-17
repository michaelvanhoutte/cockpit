import {
  MOST_FOLLOW_UP_DAYS,
  NEXT_ACTION_LENGTH,
  TITLE_LENGTH,
  asNextAction,
  daysOnFrom,
  itemDescriptionSchema,
  itemStatus,
  itemTitleSchema,
  prioritySchema,
  setDueDateSchema,
  statusSteps,
  uuidv7,
  waitSteps,
  type Item,
  type ItemStatus,
  type Priority,
  type StatusState,
  type StatusStep,
} from '@cockpit/shared';
import type { CommandToRun, ChangesApplied } from '../accounts/answer.js';
import { captureDay } from '../domain/capture-day.js';
import type { ToolDefinition } from './create-item.js';
import { readItemId } from './delete-item.js';

/**
 * The tool an app connected to Cockpit changes an Item with ("MCP changes and
 * deletes: add update_item for the texts, priority, due date and status", issue
 * 1811): what it is called, what it says it does, how its arguments are read
 * against the form's own limits, which commands they come to for the Item as it
 * stands, and what the model is told afterwards.
 *
 * **It changes only the fields given**, each through the command the Item's
 * form sends for it (`set_title`, `set_next_action`, `set_description`,
 * `set_priority`, `set_due_date`, and the status steps the form composes,
 * `packages/shared`), so setting a text takes the texts over from Cockpit as
 * editing it does. **Every argument is read before anything is written**: a
 * call with one bad field changes nothing.
 *
 * Pure, and proved at L1 (tests/unit/mcp/update-item.test.ts). Whose Item it
 * touches, and what it writes, is the Worker's (`mcp/server.ts`), proved at L2.
 */

export const UPDATE_ITEM = 'update_item';

/** The fields a call may change, in the order they are written. */
export const UPDATE_FIELDS = ['title', 'nextAction', 'description', 'priority', 'status', 'dueDate'] as const;
export type UpdateField = (typeof UPDATE_FIELDS)[number];

/** What each field is called to the model: its argument's name, in words. */
const FIELD_NAMES: Record<UpdateField, string> = {
  title: 'title',
  nextAction: 'next action',
  description: 'description',
  priority: 'priority',
  status: 'status',
  dueDate: 'due date',
};

/** The arguments the tool takes, as the model writes them. */
const ARGUMENTS = ['id', 'title', 'next_action', 'description', 'priority', 'due_date', 'status', 'days'] as const;

const STATUS_VALUES = ['to_do', 'in_progress', 'done', 'waiting'] as const;

/** What each status is called in the app, which is what the model is told it is now. */
const STATUS_LABELS: Record<ItemStatus, string> = {
  to_do: 'To do',
  in_progress: 'In progress',
  waiting: 'Waiting for reply',
  done: 'Done',
};

/** The description's own limit, read off the contract rather than written again. */
const DESCRIPTION_LIMIT = itemDescriptionSchema.maxLength ?? 60_000;

export function updateItemTool(): ToolDefinition {
  return {
    name: UPDATE_ITEM,
    description: [
      "Change an item in the user's Cockpit, as they would on its form: only the fields you give change.",
      'Name the item by the id or the link find_items gives.',
      'Fields: title, next_action, description, priority (low, normal or high), due_date (YYYY-MM-DD) and status (to_do, in_progress, done, or waiting, which needs days: how many days to wait for a reply, so it is due that many days from today).',
      'Give a field empty or null to clear it, except status.',
      'A title, next action or description you set becomes the user\'s own text, and Cockpit stops proposing one.',
      'A dismissed item must be restored with restore_item first.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          minLength: 1,
          description: 'The id of the item, or the link that opens it, as find_items gives them.',
        },
        title: {
          type: ['string', 'null'],
          maxLength: TITLE_LENGTH,
          description: `The title, one line of at most ${TITLE_LENGTH} characters. Empty clears it.`,
        },
        next_action: {
          type: ['string', 'null'],
          maxLength: NEXT_ACTION_LENGTH,
          description: `What to do next, one line of at most ${NEXT_ACTION_LENGTH} characters. Empty clears it.`,
        },
        description: {
          type: ['string', 'null'],
          maxLength: DESCRIPTION_LIMIT,
          description: `The fuller description, at most ${DESCRIPTION_LIMIT.toLocaleString('en')} characters. Empty clears it.`,
        },
        priority: {
          type: ['string', 'null'],
          enum: [...prioritySchema.options, null],
          description: 'low, normal or high. Null clears it.',
        },
        due_date: {
          type: ['string', 'null'],
          description: 'The due date as YYYY-MM-DD. Null clears it.',
        },
        status: {
          type: 'string',
          enum: [...STATUS_VALUES],
          description: 'to_do, in_progress, done, or waiting (Waiting for reply), which needs days.',
        },
        days: {
          type: ['integer', 'null'],
          minimum: 1,
          maximum: MOST_FOLLOW_UP_DAYS,
          description: `With status waiting only: how many days to wait for a reply, 1 to ${MOST_FOLLOW_UP_DAYS}. The item is due that many days from today.`,
        },
      },
      required: ['id'],
      additionalProperties: false,
    },
  };
}

/** The fields a call asks to change. A text, the priority and the due date given empty or null are `''` or `null`: cleared. */
export interface UpdateFields {
  title?: string;
  nextAction?: string;
  description?: string | null;
  priority?: Priority | null;
  dueDate?: string | null;
  status?: { to: 'to_do' | 'in_progress' | 'done' } | { to: 'waiting'; days: number };
}

/** What a call's arguments come to: the Item to name and what to change on it, or what to tell the model. */
export type ReadUpdate = { ok: true; itemId: string; fields: UpdateFields } | { ok: false; refusal: string };

const CAN_CHANGE =
  'Give at least one field to change: title, next_action, description, priority, due_date, or status (with days for waiting).';

/** Whether an argument was left out: absent, or null where the field may be cleared by null. */
const given = (value: unknown) => value !== undefined;

/**
 * Reads a call's arguments against the form's own limits (the contract's own
 * schemas, so a limit is never written twice), refusing the first one that is
 * wrong and naming it and its limit. Nothing is written for a call refused here.
 *
 * - An argument this tool does not have, `type` or `workspace` among them, is
 *   refused by name: ignored in silence, a caller would believe it honoured.
 * - A text, the priority or the due date given null or empty is a clear.
 * - `status` is not cleared by null: an Item always has one. `waiting` needs
 *   `days` and no other status takes them.
 */
export function readUpdate(args: unknown): ReadUpdate {
  const arg = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>;

  const unknown = Object.keys(arg).filter((name) => !(ARGUMENTS as readonly string[]).includes(name));
  if (unknown.length) {
    return {
      ok: false,
      refusal: `${unknown.join(', ')} ${unknown.length === 1 ? 'is not an argument' : 'are not arguments'} of update_item; leave ${unknown.length === 1 ? 'it' : 'them'} out.`,
    };
  }

  const id = readItemId(arg);
  if (!id.ok) return id;

  const fields: UpdateFields = {};

  if (given(arg.title)) {
    const title = asText(arg.title, 'title', `one line of at most ${TITLE_LENGTH} characters, without tabs or line breaks`);
    if (!title.ok) return title;
    const checked = itemTitleSchema.safeParse(title.text);
    if (!checked.success) {
      return { ok: false, refusal: `title must be one line of at most ${TITLE_LENGTH} characters, without tabs or line breaks.` };
    }
    fields.title = checked.data;
  }

  if (given(arg.next_action)) {
    const text = asText(arg.next_action, 'next_action', `one line of at most ${NEXT_ACTION_LENGTH} characters`);
    if (!text.ok) return text;
    if (text.text.trim().length > NEXT_ACTION_LENGTH) {
      return { ok: false, refusal: `next_action must be at most ${NEXT_ACTION_LENGTH} characters.` };
    }
    fields.nextAction = asNextAction(text.text) ?? '';
  }

  if (given(arg.description)) {
    const text = asText(arg.description, 'description', `at most ${DESCRIPTION_LIMIT.toLocaleString('en')} characters`);
    if (!text.ok) return text;
    const checked = itemDescriptionSchema.safeParse(text.text);
    if (!checked.success) {
      return { ok: false, refusal: `description must be at most ${DESCRIPTION_LIMIT.toLocaleString('en')} characters.` };
    }
    fields.description = checked.data || null;
  }

  if (given(arg.priority)) {
    if (arg.priority === null || (typeof arg.priority === 'string' && arg.priority.trim() === '')) {
      fields.priority = null;
    } else {
      const priority = prioritySchema.safeParse(typeof arg.priority === 'string' ? arg.priority.trim().toLowerCase() : arg.priority);
      if (!priority.success) {
        return { ok: false, refusal: 'priority must be low, normal or high, or null to clear it.' };
      }
      fields.priority = priority.data;
    }
  }

  if (given(arg.due_date)) {
    if (arg.due_date === null || (typeof arg.due_date === 'string' && arg.due_date.trim() === '')) {
      fields.dueDate = null;
    } else {
      const date = setDueDateSchema.shape.dueDate.safeParse(typeof arg.due_date === 'string' ? arg.due_date.trim() : arg.due_date);
      if (!date.success || date.data === null) {
        return { ok: false, refusal: 'due_date must be a calendar date written YYYY-MM-DD, or null to clear it.' };
      }
      fields.dueDate = date.data;
    }
  }

  const days = arg.days === null ? undefined : arg.days;
  if (given(arg.status)) {
    const status = typeof arg.status === 'string' ? arg.status.trim().toLowerCase() : arg.status;
    if (!(STATUS_VALUES as readonly unknown[]).includes(status)) {
      return { ok: false, refusal: 'status must be to_do, in_progress, done or waiting.' };
    }
    if (status === 'waiting') {
      if (days === undefined) {
        return { ok: false, refusal: `status waiting needs days: how many days to wait for a reply, 1 to ${MOST_FOLLOW_UP_DAYS}.` };
      }
      if (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > MOST_FOLLOW_UP_DAYS) {
        return { ok: false, refusal: `days must be a whole number from 1 to ${MOST_FOLLOW_UP_DAYS}.` };
      }
      fields.status = { to: 'waiting', days };
    } else {
      if (days !== undefined) return { ok: false, refusal: 'days goes with status waiting only; leave it out.' };
      fields.status = { to: status as 'to_do' | 'in_progress' | 'done' };
    }
  } else if (days !== undefined) {
    return { ok: false, refusal: 'days goes with status waiting only; leave it out.' };
  }

  if (!Object.keys(fields).length) return { ok: false, refusal: CAN_CHANGE };
  return { ok: true, itemId: id.itemId, fields };
}

/** A text argument: text, or null, which is the same as empty. */
function asText(
  value: unknown,
  name: string,
  limit: string,
): { ok: true; text: string } | { ok: false; refusal: string } {
  if (value === null) return { ok: true, text: '' };
  if (typeof value !== 'string') return { ok: false, refusal: `${name} must be text, ${limit}, or null to clear it.` };
  return { ok: true, text: value };
}

/**
 * The time zone a wait counts its days on: that of the account's latest capture
 * that carried one the runtime can read, and UTC where none did - the source an
 * MCP capture's own due date is read on (`recentCapturedTimeZones`, issue
 * 1077). `zones` come most recent first.
 */
export function waitTimeZone(zones: readonly string[], at: Date): string {
  return zones.find((zone) => captureDay(at.toISOString(), zone) !== null) ?? 'UTC';
}

/** One command of the call, and the field it belongs to: a status is up to three. */
export interface PlannedStep {
  field: UpdateField;
  change: CommandToRun;
}

/** What a call comes to against the Item as it stands: the commands to run, and the fields that already are so. */
export interface UpdatePlan {
  steps: PlannedStep[];
  /** Fields the Item already holds as asked, so nothing is written for them. */
  alreadySo: UpdateField[];
  /** The due date a wait gives, where one is asked for. */
  waitDue: string | null;
}

/** Where an Item stands, for the status steps. */
function standing(item: Item): StatusState {
  return { status: itemStatus(item), started: item.startedAt !== null, waiting: item.waitingSince !== null };
}

/**
 * The commands a call comes to for the Item as it stands, in the order they are
 * written: the texts, the priority, the status, then the due date - the status
 * before it so that a due date given beside a wait is the one that stays, as a
 * date picked after choosing a wait does on the form.
 *
 * **A field the Item already holds is written no more** and is named in
 * `alreadySo`, so the same call sent twice changes nothing new. The form reads
 * a title or description the same way, trimmed. A wait is the exception that
 * is compared on its result: waiting again moves nothing where the Item
 * already waits and is already due the day it would be.
 */
export function planUpdate(item: Item, fields: UpdateFields, now: Date, timeZone: string): UpdatePlan {
  const issuedAt = now.toISOString();
  const envelope = () => ({ commandId: uuidv7(), issuedAt, workspaceId: item.workspaceId });
  const steps: PlannedStep[] = [];
  const alreadySo: UpdateField[] = [];
  const write = (field: UpdateField, change: CommandToRun) => steps.push({ field, change });
  const same = (field: UpdateField) => alreadySo.push(field);

  if (fields.title !== undefined) {
    if (item.title.trim() === fields.title) same('title');
    else write('title', { name: 'set_title', payload: { ...envelope(), itemId: item.id, title: fields.title } });
  }
  if (fields.nextAction !== undefined) {
    if (asNextAction(item.nextAction) === asNextAction(fields.nextAction)) same('nextAction');
    else write('nextAction', { name: 'set_next_action', payload: { ...envelope(), itemId: item.id, nextAction: fields.nextAction } });
  }
  if (fields.description !== undefined) {
    if ((item.description?.trim() || null) === fields.description) same('description');
    else write('description', { name: 'set_description', payload: { ...envelope(), itemId: item.id, description: fields.description } });
  }
  if (fields.priority !== undefined) {
    if (item.priority === fields.priority) same('priority');
    else write('priority', { name: 'set_priority', payload: { ...envelope(), itemId: item.id, priority: fields.priority } });
  }

  let waitDue: string | null = null;
  if (fields.status !== undefined) {
    const from = standing(item);
    let commands: StatusStep[];
    if (fields.status.to === 'waiting') {
      const today = captureDay(issuedAt, timeZone)?.date ?? issuedAt.slice(0, 10);
      waitDue = daysOnFrom(today, fields.status.days);
      commands = from.status === 'waiting' && item.dueDate === waitDue ? [] : waitSteps(from, fields.status.days);
    } else {
      commands = statusSteps(from, fields.status.to);
    }
    if (!commands.length) same('status');
    for (const step of commands) {
      const e = { ...envelope(), itemId: item.id };
      write(
        'status',
        step.name === 'set_done'
          ? { name: 'set_done', payload: { ...e, done: step.done } }
          : step.name === 'set_started'
            ? { name: 'set_started', payload: { ...e, started: step.started } }
            : { name: 'wait_for_reply', payload: { ...e, days: step.days, timeZone } },
      );
    }
  }

  if (fields.dueDate !== undefined) {
    // Beside a wait the date given is written over the wait's own, so it is never "already so".
    if (item.dueDate === fields.dueDate && waitDue === null) same('dueDate');
    else write('dueDate', { name: 'set_due_date', payload: { ...envelope(), itemId: item.id, dueDate: fields.dueDate } });
  }

  return { steps, alreadySo, waitDue };
}

/** What the model is told a field now is. */
function said(field: UpdateField, fields: UpdateFields, plan: UpdatePlan): string {
  switch (field) {
    case 'priority':
      return `priority ${fields.priority ?? 'none'}`;
    case 'dueDate':
      return `due date ${fields.dueDate ?? 'none'}`;
    case 'status': {
      const to = fields.status?.to ?? 'to_do';
      return to === 'waiting' ? `status Waiting for reply, due ${plan.waitDue}` : `status ${STATUS_LABELS[to]}`;
    }
    default:
      return FIELD_NAMES[field];
  }
}

const list = (parts: string[]) =>
  parts.length < 2 ? (parts[0] ?? '') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;

/** Said where a command stopped the call, by what the store gave as the reason. */
function whyItStopped(stopped: NonNullable<ChangesApplied['stopped']>): string {
  if (stopped.because === 'refused') return stopped.what;
  if (stopped.because === 'missing') return 'the item was finished or dismissed while this ran';
  return stopped.what;
}

/**
 * What the model is told after the store call: which fields changed, which
 * were already so, and - where a command was refused partway - which applied
 * before it and which did not, since what applied stays applied.
 */
export function describeUpdate(
  title: string,
  fields: UpdateFields,
  plan: UpdatePlan,
  applied: ChangesApplied | null,
  link: string,
): { reply: string } | { refusal: string } {
  const so = plan.alreadySo.length ? ` Already so: ${list(plan.alreadySo.map((f) => FIELD_NAMES[f]))}.` : '';
  if (plan.steps.length === 0) {
    return { reply: `Nothing to change on "${title}".${so}` };
  }

  const stoppedAt = applied?.stopped?.at ?? plan.steps.length;
  const fieldsInOrder = UPDATE_FIELDS.filter((field) => plan.steps.some((step) => step.field === field));
  const indexesOf = (field: UpdateField) => plan.steps.flatMap((step, i) => (step.field === field ? [i] : []));
  const changed = fieldsInOrder.filter((field) => indexesOf(field).every((i) => i < stoppedAt));

  if (!applied?.stopped) {
    return { reply: `Changed ${list(changed.map((f) => said(f, fields, plan)))} on "${title}".${so} Open it: ${link}` };
  }

  const stopped = applied.stopped;
  const stoppedField = plan.steps[stopped.at]!.field;
  const notChanged = fieldsInOrder
    .filter((field) => !changed.includes(field))
    .map((field) => {
      if (field === stoppedField) {
        const partly = indexesOf(field).some((i) => i < stoppedAt);
        return `${FIELD_NAMES[field]} (refused${partly ? ' after part of it applied' : ''}: ${whyItStopped(stopped)})`;
      }
      return `${FIELD_NAMES[field]} (not attempted)`;
    });
  const did = changed.length ? `Changed ${list(changed.map((f) => said(f, fields, plan)))} on "${title}".` : `Nothing was changed on "${title}".`;
  return { refusal: `${did} Not changed: ${notChanged.join('; ')}.${so}` };
}
