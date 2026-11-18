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
  panelPlace,
  type ReadableWorkspace,
  type StatusState,
  type StatusStep,
} from '@cockpit/shared';
import type { ChangeToRun, ChangesApplied } from '../accounts/answer.js';
import { captureDay } from '../domain/capture-day.js';
import { foldName } from '../domain/names.js';
import type { ToolDefinition } from './create-item.js';
import { readItemId } from './delete-item.js';
import { ADD_FILES_SCHEMA, oneLine, MOST_FILES_REMOVED, describeAdded, readAddFiles, readRemoveFiles, recordFile, type FileStored, type FileToAdd } from './files.js';
import { describePanels, findPanel, namesLeftOut, PANEL_GIVEN_MAX_LENGTH, panelNamesAllowed, type PanelChoice } from './panels.js';

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
export const UPDATE_FIELDS = ['title', 'nextAction', 'description', 'priority', 'status', 'dueDate', 'panels', 'files'] as const;
export type UpdateField = (typeof UPDATE_FIELDS)[number];

/** What each field is called to the model: its argument's name, in words. */
const FIELD_NAMES: Record<UpdateField, string> = {
  title: 'title',
  nextAction: 'next action',
  description: 'description',
  priority: 'priority',
  status: 'status',
  dueDate: 'due date',
  panels: 'Panels',
  files: 'files',
};

/** The arguments the tool takes, as the model writes them. */
const ARGUMENTS = [
  'id',
  'title',
  'next_action',
  'description',
  'priority',
  'due_date',
  'status',
  'days',
  'add_panels',
  'remove_panels',
  'move_to_panel',
  'add_files',
  'remove_files',
] as const;

/** What `move_to_panel` says to take an item off every Panel. */
export const INBOX = 'Inbox';

/** The most Panels one call names. */
export const MOST_PANELS_NAMED = 50;

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

/**
 * The tool, naming every Workspace's Panels that take items as they are now:
 * twice, in the description and as an `enum` on each Panel argument, for the
 * reason `createItemTool` does - and with no `enum` where there is no Panel or
 * more than a list names (`namesLeftOut`).
 */
export function updateItemTool(catalogue: readonly ReadableWorkspace[] = []): ToolDefinition {
  const names = panelNamesAllowed(catalogue);
  const panelNames = (about: string) => ({
    type: 'string',
    ...(names.length ? { enum: names } : {}),
    description: about,
  });
  return {
    name: UPDATE_ITEM,
    description: [
      "Change an item in the user's Cockpit, as they would on its form: only the fields you give change.",
      'Name the item by the id or the link find_items gives.',
      'Fields: title, next_action, description, priority (low, normal or high), due_date (YYYY-MM-DD) and status (to_do, in_progress, done, or waiting, which needs days: how many days to wait for a reply, so it is due that many days from today).',
      'Give a field empty or null to clear it, except status.',
      'A title, next action or description you set becomes the user\'s own text, and Cockpit stops proposing one.',
      'Setting a pulled Gmail or Outlook item to done or to do puts its label or star back or takes it off at the source.',
      'Panels: add_panels files it on more Panels, remove_panels takes it off some, and move_to_panel takes it off every Panel and puts it on one, or on "Inbox" for none; each puts it on top. Do not combine move_to_panel with the other two.',
      `Panels that take items: ${describePanels(catalogue)}. A Panel is named as above, in any case, within the item's workspace; where several share a name, write Dashboard ▸ Panel. An item no workspace has been chosen for may go on a Panel of any workspace, which then becomes its workspace.`,
      'Files: add_files attaches files, each with its contents as base64 (at most 10 MB together per call), and remove_files takes files off by the names find_items shows; a name two files share is refused, and the user removes one in the app.',
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
        add_panels: {
          type: ['array', 'null'],
          items: panelNames('A Panel to file the item on as well, on top.'),
          maxItems: MOST_PANELS_NAMED,
          description: 'Panels to file the item on as well, by name; it goes on top of each.',
        },
        remove_panels: {
          type: ['array', 'null'],
          items: panelNames('A Panel to take the item off.'),
          maxItems: MOST_PANELS_NAMED,
          description: 'Panels to take the item off, by name. With none left it is in the Inbox.',
        },
        move_to_panel: {
          type: ['string', 'null'],
          // Null is no move, as for `priority`; a Panel called Inbox is not listed twice, since "Inbox" always means the Inbox.
          ...(namesLeftOut(catalogue) ? {} : { enum: [...new Set([...names.filter((name) => foldName(name) !== foldName(INBOX)), INBOX]), null] }),
          description: 'One Panel to move the item to, by name, off every Panel it is on and on top of this one; "Inbox" takes it off them all.',
        },
        add_files: ADD_FILES_SCHEMA,
        remove_files: {
          type: ['array', 'null'],
          items: { type: 'string', description: 'The name of a file on the item, as find_items shows it.' },
          maxItems: MOST_FILES_REMOVED,
          description: 'Files to take off the item, by name. A name the item has no file of is refused with the files it has.',
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
  panels?: PanelsAsked;
  files?: FilesAsked;
}

/** The files a call adds, read, and the names of the files it removes, not yet found on the Item. */
export interface FilesAsked {
  add: FileToAdd[];
  remove: string[];
}

/** What a call's arguments come to: the Item to name and what to change on it, or what to tell the model. */
export type ReadUpdate = { ok: true; itemId: string; fields: UpdateFields } | { ok: false; refusal: string };

const CAN_CHANGE =
  'Give at least one field to change: title, next_action, description, priority, due_date, status (with days for waiting), add_panels, remove_panels, move_to_panel, add_files or remove_files.';

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

  const read = readFieldArgs(arg);
  if (!read.ok) return read;
  const fields = read.fields;

  const panels = readPanelArgs(arg);
  if (!panels.ok) return panels;
  if (panels.asked) fields.panels = panels.asked;

  const add = readAddFiles(arg.add_files);
  if (!add.ok) return add;
  const remove = readRemoveFiles(arg.remove_files);
  if (!remove.ok) return remove;
  if (add.files.length || remove.names.length) fields.files = { add: add.files, remove: remove.names };

  if (!Object.keys(fields).length) return { ok: false, refusal: CAN_CHANGE };
  return { ok: true, itemId: id.itemId, fields };
}

/**
 * The fields of a form that a call may set, read against the form's own limits
 * (the contract's own schemas, so a limit is never written twice): shared by
 * `update_item` and by `create_item`, which reads the same arguments (issue 1812).
 * Each one given null or empty is a clear; the first that is wrong is refused,
 * naming it and its limit.
 */
export function readFieldArgs(
  arg: Record<string, unknown>,
): { ok: true; fields: UpdateFields } | { ok: false; refusal: string } {
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
    if (text.text.trim().length > NEXT_ACTION_LENGTH || /[\t\r\n]/.test(text.text.trim())) {
      return { ok: false, refusal: `next_action must be one line of at most ${NEXT_ACTION_LENGTH} characters, without tabs or line breaks.` };
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
  return { ok: true, fields };
}

/** What the Panel arguments ask, by the names given: nothing resolved yet, which needs the Item's Workspace. */
export interface PanelsAsked {
  add: string[];
  remove: string[];
  /** A Panel's name, or `Inbox` to take it off every Panel; absent to leave where it is. */
  moveTo?: string;
}

/** A list of Panel names: absent, null or empty is none, and anything but non-empty text is refused. */
export function readPanelNames(
  value: unknown,
  name: string,
): { ok: true; names: string[] } | { ok: false; refusal: string } {
  if (value === undefined || value === null) return { ok: true, names: [] };
  const wrong = { ok: false as const, refusal: `${name} must be a list of Panel names, at most ${MOST_PANELS_NAMED} of them.` };
  if (!Array.isArray(value) || value.length > MOST_PANELS_NAMED) return wrong;
  const names: string[] = [];
  for (const one of value) {
    if (typeof one !== 'string' || one.trim() === '') return wrong;
    names.push(one.trim());
  }
  return { ok: true, names };
}

function readPanelArgs(
  arg: Record<string, unknown>,
): { ok: true; asked?: PanelsAsked } | { ok: false; refusal: string } {
  const add = readPanelNames(arg.add_panels, 'add_panels');
  if (!add.ok) return add;
  const remove = readPanelNames(arg.remove_panels, 'remove_panels');
  if (!remove.ok) return remove;
  let moveTo: string | undefined;
  if (arg.move_to_panel !== undefined && arg.move_to_panel !== null && arg.move_to_panel !== '') {
    if (typeof arg.move_to_panel !== 'string' || arg.move_to_panel.trim() === '' || arg.move_to_panel.length > PANEL_GIVEN_MAX_LENGTH) {
      return { ok: false, refusal: 'move_to_panel must be the name of one Panel, or "Inbox".' };
    }
    moveTo = arg.move_to_panel.trim();
  }
  if (moveTo !== undefined && (add.names.length || remove.names.length)) {
    return { ok: false, refusal: 'move_to_panel cannot be combined with add_panels or remove_panels; give one or the other.' };
  }
  if (!add.names.length && !remove.names.length && moveTo === undefined) return { ok: true };
  return { ok: true, asked: { add: add.names, remove: remove.names, ...(moveTo !== undefined ? { moveTo } : {}) } };
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

/** The Panels a call names, found: the Item's own Workspace's, or any Workspace's for one no Workspace has been chosen for. */
export interface PanelsResolved {
  add: PanelChoice[];
  remove: PanelChoice[];
  /** One Panel, or `inbox` to take it off every one; absent to leave it be. */
  moveTo?: PanelChoice | 'inbox';
}

/**
 * Finds each Panel a call names (`findPanel`) in the Workspace the Item has, or
 * in every one where none has been chosen for it, and refuses the first it
 * cannot with what would do. **An Item belongs to one Workspace**, so the Panels
 * it is to be filed on must all be of one, and a Panel to take it off is one of
 * its own: an Item no Workspace has been chosen for is on none.
 */
export function resolveUpdatePanels(
  item: Item,
  catalogue: readonly ReadableWorkspace[],
  asked: PanelsAsked,
): { ok: true; panels: PanelsResolved } | { ok: false; refusal: string } {
  const scope = item.workspaceDecided ? item.workspaceId : null;
  const found = (names: readonly string[]) => {
    const panels: PanelChoice[] = [];
    for (const name of names) {
      const one = findPanel(catalogue, scope, name);
      if (!one.ok) return one;
      if (!panels.some((panel) => panel.id === one.panel.id)) panels.push(one.panel);
    }
    return { ok: true as const, panels };
  };

  if (asked.remove.length && scope === null) {
    return { ok: false, refusal: 'That item is on no Panel yet, and no workspace has been chosen for it, so remove_panels has nothing to take it off.' };
  }
  const add = found(asked.add);
  if (!add.ok) return add;
  const remove = found(asked.remove);
  if (!remove.ok) return remove;
  const both = add.panels.find((panel) => remove.panels.some((one) => one.id === panel.id));
  if (both) {
    return { ok: false, refusal: `${JSON.stringify(both.name)} is in both add_panels and remove_panels; name it in one.` };
  }

  let moveTo: PanelChoice | 'inbox' | undefined;
  if (asked.moveTo !== undefined) {
    if (foldName(asked.moveTo) === foldName(INBOX)) moveTo = 'inbox';
    else {
      const one = findPanel(catalogue, scope, asked.moveTo);
      if (!one.ok) return one;
      moveTo = one.panel;
    }
  }

  const landing = [...add.panels, ...(moveTo && moveTo !== 'inbox' ? [moveTo] : [])];
  const workspaces = [...new Set(landing.map((panel) => panel.workspace))];
  if (workspaces.length > 1) {
    return {
      ok: false,
      refusal: `Those Panels are in different workspaces (${workspaces.map((name) => JSON.stringify(name)).join(', ')}), and an item belongs to one; name Panels of one workspace.`,
    };
  }
  return { ok: true, panels: { add: add.panels, remove: remove.panels, ...(moveTo !== undefined ? { moveTo } : {}) } };
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
  change: ChangeToRun;
}

/** What a call comes to against the Item as it stands: the commands to run, and the fields that already are so. */
export interface UpdatePlan {
  steps: PlannedStep[];
  /** Fields the Item already holds as asked, so nothing is written for them. */
  alreadySo: UpdateField[];
  /** The due date a wait gives, where one is asked for. */
  waitDue: string | null;
  /** What was done about the Panels, in words, where the call asked about them. */
  panelsSaid: string | null;
  /** What was done about the files, in words, where the call asked about them. */
  filesSaid: string | null;
}

/** The files a call comes to once found and stored: those to take off the Item, and those already in R2 to record on it. */
export interface FilesResolved {
  remove: { id: string; filename: string }[];
  add: FileStored[];
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
export function planUpdate(
  item: Item,
  fields: UpdateFields,
  now: Date,
  timeZone: string,
  panels: PanelsResolved | null = null,
  files: FilesResolved | null = null,
): UpdatePlan {
  const issuedAt = now.toISOString();
  const envelope = () => ({ commandId: uuidv7(), issuedAt, workspaceId: item.workspaceId });
  const steps: PlannedStep[] = [];
  const alreadySo: UpdateField[] = [];
  const write = (field: UpdateField, change: ChangeToRun) => steps.push({ field, change });
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
    else if (waitDue !== null && fields.dueDate === waitDue) same('dueDate');
    else write('dueDate', { name: 'set_due_date', payload: { ...envelope(), itemId: item.id, dueDate: fields.dueDate } });
  }

  // Filed last, so a status given beside them is the one the Item is filed with.
  let panelsSaid: string | null = null;
  if (panels) {
    const place = (panel: PanelChoice) => panelPlace(panel.dashboard, panel.name);
    const said: string[] = [];
    const own = (panel: PanelChoice) => ({ commandId: uuidv7(), issuedAt, workspaceId: panel.workspaceId, itemId: item.id });
    for (const panel of panels.remove) {
      write('panels', { name: 'remove_item_from_panel', payload: { ...own(panel), panelId: panel.id } });
    }
    if (panels.remove.length) said.push(`taken off ${list(panels.remove.map(place))}`);
    if (panels.moveTo === 'inbox') {
      // An Item no Workspace has been chosen for is on no Panel already.
      if (item.workspaceDecided) {
        write('panels', { name: 'move_item_to_panel', payload: { ...envelope(), itemId: item.id, panelId: null, order: [] } });
        said.push('moved to the Inbox');
      } else same('panels');
    } else if (panels.moveTo) {
      write('panels', { name: 'move_item_to_panel', onTop: true, payload: { ...own(panels.moveTo), panelId: panels.moveTo.id } });
      said.push(`moved on top of ${place(panels.moveTo)}`);
    }
    for (const panel of panels.add) {
      write('panels', { name: 'add_item_to_panel', onTop: true, payload: { ...own(panel), panelId: panel.id } });
    }
    if (panels.add.length) said.push(`filed on top of ${list(panels.add.map(place))}`);
    panelsSaid = said.length ? said.join('; ') : null;
  }

  // Last: files taken off, then files recorded, which are already in R2 under the Item's key.
  let filesSaid: string | null = null;
  if (files && (files.remove.length || files.add.length)) {
    const said: string[] = [];
    for (const file of files.remove) {
      write('files', {
        name: 'remove_attachment',
        payload: { ...envelope(), itemId: item.id, attachmentId: file.id },
      });
    }
    if (files.remove.length) said.push(`removed ${list(files.remove.map((file) => JSON.stringify(oneLine(file.filename))))}`);
    for (const file of files.add) write('files', recordFile(file, item.id, item.workspaceId, issuedAt));
    if (files.add.length) said.push(`added ${describeAdded(files.add)}`);
    filesSaid = said.join('; ');
  }

  return { steps, alreadySo, waitDue, panelsSaid, filesSaid };
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
      if (to !== 'waiting') return `status ${STATUS_LABELS[to]}`;
      return fields.dueDate === undefined ? `status Waiting for reply, due ${plan.waitDue}` : 'status Waiting for reply';
    }
    case 'files':
      return plan.filesSaid ? `files: ${plan.filesSaid}` : FIELD_NAMES.files;
    case 'panels':
      return plan.panelsSaid ? `Panels: ${plan.panelsSaid}` : FIELD_NAMES.panels;
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
