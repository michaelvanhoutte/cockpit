import {
  DUE_WINDOWS,
  ITEM_STATUSES,
  UNTITLED,
  isAPeriod,
  itemLink,
  itemStatus,
  workspaceIsDecided,
  type DueWindow,
  type Item,
  type ItemStatus,
  type Priority,
  type Workspace,
} from '@cockpit/shared';
import type { FindItemsAsk, FoundItem, FoundPage, PanelToFind } from '../accounts/find-items.js';
import { foldName, namedTheSame } from '../domain/names.js';
import type { ToolDefinition } from './create-item.js';

/**
 * The tool an app connected to Cockpit reads Items with ("Find items in
 * Cockpit from a connected app, over MCP", issue 1240): what it is called,
 * what it says it does, how its arguments are read against the account, and
 * how a page of Items is told back.
 *
 * Pure, and proved at L1 (tests/unit/mcp/find-items.test.ts). Whose Items it
 * reads, the limits it is held to and the links it hands out are the Worker's
 * (`mcp/server.ts`), proved at L2 (tests/integration/http/find-items.test.ts).
 */

export const FIND_ITEMS = 'find_items';

/** The names the tool's arguments go by: no other argument is read. */
const ARGUMENTS = [
  'text',
  'workspace',
  'panel',
  'status',
  'priority',
  'due',
  'or_overdue',
  'include_done',
  'today',
  'cursor',
] as const;

/** What each status, priority and due window is called to the model, as the Dashboard filter bar calls it. */
const STATUS_NAMES: Record<ItemStatus, string> = {
  to_do: 'To do',
  in_progress: 'In progress',
  waiting: 'Waiting for reply',
  done: 'Done',
};
const PRIORITY_NAMES: Record<Priority, string> = { high: 'High', normal: 'Normal', low: 'Low' };
const DUE_NAMES: Record<DueWindow, string> = {
  overdue: 'Overdue',
  today: 'Today',
  week: 'This week',
  month: 'This month',
  quarter: 'This quarter',
  none: 'Not set',
};

const STATUS_CHOICES = ITEM_STATUSES.map((status) => STATUS_NAMES[status]);
/** Highest first, as a person lists them. */
const PRIORITIES: readonly Priority[] = ['high', 'normal', 'low'];
const PRIORITY_CHOICES = PRIORITIES.map((priority) => PRIORITY_NAMES[priority]);
const DUE_CHOICES = DUE_WINDOWS.map((window) => DUE_NAMES[window]);

/** The longest text searched for: far more than anyone types, and a ceiling on what one call carries. */
const TEXT_LIMIT = 500;

/**
 * The tool, naming this account's workspaces as they are now - in the
 * description and as an `enum`, for the reason `create_item` gives both.
 */
export function findItemsTool(workspaces: readonly Workspace[]): ToolDefinition {
  const workspaceNames = workspaces.map((w) => w.name);
  const named = (names: string[]) => (names.length ? names.map((n) => `"${n}"`).join(', ') : 'none yet');
  return {
    name: FIND_ITEMS,
    description: [
      "Find items in the user's Cockpit. It only reads: nothing is changed.",
      'Every argument is optional and each one narrows the answer; with none, every open item comes back.',
      'text is matched as Cockpit\'s own Find matches it, ignoring case, in an item\'s title, description, next action or sender - never by meaning.',
      `Workspaces: ${named(workspaceNames)}; the whole Cockpit is searched unless one is named.`,
      'panel is the name of a Panel or Filter panel, and finds the items filed on it or gathered by it.',
      'Open items only, unless include_done is true; a dismissed item is never returned.',
      'Pass today, the user\'s local date as YYYY-MM-DD, so that due and Filter panels count from the right day; without it the UTC day is used, which can be a day off near midnight.',
      'Items come 25 at a time, most recently changed first, each with its title, whole description, next action, status, priority, due date, sender, where it is, when it last changed, its files (names and links) and a link that opens it.',
      'When more follow, the reply says so and gives a cursor: call again with the same arguments and that cursor for the next page. No total is given, and an item changed between two pages can be missed.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', maxLength: TEXT_LIMIT, description: 'Words to find, in the title, description, next action or sender.' },
        workspace: {
          type: 'string',
          ...(workspaceNames.length ? { enum: workspaceNames } : {}),
          description: 'Only items of this workspace, by name.',
        },
        panel: {
          type: 'string',
          description: 'Only items filed on, or gathered by, the Panel of this name (on any dashboard unless workspace is named).',
        },
        status: { type: 'string', enum: STATUS_CHOICES, description: 'Only items with this status. Asking for Done includes finished items.' },
        priority: { type: 'string', enum: PRIORITY_CHOICES, description: 'Only items with this priority.' },
        due: {
          type: 'string',
          enum: DUE_CHOICES,
          description: 'Only items whose due date falls in this window, counted from today. Not set means no due date.',
        },
        or_overdue: {
          type: 'boolean',
          description: 'With due This week, This month or This quarter (or Today): also items overdue. Defaults to true, as Cockpit\'s filter does.',
        },
        include_done: { type: 'boolean', description: 'Also return finished items.' },
        today: { type: 'string', description: 'The user\'s local date, YYYY-MM-DD. Without it the UTC day is used.' },
        cursor: { type: 'string', description: 'The cursor a previous reply gave, for the next page.' },
      },
      required: [],
      additionalProperties: false,
    },
  };
}

/** What a call's arguments come to: a question to ask the account, or what to tell the model. */
export type ReadFind =
  | {
      ok: true;
      /** The question, less the Panels, which are read against the account's own Panels next (`resolvePanels`). */
      ask: Omit<FindItemsAsk, 'panelIds'>;
      /** The Panel named, or null for no Panel condition. */
      panel: string | null;
      /** The one Workspace named, or null for the whole account. */
      workspace: Workspace | null;
    }
  | { ok: false; refusal: string };

/**
 * Reads a call's arguments against the account as it is at the moment of the
 * call.
 *
 * - An argument the tool does not have is refused, naming it: ignored in
 *   silence, a caller would believe it had narrowed the answer.
 * - A workspace is matched the way the account compares names, and one that
 *   matches nothing is refused with the names there are.
 * - A status, priority or due window is matched ignoring case, and one there
 *   is not is refused with the ones there are.
 * - `or_overdue` is refused unless `due` is a period it widens (Today, This week,
 *   This month, This quarter): given with nothing to widen, it would be ignored in silence.
 * - `today` is a real date, and the UTC day of `now` where it is left out.
 * - Asking for status Done reads finished items, since it could not be
 *   answered from open ones alone.
 */
export function readFind(args: unknown, workspaces: readonly Workspace[], now: Date): ReadFind {
  const given = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>;
  const unknown = Object.keys(given).find((key) => !(ARGUMENTS as readonly string[]).includes(key));
  if (unknown !== undefined) {
    return { ok: false, refusal: `${unknown} is not an argument of find_items; leave it out.` };
  }
  const left = (value: unknown) => value === undefined || value === null || value === '';

  let text = '';
  if (!left(given.text)) {
    if (typeof given.text !== 'string' || given.text.length > TEXT_LIMIT) {
      return { ok: false, refusal: `text must be words of at most ${TEXT_LIMIT} characters.` };
    }
    text = given.text;
  }

  let workspace: Workspace | null = null;
  if (!left(given.workspace)) {
    workspace = (typeof given.workspace === 'string' ? namedTheSame(workspaces, given.workspace) : undefined) ?? null;
    if (!workspace) {
      const names = workspaces.map((w) => `"${w.name}"`).join(', ');
      return {
        ok: false,
        refusal: workspaces.length
          ? `No workspace is called ${JSON.stringify(given.workspace)}. The workspaces are ${names}; or leave workspace out.`
          : 'There are no workspaces yet; leave workspace out.',
      };
    }
  }

  let panel: string | null = null;
  if (!left(given.panel)) {
    if (typeof given.panel !== 'string' || given.panel.trim() === '') {
      return { ok: false, refusal: 'panel must be the name of a Panel.' };
    }
    panel = given.panel;
  }

  const status = choice(given.status, 'status', ITEM_STATUSES, STATUS_NAMES);
  if (!status.ok) return status;
  const priority = choice(given.priority, 'priority', PRIORITIES, PRIORITY_NAMES);
  if (!priority.ok) return priority;
  const due = choice(given.due, 'due', DUE_WINDOWS, DUE_NAMES);
  if (!due.ok) return due;

  for (const flag of ['or_overdue', 'include_done'] as const) {
    if (!left(given[flag]) && typeof given[flag] !== 'boolean') {
      return { ok: false, refusal: `${flag} must be true or false.` };
    }
  }
  if (!left(given.or_overdue) && !(due.value && isAPeriod(due.value))) {
    return {
      ok: false,
      refusal: 'or_overdue only goes with due Today, This week, This month or This quarter; leave it out.',
    };
  }

  let today = now.toISOString().slice(0, 10);
  if (!left(given.today)) {
    if (typeof given.today !== 'string' || !isADate(given.today)) {
      return { ok: false, refusal: 'today must be a date written YYYY-MM-DD, such as 2026-10-19.' };
    }
    today = given.today;
  }

  let after: FindItemsAsk['after'] = null;
  if (!left(given.cursor)) {
    after = typeof given.cursor === 'string' ? readCursor(given.cursor) : null;
    if (!after) {
      return { ok: false, refusal: 'cursor is not one Cockpit gave. Leave it out to start from the first page.' };
    }
  }

  return {
    ok: true,
    panel,
    workspace,
    ask: {
      text,
      workspaceId: workspace?.id ?? null,
      statuses: status.value ? [status.value] : [],
      priorities: priority.value ? [priority.value] : [],
      due: due.value
        ? { window: due.value, orOverdue: isAPeriod(due.value) ? given.or_overdue !== false : false }
        : null,
      includeDone: given.include_done === true || status.value === 'done',
      today,
      after,
    },
  };
}

/** One value from a list of choices, matched by the name the model is given, ignoring case; nothing given is nothing chosen. */
function choice<V extends string>(
  given: unknown,
  argument: string,
  values: readonly V[],
  names: Record<V, string>,
): { ok: true; value: V | null } | { ok: false; refusal: string } {
  if (given === undefined || given === null || given === '') return { ok: true, value: null };
  const found = typeof given === 'string' ? values.find((value) => names[value].toLowerCase() === given.trim().toLowerCase()) : undefined;
  if (found !== undefined) return { ok: true, value: found };
  const choices = values.map((value) => `"${names[value]}"`).join(', ');
  return { ok: false, refusal: `${argument} must be one of ${choices}; or leave it out.` };
}

/** Whether this is a real calendar date written YYYY-MM-DD. */
function isADate(text: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(text)) return false;
  const date = new Date(`${text}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === text;
}

/**
 * The Panels a `panel` argument names, out of the Panels in scope: every one
 * of that name, on whichever Dashboard, matched the way names are compared.
 * One that matches none is refused with the Panels there are.
 */
export function resolvePanels(
  name: string,
  panels: readonly PanelToFind[],
): { ok: true; panelIds: string[] } | { ok: false; refusal: string } {
  const folded = foldName(name);
  const named = panels.filter((panel) => foldName(panel.name) === folded);
  if (named.length > 0) return { ok: true, panelIds: named.map((panel) => panel.id) };
  const names = [...new Set(panels.map((panel) => panel.name))].map((n) => `"${n}"`).join(', ');
  return {
    ok: false,
    refusal: panels.length
      ? `No panel is called ${JSON.stringify(name)}. The panels are ${names}; or leave panel out.`
      : 'There are no panels to search; leave panel out.',
  };
}

/** The cursor that continues after this Item: its change time and id, which are all the next page needs. */
export function cursorAfter(item: Pick<Item, 'updatedAt' | 'id'>): string {
  return base64url(`${item.updatedAt}|${item.id}`);
}

/** What a cursor continues after, or null for a string Cockpit did not give. */
export function readCursor(cursor: string): { changedAt: string; id: string } | null {
  const text = fromBase64url(cursor);
  const at = text?.indexOf('|') ?? -1;
  if (text === null || at < 0) return null;
  const changedAt = text.slice(0, at);
  const id = text.slice(at + 1);
  const real = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/u.test(changedAt) && !Number.isNaN(Date.parse(changedAt));
  return real && /^[A-Za-z0-9_-]{1,64}$/u.test(id) ? { changedAt, id } : null;
}

function base64url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '');
}

function fromBase64url(text: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/u.test(text)) return null;
  try {
    const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
  } catch {
    return null;
  }
}

/** What the reply is told to open an Item and its files with. */
export interface FindLinks {
  /** This Cockpit's own origin. */
  origin: string;
  /** The address that opens each attachment without a sign-in, by attachment id; empty where the environment seals none. */
  files: Readonly<Record<string, string>>;
}

/**
 * A page of Items told back as text: each Item's own words whole, where it is
 * ("Workspace ▸ Dashboard ▸ Panel" for each Panel it is filed on, or *Inbox*),
 * and a link that opens it in Cockpit - then, where more follow, a cursor.
 */
export function findItemsReply(
  page: FoundPage,
  workspaces: readonly Workspace[],
  links: FindLinks,
  named: Workspace | null = null,
): string {
  if (page.found.length === 0) return 'No item matches.';
  const lines = [`${page.found.length} ${page.found.length === 1 ? 'item' : 'items'}, most recently changed first.`];
  for (const [at, found] of page.found.entries()) {
    lines.push('', ...describeItem(at + 1, found, workspaces, links, named));
  }
  const last = page.found[page.found.length - 1]!.item;
  if (page.more) {
    lines.push(
      '',
      `More follow. Call find_items again with the same arguments and cursor ${JSON.stringify(cursorAfter(last))} for the next page. An item changed between two pages can be missed.`,
    );
  }
  return lines.join('\n');
}

function describeItem(
  number: number,
  { item, places, attachments }: FoundItem,
  workspaces: readonly Workspace[],
  links: FindLinks,
  named: Workspace | null,
): string[] {
  // An Item no workspace has been chosen for waits in every Inbox, so it is in none: it is not "in" the one it was captured from.
  const workspace = workspaceIsDecided(item) ? workspaces.find((w) => w.id === item.workspaceId) : undefined;
  const where =
    places.length > 0 && workspace
      ? places.map((place) => `${workspace.name} ▸ ${place}`).join('; ')
      : 'Inbox';
  // Where it opens: its own Workspace, or - for an Item in every Inbox - the Workspace the app asked about, else the first.
  const opensIn = workspace ?? named ?? workspaces[0];
  const link = itemLink(links.origin, opensIn?.id ?? item.workspaceId, item.id);
  const lines = [
    `${number}. ${item.title.trim() || UNTITLED}`,
    `   Status: ${STATUS_NAMES[itemStatus(item)]}`,
    `   Priority: ${item.priority ? PRIORITY_NAMES[item.priority] : 'none'}`,
    `   Due: ${item.dueDate ?? 'none'}`,
    `   Next action: ${item.nextAction?.trim() || 'none'}`,
    `   Sender: ${item.sender?.trim() || 'none'}`,
    `   Where: ${where}`,
    `   Last changed: ${item.updatedAt}`,
  ];
  if (attachments.length > 0) {
    lines.push(
      `   Files: ${attachments
        .map((file) => {
          const address = links.files[file.id];
          return address ? `${file.filename} (${address})` : file.filename;
        })
        .join('; ')}`,
    );
  }
  lines.push(`   Open: ${link}`);
  const description = item.description?.trim();
  if (description) lines.push('   Description:', ...description.split('\n').map((line) => `     ${line}`));
  return lines;
}
