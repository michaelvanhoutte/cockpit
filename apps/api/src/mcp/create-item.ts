import { TITLE_LENGTH, captureItemSchema, cutTo, type ItemType, type Workspace } from '@cockpit/shared';
import { typeToCaptureAs } from '../domain/item-types.js';
import { namedTheSame } from '../domain/names.js';

/**
 * The one tool an app connected to Cockpit is offered ("Connect Claude to
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
 * The server's whole instruction to the model, one line, as the issue sets it:
 * the model decides when to call, and this is the one hint it needs.
 */
export const SERVER_INSTRUCTIONS =
  'Use create_item when the user asks to capture, note or remember something in Cockpit.';

/**
 * How many `create_item` calls one grant is admitted for in a minute, refused ones included - the same number
 * the Claude Code hooks are held to (`HOOK_CALLS_PER_MINUTE`), for the same
 * reason: well above anything a person asking Claude does, and a ceiling on
 * what a runaway loop can write before somebody notices.
 */
export const APP_CAPTURES_PER_MINUTE = 60;

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
 * The tool, naming this account's workspaces and types as they are now.
 *
 * **Named twice, in the description and as an `enum`**, because clients use
 * them differently: some show the model only the description, and a schema
 * with an `enum` lets a client that validates refuse a name before asking.
 * An account with no workspaces gets no `workspace` enum at all rather than an
 * empty one, which a validating client would read as "no value is allowed".
 */
export function createItemTool(workspaces: readonly Workspace[], types: readonly ItemType[]): ToolDefinition {
  const workspaceNames = workspaces.map((w) => w.name);
  const typeNames = types.map((t) => t.name);
  const named = (names: string[]) => (names.length ? names.map((n) => `"${n}"`).join(', ') : 'none yet');
  return {
    name: CREATE_ITEM,
    description: [
      "Capture a note into the user's Cockpit, the way they would type it into its capture box.",
      'Cockpit proposes a title and a fuller description from the message itself.',
      `Workspaces: ${named(workspaceNames)}. Leave workspace out when it is unclear, and the item waits in every Inbox for the user to decide.`,
      `Types: ${named(typeNames)}. Leave type out for a Note.`,
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
        type: {
          type: 'string',
          ...(typeNames.length ? { enum: typeNames } : {}),
          description: 'What kind of item it is, by name.',
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
      /** False where no workspace was named, which is the capture page's "Not sure yet". */
      decided: boolean;
      typeId: string;
    }
  | { ok: false; refusal: string };

/**
 * Reads a call's arguments against the account as it is at the moment of the
 * call - not as it was when the tool was listed, since a workspace can be
 * renamed or deleted in between.
 *
 * - The message is held to the capture page's own rule (the contract's
 *   `captureItemSchema`), so it trims and is 1 to 60,000 characters.
 * - A name is matched the way the account itself compares names
 *   (`namedTheSame`), so "work" finds "Work".
 * - A name that matches nothing is refused with the names there are, which is
 *   what lets the model put it right on its next try.
 * - No workspace named lands undecided, recorded against the first workspace
 *   as the capture page records one against the workspace it was opened from.
 *   With no workspace at all there is nowhere to record it, which the capture
 *   page answers by offering to make one, and this answers in words.
 * - No type named is a Note: the account's own Note where it has one, its
 *   first type otherwise, which is what a connector's capture is too.
 */
export function readCapture(
  args: unknown,
  workspaces: readonly Workspace[],
  types: readonly ItemType[],
  noteTypeId: string,
): ReadCapture {
  const given = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>;

  const message = captureItemSchema.shape.message.safeParse(given.message);
  if (!message.success) {
    return {
      ok: false,
      refusal: `message must be between 1 and ${MESSAGE_LIMIT.toLocaleString('en')} characters of text.`,
    };
  }

  const names = (rows: readonly { name: string }[]) => rows.map((row) => `"${row.name}"`).join(', ');

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

  let type: ItemType | undefined;
  if (given.type !== undefined && given.type !== null && given.type !== '') {
    if (typeof given.type === 'string') type = namedTheSame(types, given.type);
    if (!type) {
      return {
        ok: false,
        refusal: `No type is called ${JSON.stringify(given.type)}. The types are ${names(types)}; or leave type out for a Note.`,
      };
    }
  }
  type ??= typeToCaptureAs(types, noteTypeId);
  if (!type) return { ok: false, refusal: 'This Cockpit has no types to capture with yet.' };

  const into = workspace ?? workspaces[0];
  if (!into) {
    return {
      ok: false,
      refusal: 'This Cockpit has no workspace yet, so there is nowhere to capture into. Make one in Cockpit first.',
    };
  }

  return { ok: true, message: message.data, workspaceId: into.id, decided: workspace !== undefined, typeId: type.id };
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
