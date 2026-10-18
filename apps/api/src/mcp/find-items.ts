import { PRIORITY_LABELS, STATUS_LABELS, itemStatus, type DueWindow, type PriorityChoice, type Workspace } from '@cockpit/shared';
import { z } from 'zod';
import { namedTheSame } from '../domain/names.js';
import { FIND_PAGE, type FindCursor, type FindQuery, type FoundPage } from '../domain/find-items.js';
import type { ToolDefinition } from './create-item.js';

/**
 * The tool an app connected to Cockpit looks for Items with ("Find items in
 * Cockpit by text and condition, over MCP", issue 1242): what it is called, what
 * it says it does, how its arguments are read against the account as it is now,
 * and how what it found is told back.
 *
 * Pure, and proved at L1 (tests/unit/mcp/find-items.test.ts). Whether it is
 * reachable, whose account it reads and how often it may ask is the Worker's
 * (`mcp/server.ts`), proved at L2.
 */

export const FIND_ITEMS = 'find_items';

/** The names a status is asked for by: only the open ones, since a finished Item is `include_done`'s. */
const STATUS_NAMES = { 'to do': 'to_do', 'in progress': 'in_progress' } as const;

/** The names a priority is asked for by, as the filter bar offers them. */
const PRIORITY_NAMES: Record<string, PriorityChoice> = {
  [PRIORITY_LABELS.low.toLowerCase()]: 'low',
  [PRIORITY_LABELS.normal.toLowerCase()]: 'normal',
  [PRIORITY_LABELS.high.toLowerCase()]: 'high',
  none: 'none',
};

/** The names a due condition is asked for by, as the filter bar's windows are. */
const DUE_NAMES: Record<string, DueWindow> = {
  overdue: 'overdue',
  today: 'today',
  'this week': 'week',
  'this month': 'month',
  'this quarter': 'quarter',
  'not set': 'none',
};

const ARGUMENTS = ['text', 'workspace', 'panel', 'status', 'priority', 'due', 'today', 'include_done', 'cursor'] as const;

/** How long the text sought may be: a phrase, never a document. */
const TEXT_LIMIT = 500;

/** Offered as an `enum` and named in the description, for the reason `createItemTool` does both. */
const named = (names: readonly string[]) => (names.length ? names.map((n) => `"${n}"`).join(', ') : 'none yet');
const capital = (name: string) => name.charAt(0).toUpperCase() + name.slice(1);

const STATUS_OPTIONS = Object.keys(STATUS_NAMES).map(capital);
const PRIORITY_OPTIONS = Object.keys(PRIORITY_NAMES).map(capital);
const DUE_OPTIONS = Object.keys(DUE_NAMES).map(capital);

/** The tool, naming this account's workspaces as they are now. */
export function findItemsTool(workspaces: readonly Workspace[]): ToolDefinition {
  const workspaceNames = workspaces.map((w) => w.name);
  return {
    name: FIND_ITEMS,
    description: [
      "Find items in the user's Cockpit by text and condition. Read-only: nothing is changed.",
      'Every argument is optional and they all apply together; with none, it lists the open items.',
      'Text is matched without regard to case in an item\'s title, description, next action and sender, as Cockpit\'s own Find does; nothing is matched by meaning.',
      'Open items only, unless include_done is true; dismissed items are never found.',
      'It searches every workspace unless one is named.',
      `Workspaces: ${named(workspaceNames)}.`,
      "A panel is named with panel: only the items filed on a panel of that name, or gathered by a filter panel of that name, on any dashboard, as the panel's own header counts them; with workspace, only that workspace's panels. Finished items are not on a panel, so include_done adds none.",
      `Up to ${FIND_PAGE} items a page, most recently changed first, each with its description whole, where it is and a link that opens it in Cockpit; no total is given.`,
      "Each item also names its attachments, each with a link that opens the file for an hour without signing in (anyone holding the link can open it, so do not share it); a file's contents are never included.",
      'When more follow, the reply ends with a cursor: call again with the same arguments and that cursor for the next page. An item changed between two pages can be missed.',
      "Pass today as the user's local date (YYYY-MM-DD): due conditions are counted from it, and from the UTC day without it.",
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', maxLength: TEXT_LIMIT, description: 'Words to look for.' },
        workspace: {
          type: 'string',
          ...(workspaceNames.length ? { enum: workspaceNames } : {}),
          description: 'Only items in this workspace, by name.',
        },
        panel: {
          type: 'string',
          description: 'Only items on a panel of this name (filed on it, or gathered by it if it is a filter panel), by name; one that matches none is refused with the panels there are.',
        },
        status: { type: 'string', enum: STATUS_OPTIONS, description: 'Only items with this status.' },
        priority: { type: 'string', enum: PRIORITY_OPTIONS, description: 'Only items with this priority; "None" is items with no priority.' },
        due: {
          type: 'string',
          enum: DUE_OPTIONS,
          description: 'Only items due in this window; the periods also take in what is overdue. "Not set" is items with no due date.',
        },
        today: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: "The user's local date, YYYY-MM-DD." },
        include_done: { type: 'boolean', description: 'Also list finished items. Default false.' },
        cursor: { type: 'string', description: 'The cursor a previous reply ended with, for the next page.' },
      },
      required: [],
      additionalProperties: false,
    },
  };
}

/** What a call's arguments come to: a query to run, or what to tell the model. */
export type ReadFind = { ok: true; query: FindQuery } | { ok: false; refusal: string };

/** The cursor as an app carries it: opaque to it, and nothing but a position to Cockpit. */
export function cursorToText(cursor: FindCursor): string {
  return btoa(JSON.stringify([cursor.updatedAt, cursor.id])).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

const cursorSchema = z.tuple([z.iso.datetime(), z.uuid()]);

/** The position a cursor names, or `null` for text Cockpit did not give. */
export function cursorFromText(text: string): FindCursor | null {
  try {
    const padded = text.replaceAll('-', '+').replaceAll('_', '/');
    const read = cursorSchema.safeParse(JSON.parse(atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='))));
    return read.success ? { updatedAt: read.data[0], id: read.data[1] } : null;
  } catch {
    return null;
  }
}

/** A real calendar day written `YYYY-MM-DD`. */
function isDay(text: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(text)) return false;
  const [year = 0, month = 1, date = 1] = text.split('-').map(Number);
  const day = new Date(Date.UTC(year, month - 1, date));
  return day.getUTCFullYear() === year && day.getUTCMonth() === month - 1 && day.getUTCDate() === date;
}

/**
 * Reads a call's arguments against the account as it is at the moment of the
 * call - not as it was when the tool was listed.
 *
 * - **An argument the tool does not have is refused, naming it**, and so is a
 *   value of the wrong kind: one ignored in silence would let a caller believe
 *   it had been honoured.
 * - A name - a workspace, a status, a priority, a due window - is matched
 *   without regard to case, and one that matches nothing is refused with the
 *   names there are, which is what lets the model put it right on its next try.
 * - **No `today` is the UTC day**, which the description asks the agent to
 *   replace with the user's own date.
 */
export function readFind(args: unknown, workspaces: readonly Workspace[], now: Date): ReadFind {
  const given = (args && typeof args === 'object' && !Array.isArray(args) ? args : {}) as Record<string, unknown>;
  const refuse = (refusal: string): ReadFind => ({ ok: false, refusal });

  const unknown = Object.keys(given).find((key) => !(ARGUMENTS as readonly string[]).includes(key));
  if (unknown !== undefined) {
    return refuse(`${unknown} is not an argument of find_items; the arguments are ${ARGUMENTS.join(', ')}.`);
  }

  /** The text of an argument given, `null` where it was left out, or a refusal where it is not text. */
  const textOf = (key: (typeof ARGUMENTS)[number]): string | null | ReadFind => {
    const value = given[key];
    if (value === undefined || value === null || value === '') return null;
    return typeof value === 'string' ? value.trim() || null : refuse(`${key} must be text.`);
  };
  const isRefusal = (value: string | null | ReadFind): value is ReadFind => typeof value === 'object' && value !== null;

  const text = textOf('text');
  if (isRefusal(text)) return text;
  if (text !== null && text.length > TEXT_LIMIT) return refuse(`text must be at most ${TEXT_LIMIT} characters.`);

  const workspaceName = textOf('workspace');
  if (isRefusal(workspaceName)) return workspaceName;
  let workspaceId: string | null = null;
  if (workspaceName !== null) {
    const workspace = namedTheSame(workspaces, workspaceName);
    if (!workspace) {
      return refuse(
        workspaces.length
          ? `No workspace is called ${JSON.stringify(workspaceName)}. The workspaces are ${named(workspaces.map((w) => w.name))}; or leave workspace out to search them all.`
          : 'There are no workspaces yet, so there is nothing to find.',
      );
    }
    workspaceId = workspace.id;
  }

  const panel = textOf('panel');
  if (isRefusal(panel)) return panel;

  /** One of a few names, matched without regard to case. */
  const chosen = <V>(key: 'status' | 'priority' | 'due', names: Record<string, V>, options: readonly string[]) => {
    const value = textOf(key);
    if (isRefusal(value)) return value;
    if (value === null) return null;
    const lowered = value.toLowerCase();
    // Own keys only: "constructor" or "__proto__" is not a name on offer.
    return Object.hasOwn(names, lowered) ? { value: names[lowered] as V } : refuse(`${key} must be one of ${named(options)}.`);
  };
  const status = chosen('status', STATUS_NAMES, STATUS_OPTIONS);
  if (status && 'ok' in status) return status;
  const priority = chosen('priority', PRIORITY_NAMES, PRIORITY_OPTIONS);
  if (priority && 'ok' in priority) return priority;
  const due = chosen('due', DUE_NAMES, DUE_OPTIONS);
  if (due && 'ok' in due) return due;

  const todayText = textOf('today');
  if (isRefusal(todayText)) return todayText;
  if (todayText !== null && !isDay(todayText)) return refuse('today must be a date written YYYY-MM-DD.');

  const includeDone = given.include_done;
  if (includeDone !== undefined && includeDone !== null && typeof includeDone !== 'boolean') {
    return refuse('include_done must be true or false.');
  }

  const cursorText = textOf('cursor');
  if (isRefusal(cursorText)) return cursorText;
  const after = cursorText === null ? null : cursorFromText(cursorText);
  if (cursorText !== null && !after) {
    return refuse('cursor is not one find_items gave; leave it out to start from the first page.');
  }

  return {
    ok: true,
    query: {
      workspaceId,
      panel,
      text: text ?? '',
      status: status?.value ?? null,
      priority: priority?.value ?? null,
      due: due?.value ?? null,
      includeDone: includeDone === true,
      today: todayText ?? now.toISOString().slice(0, 10),
      after,
    },
  };
}

/** What the model is told when no Panel in scope goes by the name asked: the Panels there are, so it can try again. */
export function refuseNoPanel(panel: string, names: readonly string[], workspaceName: string | null): string {
  const where = workspaceName === null ? 'in any workspace' : `in workspace ${JSON.stringify(workspaceName)}`;
  return names.length
    ? `No panel is called ${JSON.stringify(panel)} ${where}. The panels are ${named(names)}; or leave panel out.`
    : `No panel is called ${JSON.stringify(panel)}: there are no panels ${where} yet.`;
}

/**
 * What the model is told it found: each Item whole - its description in
 * full - with where it is and a link that opens it, then the cursor where more
 * follow. No total, which would mean reading every Item in scope.
 *
 * A finished Item is marked Done and says where it was filed, as *All items*
 * does; an Item never filed is in the *Inbox*.
 *
 * **Each file is named, with its link where `links` has one** (an attachment id
 * to the address that opens it for an hour without signing in); `null` is an
 * environment with no key to seal links, which names the files only. Never
 * their contents.
 */
export function formatFound(found: FoundPage, origin: string, links: ReadonlyMap<string, string> | null = null): string {
  if (found.rows.length === 0) return 'No item matches.';
  const lines = found.rows.map(({ item, workspaceName, places, attachments }, at) => {
    const link = new URL(`/w/${encodeURIComponent(item.workspaceId)}`, origin);
    link.searchParams.set('item', item.id);
    const description = item.description?.trim();
    return [
      `${at + 1}. ${item.title.trim() || 'Untitled'}`,
      `   Next action: ${item.nextAction?.trim() || 'none'}`,
      `   Status: ${STATUS_LABELS[itemStatus(item)]}`,
      `   Priority: ${item.priority ? PRIORITY_LABELS[item.priority] : 'none'}`,
      `   Due: ${item.dueDate ?? 'not set'}`,
      `   Sender: ${item.sender?.trim() || 'none'}`,
      `   Where: ${places.length ? places.map((place) => `${workspaceName} ▸ ${place}`).join('; ') : `Inbox (${workspaceName})`}`,
      `   Last changed: ${item.updatedAt}`,
      `   Open: ${link.href}`,
      ...(attachments.length
        ? [
            '   Attachments:',
            ...attachments.map((file) => {
              const href = links?.get(file.id);
              return `   - ${file.filename}${href ? `: ${href}` : ''}`;
            }),
          ]
        : []),
      `   Description: ${description ? description.replaceAll('\n', '\n   ') : 'none'}`,
    ].join('\n');
  });
  const count = `${found.rows.length} ${found.rows.length === 1 ? 'item' : 'items'}, most recently changed first.`;
  const more = found.next
    ? `More follow. For the next page, call find_items again with the same arguments and cursor "${cursorToText(found.next)}".`
    : 'That is all of them.';
  return [count, ...lines, more].join('\n\n');
}
