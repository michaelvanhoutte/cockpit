import { TITLE_LENGTH, captureItemSchema, cutTo, type Workspace } from '@cockpit/shared';
import { namedTheSame } from '../domain/names.js';

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
 * The server's whole instruction to the model, one line, as the issue sets it:
 * the model decides when to call, and this is the one hint it needs.
 */
export const SERVER_INSTRUCTIONS =
  'Use create_item when the user asks to capture, note or remember something in Cockpit.';


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
 * The tool, naming this account's workspaces as they are now.
 *
 * **Named twice, in the description and as an `enum`**, because clients use
 * them differently: some show the model only the description, and a schema
 * with an `enum` lets a client that validates refuse a name before asking.
 * An account with no workspaces gets no `workspace` enum at all rather than an
 * empty one, which a validating client would read as "no value is allowed".
 */
export function createItemTool(workspaces: readonly Workspace[]): ToolDefinition {
  const workspaceNames = workspaces.map((w) => w.name);
  const named = (names: string[]) => (names.length ? names.map((n) => `"${n}"`).join(', ') : 'none yet');
  return {
    name: CREATE_ITEM,
    description: [
      "Capture a note into the user's Cockpit, the way they would type it into its capture box.",
      'Cockpit proposes a title and a fuller description from the message itself.',
      `Workspaces: ${named(workspaceNames)}. Leave workspace out when it is unclear, and the item waits in every Inbox for the user to decide.`,
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
 * - A `type` is refused: a capture carries none, and an argument ignored in
 *   silence would let a caller believe it had been honoured.
 */
export function readCapture(
  args: unknown,
  workspaces: readonly Workspace[],
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

  if (given.type !== undefined) {
    return { ok: false, refusal: 'type is not an argument of create_item; leave it out.' };
  }

  const into = workspace ?? workspaces[0];
  if (!into) {
    return {
      ok: false,
      refusal: 'This Cockpit has no workspace yet, so there is nowhere to capture into. Make one in Cockpit first.',
    };
  }

  return { ok: true, message: message.data, workspaceId: into.id, decided: workspace !== undefined };
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
