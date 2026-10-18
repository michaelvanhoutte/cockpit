import { describe, expect, it } from 'vitest';
import type { Item, Workspace } from '@cockpit/shared';
import { SERVER_INSTRUCTIONS } from '../../../src/mcp/create-item.js';
import { cursorFromText, cursorToText, findItemsTool, formatFound, readFind } from '../../../src/mcp/find-items.js';

/**
 * L1: how an app's search is read against the account's own names, what the
 * tool tells the app, and how what it found is told back. That the rows are the
 * account's own, paged and reachable, and how often an app may ask, are
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
const NOW = new Date('2026-10-14T23:30:00.000Z');
const ID = '0198f6a0-0000-7000-8000-000000000001';

describe('MCP connections', () => {
  describe("an app's search is read against the workspaces as they are", () => {
    it('reads no arguments as every open item in every workspace, counted from the UTC day', () => {
      expect(readFind(undefined, [HOME, WORK], NOW)).toEqual({
        ok: true,
        query: {
          workspaceId: null,
          text: '',
          status: null,
          priority: null,
          due: null,
          includeDone: false,
          today: '2026-10-14',
          after: null,
        },
      });
    });

    it('reads every condition it is given, names in any case', () => {
      const read = readFind(
        { text: ' boiler ', workspace: 'work', status: 'IN PROGRESS', priority: 'high', due: 'This week', today: '2026-10-15', include_done: true },
        [HOME, WORK],
        NOW,
      );

      expect(read).toEqual({
        ok: true,
        query: {
          workspaceId: WORK.id,
          text: 'boiler',
          status: 'in_progress',
          priority: 'high',
          due: 'week',
          includeDone: true,
          today: '2026-10-15',
          after: null,
        },
      });
    });

    it.each([
      { situation: 'priority none', args: { priority: 'None' }, field: 'priority', value: 'none' },
      { situation: 'due not set', args: { due: 'not set' }, field: 'due', value: 'none' },
      { situation: 'due overdue', args: { due: 'Overdue' }, field: 'due', value: 'overdue' },
    ])('reads $situation', ({ args, field, value }) => {
      const read = readFind(args, [HOME], NOW);
      expect(read.ok && (read.query as unknown as Record<string, unknown>)[field]).toBe(value);
    });

    it.each([
      { situation: 'an argument the tool does not have', args: { panel: 'Doing' }, says: ['panel is not an argument', 'text, workspace'] },
      { situation: 'a type, of any name', args: { type: 'Task' }, says: ['type is not an argument'] },
      { situation: 'a workspace nobody has', args: { workspace: 'Garden' }, says: ['"Garden"', '"Home", "Work"'] },
      { situation: 'a workspace that is not a name at all', args: { workspace: 7 }, says: ['workspace must be text'] },
      { situation: 'a priority there is not', args: { priority: 'urgent' }, says: ['priority must be one of', '"Low"', '"High"', '"None"'] },
      { situation: 'a status there is not', args: { status: 'Done' }, says: ['status must be one of', '"To do"', '"In progress"'] },
      { situation: 'a due window there is not', args: { due: 'next year' }, says: ['due must be one of', '"This week"'] },
      { situation: 'a today that is not a date', args: { today: 'tomorrow' }, says: ['today must be a date'] },
      { situation: 'a today that is no day of the calendar', args: { today: '2026-02-30' }, says: ['today must be a date'] },
      { situation: 'an include_done that is not true or false', args: { include_done: 'yes' }, says: ['include_done must be true or false'] },
      { situation: 'text that is not text', args: { text: 5 }, says: ['text must be text'] },
      { situation: 'text over the limit', args: { text: 'x'.repeat(501) }, says: ['at most 500'] },
      { situation: 'a cursor Cockpit did not give', args: { cursor: 'not-a-cursor' }, says: ['cursor is not one find_items gave'] },
    ])('refuses $situation, saying what would do', ({ args, says }) => {
      const read = readFind(args, [HOME, WORK], NOW);
      expect(read.ok).toBe(false);
      for (const words of says) expect(read.ok ? '' : read.refusal).toContain(words);
    });

    it('says there is nothing to find where there is no workspace, rather than listing none', () => {
      expect(readFind({ workspace: 'Home' }, [], NOW)).toEqual({ ok: false, refusal: expect.stringContaining('no workspaces yet') });
    });

    it('reads a cursor it gave, and refuses one with the wrong things in it', () => {
      const given = cursorToText({ updatedAt: '2026-10-10T10:00:00.000Z', id: ID });
      const wrong = btoa(JSON.stringify(['yesterday', 7]));

      expect(cursorFromText(given)).toEqual({ updatedAt: '2026-10-10T10:00:00.000Z', id: ID });
      expect(cursorFromText(wrong)).toBeNull();
      expect(readFind({ cursor: given }, [HOME], NOW)).toMatchObject({ ok: true, query: { after: { id: ID } } });
    });
  });

  describe('an app is told what it can find with, and when to', () => {
    it('names each workspace in the description and as the only values allowed, and offers no panel or attachment', () => {
      const tool = findItemsTool([HOME, WORK]);

      expect(tool.name).toBe('find_items');
      expect(tool.inputSchema.required).toEqual([]);
      expect(tool.inputSchema.properties.workspace!.enum).toEqual(['Home', 'Work']);
      expect(tool.description).toContain('"Home", "Work"');
      expect(Object.keys(tool.inputSchema.properties)).toEqual([
        'text', 'workspace', 'status', 'priority', 'due', 'today', 'include_done', 'cursor',
      ]);
    });

    it('says it only reads, that an item changed between pages can be missed, and to pass the local date', () => {
      const { description } = findItemsTool([HOME]);

      expect(description).toContain('Read-only');
      expect(description).toContain('can be missed');
      expect(description).toContain("today as the user's local date");
    });

    it('offers no list of workspaces to choose from where there are none, rather than an empty one', () => {
      const tool = findItemsTool([]);
      expect(tool.inputSchema.properties.workspace).not.toHaveProperty('enum');
      expect(tool.description).toContain('Workspaces: none yet');
    });

    it('is named in the server instructions beside capturing', () => {
      expect(SERVER_INSTRUCTIONS).toContain('Use create_item when the user asks to capture');
      expect(SERVER_INSTRUCTIONS).toMatch(/Use find_items when the user asks what is in Cockpit, or before capturing something that may already be there/);
    });
  });

  describe('an app is told what it found, each item whole, where it is and how to open it', () => {
    const anItem = (over: Partial<Item>) =>
      ({
        id: ID,
        workspaceId: 'ws-home',
        title: 'Call the plumber',
        description: null,
        nextAction: null,
        sender: null,
        priority: null,
        dueDate: null,
        startedAt: null,
        completedAt: null,
        updatedAt: '2026-10-10T10:00:00.000Z',
        ...over,
      }) as Item;
    const ORIGIN = 'https://cockpit.test';

    it('says plainly that nothing matched, which is no error', () => {
      expect(formatFound({ rows: [], next: null }, ORIGIN)).toBe('No item matches.');
    });

    it('gives the title, next action, status, priority, due date, sender, last change and a link that opens the item', () => {
      const told = formatFound(
        {
          rows: [
            {
              item: anItem({ nextAction: 'Ring him', priority: 'high', dueDate: '2026-10-16', sender: 'Gmail', startedAt: '2026-10-09T10:00:00.000Z' }),
              workspaceName: 'Home',
              places: ['Dashboard 1 ▸ Panel 1', 'Dashboard 2 ▸ Soon'],
            },
          ],
          next: null,
        },
        ORIGIN,
      );

      for (const line of [
        '1. Call the plumber',
        'Next action: Ring him',
        'Status: In progress',
        'Priority: High',
        'Due: 2026-10-16',
        'Sender: Gmail',
        'Where: Home ▸ Dashboard 1 ▸ Panel 1; Home ▸ Dashboard 2 ▸ Soon',
        'Last changed: 2026-10-10T10:00:00.000Z',
        `Open: ${ORIGIN}/w/ws-home?item=${ID}`,
      ]) {
        expect(told).toContain(line);
      }
      expect(told).toContain('That is all of them.');
    });

    it('says an item never filed is in the Inbox, and a finished one is Done', () => {
      const told = formatFound(
        { rows: [{ item: anItem({ completedAt: '2026-10-11T10:00:00.000Z' }), workspaceName: 'Home', places: [] }], next: null },
        ORIGIN,
      );

      expect(told).toContain('Where: Inbox (Home)');
      expect(told).toContain('Status: Done');
    });

    it('gives a long description whole, not cut', () => {
      const description = Array.from({ length: 200 }, (_, n) => `Line ${n + 1} of the notes.`).join('\n');

      const told = formatFound({ rows: [{ item: anItem({ description }), workspaceName: 'Home', places: [] }], next: null }, ORIGIN);

      expect(told).toContain('Line 1 of the notes.');
      expect(told).toContain('Line 200 of the notes.');
    });

    it('ends with the cursor for the next page where more follow, and gives no total', () => {
      const next = { updatedAt: '2026-10-10T10:00:00.000Z', id: ID };

      const told = formatFound({ rows: [{ item: anItem({}), workspaceName: 'Home', places: [] }], next }, ORIGIN);

      expect(told).toContain('More follow');
      expect(told).toContain(`cursor "${cursorToText(next)}"`);
      expect(told).not.toMatch(/\btotal\b/i);
    });
  });
});
