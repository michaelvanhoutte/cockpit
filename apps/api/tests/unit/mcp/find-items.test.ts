import { describe, expect, it } from 'vitest';
import type { Item, Workspace } from '@cockpit/shared';
import { pageOf } from '../../../src/accounts/find-items.js';
import { SERVER_INSTRUCTIONS } from '../../../src/mcp/create-item.js';
import {
  cursorAfter,
  findItemsReply,
  findItemsTool,
  readCursor,
  readFind,
  resolvePanels,
} from '../../../src/mcp/find-items.js';

/**
 * L1: how an app's search is read against the account's own names, how a page
 * is cut and continued, and how a page is told back ("Find items in Cockpit
 * from a connected app, over MCP", issue 1240). That it answers from the
 * account's real Items, across workspaces and Panels, and is held to its
 * limits, is tests/integration/http/find-items.test.ts's.
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

/** Near midnight UTC, so the UTC day and a user's local day can differ. */
const NOW = new Date('2026-10-19T23:30:00.000Z');

const anItem = (over: Partial<Item> = {}): Item =>
  ({
    id: '018f0000-0000-7000-9000-000000000001',
    workspaceId: HOME.id,
    workspaceDecided: true,
    title: 'Ring the plumber',
    description: null,
    nextAction: null,
    sender: null,
    priority: null,
    dueDate: null,
    startedAt: null,
    completedAt: null,
    updatedAt: '2026-10-19T10:00:00.000Z',
    ...over,
  }) as Item;

const asked = (args: unknown, workspaces = [HOME, WORK]) => {
  const read = readFind(args, workspaces, NOW);
  if (!read.ok) throw new Error(read.refusal);
  return read;
};
const refusal = (args: unknown, workspaces = [HOME, WORK]) => {
  const read = readFind(args, workspaces, NOW);
  return read.ok ? null : read.refusal;
};

describe('MCP connections', () => {
  describe('every criterion an app gives narrows what it finds, read against the account as it is', () => {
    it('asks for every open Item in the whole account when it gives nothing', () => {
      expect(asked({}).ask).toEqual({
        text: '',
        workspaceId: null,
        statuses: [],
        priorities: [],
        due: null,
        includeDone: false,
        today: '2026-10-19',
        after: null,
      });
      expect(asked(undefined).ask.workspaceId).toBeNull();
    });

    it.each([
      { situation: 'a workspace named in another case', args: { workspace: 'work' }, ask: { workspaceId: WORK.id } },
      { situation: 'a priority', args: { priority: 'High' }, ask: { priorities: ['high'] } },
      { situation: 'a priority in another case', args: { priority: 'low' }, ask: { priorities: ['low'] } },
      { situation: 'a status', args: { status: 'In progress' }, ask: { statuses: ['in_progress'], includeDone: false } },
      { situation: 'the status Waiting for reply, an open one', args: { status: 'Waiting for reply' }, ask: { statuses: ['waiting'], includeDone: false } },
      { situation: 'the status Done, which can only be answered from finished Items', args: { status: 'Done' }, ask: { statuses: ['done'], includeDone: true } },
      { situation: 'words', args: { text: '  plumber ' }, ask: { text: '  plumber ' } },
      { situation: 'finished Items asked for', args: { include_done: true }, ask: { includeDone: true } },
      {
        situation: 'a due window, which widens to overdue as the filter bar does',
        args: { due: 'This week' },
        ask: { due: { window: 'week', orOverdue: true } },
      },
      {
        situation: 'a due window without overdue',
        args: { due: 'This week', or_overdue: false },
        ask: { due: { window: 'week', orOverdue: false } },
      },
      { situation: 'overdue itself, which is no period to widen', args: { due: 'Overdue' }, ask: { due: { window: 'overdue', orOverdue: false } } },
      { situation: 'no due date', args: { due: 'Not set' }, ask: { due: { window: 'none', orOverdue: false } } },
    ])('reads $situation', ({ args, ask }) => {
      expect(asked(args).ask).toMatchObject(ask);
    });

    it('counts due conditions from the day the app says is today', () => {
      expect(asked({ due: 'Today', today: '2026-10-20' }).ask.today).toBe('2026-10-20');
    });

    it('counts due conditions from the UTC day when the app says none', () => {
      expect(asked({ due: 'Today' }).ask.today).toBe('2026-10-19');
    });

    it('keeps the Panel it names, for the account to look for', () => {
      expect(asked({ panel: 'Calls' }).panel).toBe('Calls');
      expect(asked({}).panel).toBeNull();
    });

    it('combines workspace, priority and text', () => {
      expect(asked({ workspace: 'Home', priority: 'High', text: 'boiler' }).ask).toMatchObject({
        workspaceId: HOME.id,
        priorities: ['high'],
        text: 'boiler',
      });
    });
  });

  describe('a name or value the account does not have is refused with the ones there are, and nothing is ignored in silence', () => {
    it.each([
      { situation: 'a workspace nobody has', args: { workspace: 'Garden' }, says: ['"Garden"', '"Home", "Work"'] },
      { situation: 'a workspace that is not a name', args: { workspace: 7 }, says: ['"Home", "Work"'] },
      { situation: 'a priority there is not', args: { priority: 'Urgent' }, says: ['priority', '"High", "Normal", "Low"'] },
      { situation: 'a status there is not', args: { status: 'Blocked' }, says: ['status', '"To do", "In progress", "Waiting for reply", "Done"'] },
      { situation: 'a due window there is not', args: { due: 'Next year' }, says: ['due', '"This week"'] },
      { situation: 'an argument the tool does not have', args: { sort: 'title' }, says: ['sort is not an argument of find_items'] },
      { situation: 'today that is not a date', args: { today: 'tomorrow' }, says: ['today must be a date'] },
      { situation: 'today that is no day of the calendar', args: { today: '2026-02-30' }, says: ['today must be a date'] },
      { situation: 'or_overdue with no due window to widen', args: { or_overdue: true }, says: ['or_overdue only goes with due Today, This week'] },
      { situation: 'or_overdue false with no due window', args: { or_overdue: false }, says: ['or_overdue only goes with due'] },
      { situation: 'or_overdue with due Overdue, which is no period', args: { due: 'Overdue', or_overdue: true }, says: ['or_overdue only goes with due'] },
      { situation: 'or_overdue with due Not set', args: { due: 'Not set', or_overdue: false }, says: ['or_overdue only goes with due'] },
      { situation: 'include_done that is not true or false', args: { include_done: 'yes' }, says: ['include_done must be true or false'] },
      { situation: 'text that is not words', args: { text: 12 }, says: ['text must be words'] },
      { situation: 'a panel that is not a name', args: { panel: 3 }, says: ['panel must be the name of a Panel'] },
    ])('refuses $situation', ({ args, says }) => {
      const said = refusal(args);
      expect(said).not.toBeNull();
      for (const words of says) expect(said).toContain(words);
    });

    it('says to leave workspace out where there are no workspaces', () => {
      expect(refusal({ workspace: 'Home' }, [])).toContain('no workspaces yet');
    });

    it('refuses a Panel nobody has, listing the Panels there are', () => {
      const panels = [
        { id: 'p1', name: 'Calls', workspaceId: HOME.id, dashboardName: 'Day' },
        { id: 'p2', name: 'Admin', workspaceId: HOME.id, dashboardName: 'Day' },
        { id: 'p3', name: 'Calls', workspaceId: WORK.id, dashboardName: 'Sales' },
      ];
      const said = resolvePanels('Garden', panels);
      expect(said).toEqual({ ok: false, refusal: expect.stringContaining('"Calls", "Admin"') });
      expect(said.ok ? '' : said.refusal).toContain('"Garden"');
    });

    it('finds the Panels of that name on every Dashboard, ignoring case', () => {
      const panels = [
        { id: 'p1', name: 'Calls', workspaceId: HOME.id, dashboardName: 'Day' },
        { id: 'p3', name: 'Calls', workspaceId: WORK.id, dashboardName: 'Sales' },
        { id: 'p2', name: 'Admin', workspaceId: HOME.id, dashboardName: 'Day' },
      ];
      expect(resolvePanels(' calls ', panels)).toEqual({ ok: true, panelIds: ['p1', 'p3'] });
    });
  });

  describe('a page of 25 continues by a cursor that repeats and skips nothing', () => {
    const at = (id: string, updatedAt: string) => ({ id, updatedAt });

    it('cuts the page at 25 and says more follow', () => {
      const items = Array.from({ length: 26 }, (_, n) => at(`id-${String(100 - n)}`, `2026-10-19T10:00:${String(59 - n).padStart(2, '0')}.000Z`));
      const first = pageOf(items, null);
      expect([first.page.length, first.more]).toEqual([25, true]);
      const next = pageOf(items, readCursor(cursorAfter(first.page[24]!)));
      expect([next.page.map((item) => item.id), next.more]).toEqual([['id-75'], false]);
    });

    it('returns each of two Items changed at the same moment once, the id breaking the tie across the page edge', () => {
      const moment = '2026-10-19T10:00:00.000Z';
      const items = [at('c', '2026-10-19T11:00:00.000Z'), at('b', moment), at('a', moment), at('older', '2026-10-18T10:00:00.000Z')];
      const first = pageOf(items, null, 2);
      const second = pageOf(items, readCursor(cursorAfter(first.page[1]!)), 2);
      expect([...first.page, ...second.page].map((item) => item.id)).toEqual(['c', 'b', 'a', 'older']);
      expect([first.more, second.more]).toEqual([true, false]);
    });

    it('reads back the change time and id a cursor was made from', () => {
      expect(readCursor(cursorAfter(anItem({ id: 'item-9', updatedAt: '2026-10-19T10:00:00.123Z' })))).toEqual({
        changedAt: '2026-10-19T10:00:00.123Z',
        id: 'item-9',
      });
    });

    it.each([
      { situation: 'text that is no cursor at all', cursor: 'next page please' },
      { situation: 'a cursor with no id', cursor: btoa('2026-10-19T10:00:00.000Z') },
      { situation: 'a cursor with no date', cursor: btoa('yesterday|item-9') },
      { situation: 'a cursor with a date that is no time', cursor: btoa('2026-13-45T99:99:99.000Z|item-9') },
      { situation: 'a number', cursor: 7 },
    ])('refuses $situation, saying to start from the first page', ({ cursor }) => {
      expect(refusal({ cursor })).toContain('cursor is not one Cockpit gave');
    });

    it('takes a cursor it gave', () => {
      const cursor = cursorAfter(anItem());
      expect(asked({ cursor }).ask.after).toEqual({ changedAt: '2026-10-19T10:00:00.000Z', id: anItem().id });
    });
  });

  describe('each result says what the Item is and where it is', () => {
    const links = { origin: 'https://cockpit.test', files: {} as Record<string, string> };
    const page = (...found: Parameters<typeof findItemsReply>[0]['found']) => ({ found, more: false });
    const told = (item: Item, places: string[] = [], attachments: Parameters<typeof findItemsReply>[0]['found'][number]['attachments'] = [], withLinks = links) =>
      findItemsReply(page({ item, places, attachments }), [HOME, WORK], withLinks);

    it('says No item matches, rather than an error, where nothing does', () => {
      expect(findItemsReply({ found: [], more: false }, [HOME], links)).toBe('No item matches.');
    });

    it('names every field an Item has, and the link that opens it', () => {
      const text = told(
        anItem({
          title: 'Ring the plumber',
          nextAction: 'Call before 5',
          sender: 'Claude',
          priority: 'high',
          dueDate: '2026-10-22',
          startedAt: '2026-10-18T09:00:00.000Z',
        }),
      );
      for (const words of [
        'Ring the plumber',
        'Status: In progress',
        'Priority: High',
        'Due: 2026-10-22',
        'Next action: Call before 5',
        'Sender: Claude',
        'Last changed: 2026-10-19T10:00:00.000Z',
        `Open: https://cockpit.test/w/ws-home?item=${anItem().id}`,
      ]) {
        expect(text).toContain(words);
      }
    });

    it('says none for what an Item has no value for', () => {
      const text = told(anItem());
      for (const words of ['Priority: none', 'Due: none', 'Next action: none', 'Sender: none', 'Status: To do']) {
        expect(text).toContain(words);
      }
    });

    it.each([
      { situation: 'filed on two Panels', places: ['Day ▸ Calls', 'Sales ▸ Leads'], where: 'Home ▸ Day ▸ Calls; Home ▸ Sales ▸ Leads' },
      { situation: 'never filed', places: [], where: 'Inbox' },
    ])('says where an Item $situation is: $where', ({ places, where }) => {
      expect(told(anItem(), places)).toContain(`Where: ${where}`);
    });

    it('says where a finished Item was filed, as All items does, and that it is done', () => {
      const text = told(anItem({ completedAt: '2026-10-19T12:00:00.000Z' }), ['Day ▸ Calls']);
      expect(text).toContain('Status: Done');
      expect(text).toContain('Where: Home ▸ Day ▸ Calls');
    });

    it('says an Item waiting in every Inbox is in the Inbox, whichever workspace it was captured from', () => {
      expect(told(anItem({ workspaceDecided: false }), [])).toContain('Where: Inbox');
    });

    it.each([
      { situation: 'asking about a workspace', named: WORK, opens: 'ws-work' },
      { situation: 'asking about none, so the first workspace', named: null, opens: 'ws-home' },
    ])('opens an Item waiting in every Inbox in the workspace it is found under, $situation', ({ named, opens }) => {
      const waiting = anItem({ workspaceDecided: false, workspaceId: 'ws-captured-from-elsewhere' });
      const text = findItemsReply(page({ item: waiting, places: [], attachments: [] }), [HOME, WORK], links, named);
      expect(text).toContain(`Open: https://cockpit.test/w/${opens}?item=${waiting.id}`);
    });

    it('opens an Item of a workspace that is no longer there in the first workspace, rather than a dead address', () => {
      const orphan = anItem({ workspaceId: 'ws-deleted' });
      const text = findItemsReply(page({ item: orphan, places: [], attachments: [] }), [HOME, WORK], links);
      expect(text).toContain(`Open: https://cockpit.test/w/ws-home?item=${orphan.id}`);
    });

    it('gives a long description whole, line by line', () => {
      const description = `${'A long paragraph. '.repeat(200)}\nSecond line`;
      const text = told(anItem({ description }));
      expect(text).toContain('A long paragraph. '.repeat(200).trim());
      expect(text).toContain('     Second line');
    });

    it('names each file, with its link where there is one and its name alone where there is not', () => {
      const files = [
        { id: 'f1', filename: 'invoice.pdf', contentType: 'application/pdf', size: 10 },
        { id: 'f2', filename: 'notes.txt', contentType: 'text/plain', size: 5 },
      ];
      expect(told(anItem(), [], files, { origin: links.origin, files: { f1: 'https://cockpit.test/v1/attachment-links/abc' } })).toContain(
        'Files: invoice.pdf (https://cockpit.test/v1/attachment-links/abc); notes.txt',
      );
      expect(told(anItem(), [], files, { origin: links.origin, files: {} })).toContain('Files: invoice.pdf; notes.txt');
    });

    it('lists no files for an Item with none', () => {
      expect(told(anItem())).not.toContain('Files:');
    });

    it('ends a page with more to come on a cursor that fetches the next, and says an Item changed between pages can be missed', () => {
      const first = anItem({ id: 'a', updatedAt: '2026-10-19T10:00:00.000Z' });
      const second = anItem({ id: 'b', updatedAt: '2026-10-19T09:00:00.000Z' });
      const text = findItemsReply(
        { found: [first, second].map((item) => ({ item, places: [], attachments: [] })), more: true },
        [HOME],
        links,
      );
      expect(text).toContain('More follow');
      expect(text).toContain(JSON.stringify(cursorAfter(second)));
      expect(text).toContain('can be missed');
    });

    it('gives no cursor on the last page', () => {
      expect(told(anItem())).not.toContain('More follow');
    });
  });

  describe('an app is told what it can do', () => {
    it('lists find_items naming the account’s workspaces, in the description and as the only values allowed', () => {
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

    it('says it only reads, asks for the user’s local date and warns an Item changed between pages can be missed', () => {
      const { description } = findItemsTool([HOME]);
      expect(description).toContain('only reads');
      expect(description).toContain('local date');
      expect(description).toContain('can be missed');
    });

    it('is named in the server’s instructions, with when to use it', () => {
      expect(SERVER_INSTRUCTIONS).toContain('Use find_items when the user asks what is in Cockpit, or before capturing something that may already be there.');
      expect(SERVER_INSTRUCTIONS).toContain('Use create_item when the user asks to capture');
    });
  });
});
