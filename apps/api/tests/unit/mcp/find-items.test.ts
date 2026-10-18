import { describe, expect, it } from 'vitest';
import type { Workspace } from '@cockpit/shared';
import { encodeCursor } from '../../../src/accounts/find.js';
import { SERVER_INSTRUCTIONS } from '../../../src/mcp/create-item.js';
import {
  NO_ITEM_MATCHES,
  findItemsTool,
  formatFound,
  namesAPanel,
  readFind,
  tooManyFinds,
  type PanelInScope,
} from '../../../src/mcp/find-items.js';
import type { FoundItem, FoundPage } from '../../../src/accounts/find.js';

/**
 * L1: how an app's search is read against the account's own names, what the
 * tool tells the app, and how a page of results is worded ("Find items in
 * Cockpit from a connected app, over MCP", issue 1240). Which Items the store
 * answers with, the pages and the limits as they reach the app are
 * tests/integration/http/connected-apps.test.ts's.
 */

const workspace = (id: string, name: string): Workspace => ({
  id,
  tenantId: 'tenant-default',
  name,
  color: '#6f62b5',
  bar: '#594e91',
  ground: '#e2e2df',
  header: '#2d2e35',
});
const HOME = workspace('ws-home', 'Home');
const WORK = workspace('ws-work', 'Work');
const PANELS: PanelInScope[] = [
  { id: 'p-admin-home', name: 'Admin', workspaceId: HOME.id },
  { id: 'p-admin-work', name: 'admin', workspaceId: WORK.id },
  { id: 'p-calls', name: 'Calls', workspaceId: WORK.id },
];
const ACCOUNT = { workspaces: [HOME, WORK], panels: PANELS, utcToday: '2026-10-18' };

function queryOf(args: unknown, account = ACCOUNT) {
  const read = readFind(args, account);
  if (!read.ok) throw new Error(`refused: ${read.refusal}`);
  return read.query;
}

describe('MCP connections', () => {
  describe("an app's search is read against the account as it is", () => {
    it('reads a call with no criteria as every open item of the account, counted from the UTC day', () => {
      expect(queryOf(undefined)).toEqual({
        workspaceId: null,
        panelIds: null,
        text: '',
        filter: { statuses: [], priorities: [], due: null, text: '', attachments: 'any', agentRunning: false },
        includeDone: false,
        today: '2026-10-18',
        after: null,
      });
    });

    it.each([
      {
        situation: 'a workspace named in another case',
        args: { workspace: 'work' },
        read: { workspaceId: WORK.id },
      },
      { situation: 'a text, trimmed', args: { text: '  Invoice ' }, read: { text: 'Invoice' } },
      { situation: 'a priority', args: { priority: 'high' }, read: { filter: expect.objectContaining({ priorities: ['high'] }) } },
      { situation: 'no priority asked for by name', args: { priority: 'none' }, read: { filter: expect.objectContaining({ priorities: ['none'] }) } },
      { situation: 'a status', args: { status: 'in_progress' }, read: { filter: expect.objectContaining({ statuses: ['in_progress'] }) } },
      {
        situation: 'a due window, which also takes what is overdue as the filter bar does',
        args: { due: 'week' },
        read: { filter: expect.objectContaining({ due: { window: 'week', orOverdue: true } }) },
      },
      {
        situation: 'a due window without what is overdue',
        args: { due: 'week', or_overdue: false },
        read: { filter: expect.objectContaining({ due: { window: 'week', orOverdue: false } }) },
      },
      { situation: 'the finished items asked for', args: { include_done: true }, read: { includeDone: true } },
      {
        situation: 'the user’s own date, counted from instead of the UTC day',
        args: { due: 'today', today: '2026-10-19' },
        read: { today: '2026-10-19' },
      },
      {
        situation: 'the panels of a name, in every workspace and in any case',
        args: { panel: 'ADMIN' },
        read: { panelIds: ['p-admin-home', 'p-admin-work'] },
      },
      {
        situation: 'a panel of a name with the workspace that has it',
        args: { panel: 'admin', workspace: 'Work' },
        read: { workspaceId: WORK.id, panelIds: ['p-admin-work'] },
      },
      {
        situation: 'workspace, priority and text together',
        args: { workspace: 'Home', priority: 'high', text: 'dentist' },
        read: { workspaceId: HOME.id, text: 'dentist', filter: expect.objectContaining({ priorities: ['high'] }) },
      },
      { situation: 'empty arguments, read as not given', args: { workspace: '', text: '', panel: null }, read: { workspaceId: null, text: '', panelIds: null } },
    ])('reads $situation', ({ args, read }) => {
      expect(queryOf(args)).toMatchObject(read);
    });

    it.each([
      { situation: 'a workspace nobody has', args: { workspace: 'Garden' }, says: ['"Garden"', '"Home", "Work"'] },
      { situation: 'a workspace that is not a name at all', args: { workspace: 7 }, says: ['"Home", "Work"'] },
      { situation: 'a panel no panel has', args: { panel: 'Nowhere' }, says: ['"Nowhere"', '"Admin", "admin", "Calls"'] },
      { situation: 'a panel of another workspace than the one named', args: { panel: 'Calls', workspace: 'Home' }, says: ['"Admin"'] },
      { situation: 'a priority there is not', args: { priority: 'urgent' }, says: ['"high", "normal", "low", "none"'] },
      { situation: 'a status there is not', args: { status: 'finished' }, says: ['"to_do", "in_progress", "done"'] },
      { situation: 'a due window there is not', args: { due: 'fortnight' }, says: ['"overdue"', '"quarter"'] },
      { situation: 'an argument the tool does not have', args: { type: 'Task' }, says: ['type is not an argument of find_items'] },
      { situation: 'a today that is not a date', args: { today: 'tomorrow' }, says: ['today must be a date'] },
      { situation: 'a today that is not on the calendar', args: { today: '2026-02-30' }, says: ['today must be a date'] },
      { situation: 'a done status without the finished items', args: { status: 'done' }, says: ['include_done'] },
      { situation: 'include_done that is not true or false', args: { include_done: 'yes' }, says: ['include_done must be true or false'] },
      { situation: 'or_overdue without a due window', args: { or_overdue: true }, says: ['only applies together with due'] },
      { situation: 'a text that is not text', args: { text: 5 }, says: ['text must be'] },
      { situation: 'a text over the limit', args: { text: 'x'.repeat(501) }, says: ['500'] },
      { situation: 'a cursor Cockpit never gave', args: { cursor: 'not a cursor' }, says: ['cursor is not one Cockpit gave'] },
      { situation: 'a cursor that is only base64', args: { cursor: btoa('hello') }, says: ['cursor is not one Cockpit gave'] },
    ])('refuses $situation, saying what would do', ({ args, says }) => {
      const read = readFind(args, ACCOUNT);
      expect(read.ok).toBe(false);
      for (const words of says) expect(read.ok ? '' : read.refusal).toContain(words);
    });

    it('refuses a workspace where there are none, and says to leave it out', () => {
      const read = readFind({ workspace: 'Home' }, { workspaces: [], panels: [], utcToday: '2026-10-18' });
      expect(read).toEqual({ ok: false, refusal: expect.stringContaining('no workspaces yet') });
    });

    it('takes the cursor a reply ended with', () => {
      const cursor = encodeCursor({ updatedAt: '2026-10-17T09:00:00.000Z', id: 'item-9' });
      expect(queryOf({ cursor }).after).toEqual({ updatedAt: '2026-10-17T09:00:00.000Z', id: 'item-9' });
    });
  });

  describe('an app asking too often is told how long to wait', () => {
    it('says to wait a minute for the minute, and that the day is any 24 hours - never tomorrow - for the day', () => {
      expect(tooManyFinds('too-many-a-minute')).toContain('Wait a minute');
      const day = tooManyFinds('too-many-today');
      expect(day).toContain('500 calls in any 24 hours');
      expect(day).toContain('Try again later');
      expect(day).not.toMatch(/tomorrow|a day\b/i);
    });
  });

  describe('the account’s panels are read only for a call that names one', () => {
    it.each([
      { situation: 'no arguments', args: undefined, names: false },
      { situation: 'a text alone', args: { text: 'dentist' }, names: false },
      { situation: 'an empty panel, read as not given', args: { panel: '' }, names: false },
      { situation: 'a null panel, read as not given', args: { panel: null }, names: false },
      { situation: 'a panel', args: { panel: 'Calls' }, names: true },
      { situation: 'a panel that is no name at all, which is refused once read', args: { panel: 7 }, names: true },
    ])('a call with $situation', ({ args, names }) => {
      expect(namesAPanel(args)).toBe(names);
    });

    it('reads a search that names no panel without any panels to read it against', () => {
      expect(readFind({ workspace: 'Work', text: 'x' }, { workspaces: [HOME, WORK], panels: [], utcToday: '2026-10-18' })).toMatchObject({
        ok: true,
      });
    });
  });

  describe('an app is told it can find items, and when', () => {
    it('lists find_items beside the others, naming each workspace in the description and as the only values allowed', () => {
      const tool = findItemsTool([HOME, WORK]);
      expect(tool.name).toBe('find_items');
      expect(tool.inputSchema.required).toEqual([]);
      expect(tool.inputSchema.properties.workspace!.enum).toEqual(['Home', 'Work']);
      expect(tool.description).toContain('"Home", "Work"');
    });

    it('offers no list of workspaces to choose from where there are none, rather than an empty one', () => {
      const tool = findItemsTool([]);
      expect(tool.inputSchema.properties.workspace).not.toHaveProperty('enum');
      expect(tool.description).toContain('Workspaces: none yet');
    });

    it('says it reads and changes nothing, asks for the user’s date, and owns up to a page edge missing a changed item', () => {
      const { description } = findItemsTool([HOME]);
      expect(description).toContain('Read-only');
      expect(description).toContain("Pass today as the user's local date");
      expect(description).toContain('25 at a time');
      expect(description).toContain('An item changed between two pages can be missed.');
    });

    it('says in the server instructions to use it when asked what is in Cockpit, or before capturing what may be there', () => {
      expect(SERVER_INSTRUCTIONS).toContain('Use find_items when the user asks what is in Cockpit');
      expect(SERVER_INSTRUCTIONS).toContain('before capturing something that may already be there');
      expect(SERVER_INSTRUCTIONS).toContain('Use create_item when');
    });
  });

  describe('each result says what the item is and where it is', () => {
    const ORIGIN = 'https://cockpit.test';
    const anItem = (fields: Partial<FoundItem> = {}): FoundItem => ({
      id: 'item-1',
      workspaceId: 'ws-work',
      workspaceName: 'Work',
      title: 'Send the quote',
      description: null,
      nextAction: null,
      status: 'to_do',
      priority: null,
      dueDate: null,
      sender: null,
      places: [],
      updatedAt: '2026-10-17T09:00:00.000Z',
      attachments: [],
      ...fields,
    });
    const pageOf = (items: FoundItem[], next: FoundPage['next'] = null): FoundPage => ({ items, next });

    it('says no item matches, not an error, for a page of none', () => {
      expect(formatFound(pageOf([]), ORIGIN, new Map())).toBe(NO_ITEM_MATCHES);
    });

    it('names an item filed on two panels by each, with its workspace', () => {
      const said = formatFound(
        pageOf([anItem({ places: ['Day to day ▸ Admin', 'Projects ▸ Calls'] })]),
        ORIGIN,
        new Map(),
      );
      expect(said).toContain('Where: Work ▸ Day to day ▸ Admin; Work ▸ Projects ▸ Calls');
    });

    it('says Inbox for an item never filed', () => {
      expect(formatFound(pageOf([anItem()]), ORIGIN, new Map())).toContain('Where: Inbox');
    });

    it('keeps a long description whole, line breaks included', () => {
      const description = `${'A long line. '.repeat(400)}\nSecond paragraph\nEnd`;
      const said = formatFound(pageOf([anItem({ description })]), ORIGIN, new Map());
      expect(said).toContain('A long line. '.repeat(400).trimEnd());
      expect(said).toContain('   Second paragraph\n   End');
    });

    it('carries the title, next action, status, priority, due date, sender, when it last changed and a link that opens it', () => {
      const said = formatFound(
        pageOf([
          anItem({
            nextAction: 'Ring Sam',
            status: 'in_progress',
            priority: 'high',
            dueDate: '2026-10-20',
            sender: 'Claude',
          }),
        ]),
        ORIGIN,
        new Map(),
      );
      expect(said).toContain('1. Send the quote (In progress, High priority, due 2026-10-20)');
      expect(said).toContain('Next action: Ring Sam');
      expect(said).toContain('Sender: Claude');
      expect(said).toContain('Last changed: 2026-10-17T09:00:00.000Z');
      expect(said).toContain('Open in Cockpit: https://cockpit.test/w/ws-work?item=item-1');
    });

    it('marks a finished item Done, and says it has no priority or due date', () => {
      expect(formatFound(pageOf([anItem({ status: 'done' })]), ORIGIN, new Map())).toContain(
        '(Done, no priority, no due date)',
      );
    });

    it.each([
      { situation: 'with a link', links: new Map([['att-1', 'https://cockpit.test/v1/attachment-links/abc']]), says: 'invoice.pdf (https://cockpit.test/v1/attachment-links/abc)' },
      { situation: 'with no sealing key, by name alone', links: new Map<string, string>(), says: 'Attachments: invoice.pdf' },
    ])('lists an attachment $situation', ({ links, says }) => {
      const said = formatFound(pageOf([anItem({ attachments: [{ id: 'att-1', filename: 'invoice.pdf' }] })]), ORIGIN, links);
      expect(said).toContain(says);
      if (links.size === 0) {
        expect(said.split('\n').find((line) => line.includes('Attachments:'))).toBe('   Attachments: invoice.pdf');
      }
    });

    it('lists no attachments for an item with none', () => {
      expect(formatFound(pageOf([anItem()]), ORIGIN, new Map())).not.toContain('Attachments');
    });

    it('ends a page with more to come by saying so, with the cursor that fetches the next, and gives no total', () => {
      const next = { updatedAt: '2026-10-17T09:00:00.000Z', id: 'item-1' };
      const said = formatFound(pageOf([anItem()], next), ORIGIN, new Map());
      expect(said).toContain(`cursor "${encodeCursor(next)}"`);
      expect(said).toContain('More items follow');
      expect(said).not.toMatch(/\bof \d+\b|total/i);
      expect(formatFound(pageOf([anItem()]), ORIGIN, new Map())).not.toContain('More items follow');
    });
  });
});
