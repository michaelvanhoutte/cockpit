import {
  MOST_FOLLOW_UP_DAYS,
  NEXT_ACTION_LENGTH,
  TITLE_LENGTH,
  captureItemSchema,
  panelPlace,
  cutTo,
  prioritySchema,
  statusSteps,
  uuidv7,
  waitSteps,
  type Priority,
  type ReadableWorkspace,
  type StatusStep,
  type Workspace,
} from '@cockpit/shared';
import type { CommandToRun } from '../accounts/answer.js';
import { namedTheSame } from '../domain/names.js';
import { describePanels, findPanel, panelNamesAllowed } from './panels.js';
import { MOST_PANELS_NAMED, readFieldArgs, readPanelNames, type UpdateFields } from './update-item.js';

/**
 * The tool an app connected to Cockpit captures with ("Connect Claude to
 * Cockpit, and capture an item from it", issue 599): what it is called, what
 * it says it does, and how its arguments are read against the account they
 * will be captured into.
 *
 * Pure, and proved at L1 (tests/unit/mcp/create-item.test.ts). Whether it is
 * reachable, whose account it reads and what it writes is the Worker's
 * (`mcp/server.ts`), proved at L2.
 */

export const CREATE_ITEM = 'create_item';

/**
 * The server's whole instruction to the model, a line per tool that needs one:
 * the model decides when to call, and this is the one hint it needs.
 * `find_items` is said both for a question about what is in Cockpit and for
 * the check before capturing something already there ("Find items in Cockpit
 * by text and condition, over MCP", issue 1242). `delete_item` is named for
 * what the person says, delete or remove, and `restore_item` for undoing it
 * ("MCP changes and deletes: add delete_item and restore_item", issue 1810),
 * and `update_item` for changing one ("MCP changes and deletes: add update_item",
 * issue 1811).
 */
export const SERVER_INSTRUCTIONS = [
  'Use create_item when the user asks to capture, note or remember something in Cockpit, with the title, priority, due date, status or Panel they name.',
  'Use find_items when the user asks what is in Cockpit, and before capturing something that may already be there.',
  'Use update_item when the user asks to change an item in Cockpit: its title, next action, description, priority, due date, status or Panels.',
  'Use delete_item when the user asks to delete or remove something in Cockpit, and restore_item to undo it.',
].join(' ');


/** The tool as `tools/list` answers it: a JSON Schema the client shows the model. */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, Record<string, unknown>>;
    required: string[];
    additionalProperties: false;
  };
}

/**
 * The tool, naming this account's workspaces and the Panels that take items as
 * they are now.
 *
 * **Named twice, in the description and as an `enum`**, because clients use
 * them differently: some show the model only the description, and a schema
 * with an `enum` lets a client that validates refuse a name before asking.
 * An account with no workspaces, or no Panels, gets no `enum` at all rather than
 * an empty one, which a validating client would read as "no value is allowed".
 */
export function createItemTool(catalogue: readonly ReadableWorkspace[]): ToolDefinition {
  const workspaceNames = catalogue.map((one) => one.workspace.name);
  const panelNames = panelNamesAllowed(catalogue);
  const named = (names: string[]) => (names.length ? names.map((n) => `"${n}"`).join(', ') : 'none yet');
  return {
    name: CREATE_ITEM,
    description: [
      "Capture a note into the user's Cockpit, the way they would type it into its capture box.",
      'Cockpit proposes a title and a fuller description from the message itself; give title and the message becomes the description.',
      'Every field the capture box sets can be given: title, next_action, priority (low, normal or high), due_date (YYYY-MM-DD), status (to_do, in_progress, done, or waiting, which needs days: how many days to wait for a reply) and panels.',
      `Workspaces: ${named(workspaceNames)}. Leave workspace out when it is unclear, and the item waits in every Inbox for the user to decide; with panels it is filed on them, on top, in the Panels' workspace.`,
      `Panels that take items: ${describePanels(catalogue)}. A Panel is named as above, in any case, within the workspace; where several share a name, write Dashboard ▸ Panel.`,
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          minLength: 1,
          maxLength: MESSAGE_LIMIT,
          description: 'The note, in the user\'s words.',
        },
        workspace: {
          type: 'string',
          ...(workspaceNames.length ? { enum: workspaceNames } : {}),
          description: 'Which workspace it belongs to, by name.',
        },
        title: {
          type: 'string',
          maxLength: TITLE_LENGTH,
          description: `The title, one line of at most ${TITLE_LENGTH} characters. Given, the message becomes the description.`,
        },
        next_action: {
          type: 'string',
          maxLength: NEXT_ACTION_LENGTH,
          description: `What to do next, one line of at most ${NEXT_ACTION_LENGTH} characters.`,
        },
        priority: { type: 'string', enum: [...prioritySchema.options], description: 'low, normal or high.' },
        due_date: { type: 'string', description: 'The due date as YYYY-MM-DD.' },
        status: {
          type: 'string',
          enum: ['to_do', 'in_progress', 'done', 'waiting'],
          description: 'to_do, in_progress, done, or waiting (Waiting for reply), which needs days. To do if left out.',
        },
        days: {
          type: 'integer',
          minimum: 1,
          maximum: MOST_FOLLOW_UP_DAYS,
          description: `With status waiting only: how many days to wait for a reply, 1 to ${MOST_FOLLOW_UP_DAYS}. The item is due that many days from today.`,
        },
        panels: {
          type: 'array',
          items: { type: 'string', ...(panelNames.length ? { enum: panelNames } : {}), description: 'A Panel to file the item on, by name.' },
          maxItems: MOST_PANELS_NAMED,
          description: 'Panels to file the item on, by name, instead of the Inbox; it goes on top of each.',
        },
      },
      required: ['message'],
      additionalProperties: false,
    },
  };
}

/** The capture page's own limit, read off the contract rather than written again. */
const MESSAGE_LIMIT = captureItemSchema.shape.message.maxLength ?? 60_000;

/** What a call's arguments come to: a capture to make, or what to tell the model. */
export type ReadCapture =
  | {
      ok: true;
      message: string;
      workspaceId: string;
      /** False where no workspace was named and no Panel was, which is the capture page's "Not sure yet". */
      decided: boolean;
      title?: string;
      nextAction?: string;
      priority?: Priority;
      dueDate?: string;
      /** A status other than to do, which the capture is followed by the steps to. */
      status?: NonNullable<UpdateFields['status']>;
      /** The Panels to file it on, found: each of the one workspace. */
      panels: { id: string; place: string }[];
    }
  | { ok: false; refusal: string };

const ARGUMENTS = [
  'message',
  'workspace',
  'title',
  'next_action',
  'priority',
  'due_date',
  'status',
  'days',
  'panels',
] as const;

/**
 * Reads a call's arguments against the account as it is at the moment of the
 * call - not as it was when the tool was listed, since a workspace can be
 * renamed or deleted in between.
 *
 * - The message is held to the capture page's own rule (the contract's
 *   `captureItemSchema`), so it trims and is 1 to 60,000 characters.
 * - The title, next action, priority, due date and status are held to the
 *   Item form's own rules (`readFieldArgs`); one given empty is left out, since
 *   a new item has nothing to clear.
 * - A name is matched the way the account itself compares names (`namedTheSame`), so
 *   "work" finds "Work", and a Panel's as `findPanel` does, in the workspace named.
 * - A name that matches nothing is refused with the names there are, which is
 *   what lets the model put it right on its next try.
 * - **With Panels and no workspace** the item is filed in the workspace of the
 *   Panels, which must all be one, as Capture's *Any workspace* does.
 * - No workspace and no Panel lands undecided, recorded against the first workspace
 *   as the capture page records one against the workspace it was opened from.
 *   With no workspace at all there is nowhere to record it, which the capture
 *   page answers by offering to make one, and this answers in words.
 * - An argument this tool does not have, `type` among them, is refused by name:
 *   ignored in silence, a caller would believe it honoured.
 */
export function readCapture(args: unknown, catalogue: readonly ReadableWorkspace[]): ReadCapture {
  const given = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>;
  const workspaces = catalogue.map((one) => one.workspace);

  const message = captureItemSchema.shape.message.safeParse(given.message);
  if (!message.success) {
    return {
      ok: false,
      refusal: `message must be between 1 and ${MESSAGE_LIMIT.toLocaleString('en')} characters of text.`,
    };
  }

  const names = (rows: readonly { name: string }[]) => rows.map((row) => `"${row.name}"`).join(', ');

  const strange = Object.keys(given).filter((name) => !(ARGUMENTS as readonly string[]).includes(name));
  if (strange.length) {
    return {
      ok: false,
      refusal: `${strange.join(', ')} ${strange.length === 1 ? 'is not an argument' : 'are not arguments'} of create_item; leave ${strange.length === 1 ? 'it' : 'them'} out.`,
    };
  }

  let workspace: Workspace | undefined;
  if (given.workspace !== undefined && given.workspace !== null && given.workspace !== '') {
    if (typeof given.workspace === 'string') workspace = namedTheSame(workspaces, given.workspace);
    if (!workspace) {
      return {
        ok: false,
        refusal: workspaces.length
          ? `No workspace is called ${JSON.stringify(given.workspace)}. The workspaces are ${names(workspaces)}; or leave workspace out.`
          : 'There are no workspaces yet; leave workspace out.',
      };
    }
  }

  const form = readFieldArgs(given);
  if (!form.ok) return form;
  const { title, nextAction, priority, dueDate, status } = form.fields;

  const asked = readPanelNames(given.panels, 'panels');
  if (!asked.ok) return asked;
  const panels: { id: string; place: string; workspace: Workspace }[] = [];
  for (const name of asked.names) {
    const found = findPanel(catalogue, workspace?.id ?? null, name);
    if (!found.ok) return found;
    if (!panels.some((panel) => panel.id === found.panel.id)) {
      panels.push({
        id: found.panel.id,
        place: panelPlace(found.panel.dashboard, found.panel.name),
        workspace: workspaces.find((one) => one.id === found.panel.workspaceId)!,
      });
    }
  }
  const panelsIn = [...new Set(panels.map((panel) => panel.workspace))];
  if (panelsIn.length > 1) {
    return {
      ok: false,
      refusal: `Those Panels are in different workspaces (${names(panelsIn)}), and an item belongs to one; name Panels of one workspace.`,
    };
  }
  workspace ??= panelsIn[0];

  const into = workspace ?? workspaces[0];
  if (!into) {
    return {
      ok: false,
      refusal: 'This Cockpit has no workspace yet, so there is nowhere to capture into. Make one in Cockpit first.',
    };
  }

  return {
    ok: true,
    message: message.data,
    workspaceId: into.id,
    decided: workspace !== undefined,
    ...(title ? { title } : {}),
    ...(nextAction ? { nextAction } : {}),
    ...(priority ? { priority } : {}),
    ...(dueDate ? { dueDate } : {}),
    ...(status && status.to !== 'to_do' ? { status } : {}),
    panels: panels.map(({ id, place }) => ({ id, place })),
  };
}

/**
 * The commands that follow a capture to leave the new item with the status asked
 * for, as the row's own steps do (`packages/shared`), and the due date set
 * after a wait so that the one given beside it is the one that stays. Run in the
 * store call the capture is in, one after the other.
 */
export function stepsAfterCapture(
  read: Extract<ReadCapture, { ok: true }>,
  itemId: string,
  issuedAt: string,
  timeZone: string,
): CommandToRun[] {
  if (!read.status) return [];
  const fresh = { status: 'to_do' as const, started: false, waiting: false };
  const steps: StatusStep[] =
    read.status.to === 'waiting' ? waitSteps(fresh, read.status.days) : statusSteps(fresh, read.status.to);
  const e = () => ({ commandId: uuidv7(), issuedAt, workspaceId: read.workspaceId, itemId });
  const commands = steps.map<CommandToRun>((step) =>
    step.name === 'set_done'
      ? { name: 'set_done', payload: { ...e(), done: step.done } }
      : step.name === 'set_started'
        ? { name: 'set_started', payload: { ...e(), started: step.started } }
        : { name: 'wait_for_reply', payload: { ...e(), days: step.days, timeZone } },
  );
  if (read.status.to === 'waiting' && read.dueDate) {
    commands.push({ name: 'set_due_date', payload: { ...e(), dueDate: read.dueDate } });
  }
  return commands;
}

/**
 * What a capture says it was sent by: the app's registered name, trimmed and
 * cut to what a sender may be - without cutting a character in half, which a
 * name of emoji at the limit would otherwise end in - or `null` for an app
 * that registered no name worth showing.
 */
export function senderFrom(clientName: string): string | null {
  const sender = cutTo(clientName.trim(), TITLE_LENGTH).trim();
  return sender || null;
}
