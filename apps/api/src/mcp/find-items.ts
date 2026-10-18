import {
  DUE_WINDOWS,
  ITEM_STATUSES,
  NO_DASHBOARD_FILTER,
  type DashboardFilter,
  type DueWindow,
  type ItemStatus,
  type PriorityChoice,
  type Workspace,
} from '@cockpit/shared';
import { FIND_PAGE, encodeCursor, readCursor, type FindQuery, type FoundItem, type FoundPage } from '../accounts/find.js';
import { foldName, namedTheSame } from '../domain/names.js';
import type { ToolDefinition } from './create-item.js';

/**
 * The tool an app connected to Cockpit reads Items with ("Find items in
 * Cockpit from a connected app, over MCP", issue 1240): what it is called, what
 * it says it does, how its arguments are read against the account it asks of,
 * and how a page of results is worded.
 *
 * Pure, and proved at L1 (tests/unit/mcp/find-items.test.ts). The rows come
 * from the account's store and the limits are counted there (`mcp/server.ts`),
 * proved at L2 through `/mcp`.
 */

export const FIND_ITEMS = 'find_items';

const PRIORITY_CHOICES = ['high', 'normal', 'low', 'none'] as const satisfies readonly PriorityChoice[];
const TEXT_LIMIT = 500;

/** The Panels an account can be asked about, each with the Workspace it is in. */
export interface PanelInScope {
  id: string;
  name: string;
  workspaceId: string;
}

/** The tool, naming this account's workspaces as they are now - in the description and as an `enum`, for the reason `create_item` does. */
export function findItemsTool(workspaces: readonly Workspace[]): ToolDefinition {
  const workspaceNames = workspaces.map((w) => w.name);
  const named = workspaceNames.length ? workspaceNames.map((n) => `"${n}"`).join(', ') : 'none yet';
  return {
    name: FIND_ITEMS,
    description: [
      "Find items in the user's Cockpit. Read-only: it changes nothing.",
      'Use it when the user asks what is in Cockpit, what is on their plate, or whether something is already captured.',
      `Every criterion is optional and they combine with AND; with none, it lists every open item. Workspaces: ${named}; the search covers the whole account unless one is named.`,
      'text matches, ignoring case, in the title, description, next action or sender (not by meaning).',
      'panel is the name of a panel or filter panel, and finds the items filed on it or gathered by it.',
      'Open items are listed unless include_done is true; dismissed items never are.',
      "Pass today as the user's local date (YYYY-MM-DD): due windows, and filter panels, count from it, and from the UTC day without it.",
      `Results come ${FIND_PAGE} at a time, most recently changed first, each with its whole description. When more follow, the reply ends with a cursor: call again with the same arguments and that cursor.`,
      'An item changed between two pages can be missed.',
      'Attachments are listed by name with a link that opens the file for an hour.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', maxLength: TEXT_LIMIT, description: 'Words to find in the title, description, next action or sender.' },
        workspace: {
          type: 'string',
          ...(workspaceNames.length ? { enum: workspaceNames } : {}),
          description: 'Only items of this workspace, by name.',
        },
        panel: { type: 'string', description: 'Only items filed on or gathered by a panel of this name.' },
        status: { type: 'string', enum: [...ITEM_STATUSES], description: 'Only items with this status. "done" needs include_done.' },
        priority: { type: 'string', enum: [...PRIORITY_CHOICES], description: 'Only items with this priority; "none" is items with no priority.' },
        due: {
          type: 'string',
          enum: [...DUE_WINDOWS],
          description: 'Only items whose due date falls in this window, counted from today. "none" is items with no due date.',
        },
        or_overdue: {
          type: 'boolean',
          description: 'With a due window of today, week, month or quarter: also items overdue. Defaults to true, as the filter bar does.',
        },
        include_done: { type: 'boolean', description: 'Also list finished items.' },
        today: { type: 'string', description: "The user's local date, YYYY-MM-DD. Defaults to the UTC day." },
        cursor: { type: 'string', description: 'The cursor a previous reply ended with, for the next page of the same search.' },
      },
      required: [],
      additionalProperties: false,
    },
  };
}

/** What a call's arguments come to: a search to run, or what to tell the model. */
export type ReadFind = { ok: true; query: FindQuery } | { ok: false; refusal: string };

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

/** Whether a string is a real calendar day, `YYYY-MM-DD`. */
function isADay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

const names = (rows: readonly { name: string }[]) => [...new Set(rows.map((row) => `"${row.name}"`))].join(', ');
const options = (values: readonly string[]) => values.map((v) => `"${v}"`).join(', ');

/**
 * Reads a call's arguments against the account as it is at the moment of the
 * call, refusing in words the model can act on. Nothing is searched that was
 * not checked here.
 *
 * - **An argument the tool does not have is refused, naming it**; one ignored in
 *   silence would let a caller believe it had been honoured.
 * - **A workspace or panel name is matched as the account compares names**
 *   (`namedTheSame`), and one that matches nothing is refused with the names
 *   there are. A panel is looked for in the workspace named, or in all.
 * - **Two panels of one name, on different Dashboards, are both asked about.**
 * - **`today` is the app's, or the UTC day** the call arrived on.
 */
export function readFind(
  args: unknown,
  account: { workspaces: readonly Workspace[]; panels: readonly PanelInScope[]; utcToday: string },
): ReadFind {
  const given = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>;
  const refuse = (refusal: string): ReadFind => ({ ok: false, refusal });

  const unknown = Object.keys(given).find((name) => !(ARGUMENTS as readonly string[]).includes(name));
  if (unknown !== undefined) return refuse(`${unknown} is not an argument of find_items; leave it out.`);
  // An argument present but empty or null is read as not given, as `create_item` reads `workspace`.
  const set = (name: string) => given[name] !== undefined && given[name] !== null && given[name] !== '';

  let text = '';
  if (set('text')) {
    if (typeof given.text !== 'string' || given.text.length > TEXT_LIMIT) {
      return refuse(`text must be at most ${TEXT_LIMIT} characters of text.`);
    }
    text = given.text.trim();
  }

  let workspaceId: string | null = null;
  if (set('workspace')) {
    const workspace = typeof given.workspace === 'string' ? namedTheSame(account.workspaces, given.workspace) : undefined;
    if (!workspace) {
      return refuse(
        account.workspaces.length
          ? `No workspace is called ${JSON.stringify(given.workspace)}. The workspaces are ${names(account.workspaces)}; or leave workspace out.`
          : 'There are no workspaces yet; leave workspace out.',
      );
    }
    workspaceId = workspace.id;
  }

  let panelIds: string[] | null = null;
  if (set('panel')) {
    const inScope = account.panels.filter((panel) => workspaceId === null || panel.workspaceId === workspaceId);
    const folded = typeof given.panel === 'string' ? foldName(given.panel) : null;
    const matching = inScope.filter((panel) => foldName(panel.name) === folded);
    if (matching.length === 0) {
      return refuse(
        inScope.length
          ? `No panel is called ${JSON.stringify(given.panel)}. The panels are ${names(inScope)}; or leave panel out.`
          : 'There are no panels to ask about; leave panel out.',
      );
    }
    panelIds = matching.map((panel) => panel.id);
  }

  const filter: DashboardFilter = { ...NO_DASHBOARD_FILTER };
  if (set('status')) {
    const status = ITEM_STATUSES.find((one) => one === given.status);
    if (!status) return refuse(`status must be one of ${options(ITEM_STATUSES)}.`);
    filter.statuses = [status as ItemStatus];
  }
  if (set('priority')) {
    const priority = PRIORITY_CHOICES.find((one) => one === given.priority);
    if (!priority) return refuse(`priority must be one of ${options(PRIORITY_CHOICES)}.`);
    filter.priorities = [priority];
  }
  if (set('or_overdue') && !set('due')) return refuse('or_overdue only applies together with due; leave it out.');
  if (set('due')) {
    const window = DUE_WINDOWS.find((one) => one === given.due);
    if (!window) return refuse(`due must be one of ${options(DUE_WINDOWS)}.`);
    if (set('or_overdue') && typeof given.or_overdue !== 'boolean') return refuse('or_overdue must be true or false.');
    filter.due = { window: window as DueWindow, orOverdue: given.or_overdue !== false };
  }

  if (set('include_done') && typeof given.include_done !== 'boolean') return refuse('include_done must be true or false.');
  const includeDone = given.include_done === true;
  if (filter.statuses.includes('done') && !includeDone) {
    return refuse('status "done" lists finished items, which need include_done set to true.');
  }

  let today = account.utcToday;
  if (set('today')) {
    if (typeof given.today !== 'string' || !isADay(given.today)) return refuse('today must be a date, written YYYY-MM-DD.');
    today = given.today;
  }

  let after = null;
  if (set('cursor')) {
    after = readCursor(given.cursor);
    if (!after) return refuse('cursor is not one Cockpit gave. Leave it out to start from the first page, or pass the cursor a reply ended with.');
  }

  return { ok: true, query: { workspaceId, panelIds, text, filter, includeDone, today, after } };
}

const STATUS_NAMES: Record<ItemStatus, string> = { to_do: 'To do', in_progress: 'In progress', done: 'Done' };
const PRIORITY_NAMES = { high: 'High', normal: 'Normal', low: 'Low' } as const;

/** What a reply says for no match. A search that finds nothing is an answer, not an error. */
export const NO_ITEM_MATCHES = 'No item matches.';

/** The address that opens an Item in Cockpit, as `create_item` gives one. */
export function itemLink(origin: string, item: Pick<FoundItem, 'id' | 'workspaceId'>): string {
  const link = new URL(`/w/${encodeURIComponent(item.workspaceId)}`, origin);
  link.searchParams.set('item', item.id);
  return link.href;
}

/** Where an Item is: "Workspace ▸ Dashboard ▸ Panel" for each Panel it is filed on, or *Inbox* for one never filed. */
export function whereFound(item: Pick<FoundItem, 'places' | 'workspaceName'>): string {
  return item.places.length > 0 ? item.places.map((place) => `${item.workspaceName} ▸ ${place}`).join('; ') : 'Inbox';
}

function one(item: FoundItem, at: number, origin: string, links: ReadonlyMap<string, string>): string {
  const facts = [
    STATUS_NAMES[item.status],
    item.priority ? `${PRIORITY_NAMES[item.priority]} priority` : 'no priority',
    item.dueDate ? `due ${item.dueDate}` : 'no due date',
  ].join(', ');
  const lines = [
    `${at}. ${item.title || 'Untitled'} (${facts})`,
    `   Workspace: ${item.workspaceName}`,
    `   Where: ${whereFound(item)}`,
    ...(item.nextAction ? [`   Next action: ${item.nextAction}`] : []),
    ...(item.sender ? [`   Sender: ${item.sender}`] : []),
    `   Last changed: ${item.updatedAt}`,
    ...(item.attachments.length
      ? [
          `   Attachments: ${item.attachments
            .map(({ id, filename }) => (links.has(id) ? `${filename} (${links.get(id)})` : filename))
            .join(', ')}`,
        ]
      : []),
    `   Open in Cockpit: ${itemLink(origin, item)}`,
    ...(item.description ? ['   Description:', ...item.description.split(/\r?\n/).map((line) => `   ${line}`)] : []),
  ];
  return lines.join('\n');
}

/**
 * A page of results as the model reads it: each Item whole - its description
 * uncut - and, where more follow, a closing line with the cursor that fetches
 * them. **No total is given**, which would read every row in scope.
 *
 * `links` holds a sealed link for each attachment that has one; an attachment
 * without is named alone, as in an environment with no sealing key.
 */
export function formatFound(page: FoundPage, origin: string, links: ReadonlyMap<string, string>): string {
  if (page.items.length === 0) return NO_ITEM_MATCHES;
  const blocks = page.items.map((item, at) => one(item, at + 1, origin, links));
  const head = `${page.items.length} ${page.items.length === 1 ? 'item' : 'items'}, most recently changed first.`;
  const tail = page.next
    ? [`More items follow. To see them, call find_items again with the same arguments and cursor "${encodeCursor(page.next)}".`]
    : [];
  return [head, ...blocks, ...tail].join('\n\n');
}
