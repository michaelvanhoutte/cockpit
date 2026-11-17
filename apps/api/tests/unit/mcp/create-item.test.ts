import { describe, expect, it } from 'vitest';
import { panelSchema, type Dashboard, type ReadableWorkspace, type Workspace } from '@cockpit/shared';
import { createItemTool, readCapture, senderFrom, stepsAfterCapture } from '../../../src/mcp/create-item.js';

/**
 * L1: how an app's capture is read against the account's own names, and what
 * the tool tells the app. That it is the account as it is now, written where
 * the Inbox shows it, and refused with nothing written, is
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

/** Workspaces with nothing on them, as the store lists them. */
const bare = (...held: Workspace[]): ReadableWorkspace[] =>
  held.map((one) => ({ workspace: one, dashboards: [], panels: [], layouts: [] }));

const dashboard = (workspaceId: string, id: string, name: string): Dashboard => ({ id, tenantId: 'tenant-default', workspaceId, name });
const panel = (dashboardId: string, id: string, name: string, kind: 'items' | 'filter' | 'text' = 'items') =>
  panelSchema.parse({ id, tenantId: 'tenant-default', dashboardId, name, kind });

/** Home has Admin on one Dashboard; Work has Admin on two, and Quotes. */
const WITH_PANELS: ReadableWorkspace[] = [
  {
    workspace: HOME,
    dashboards: [dashboard(HOME.id, 'd-day', 'Day to day')],
    panels: [panel('d-day', 'p-home-admin', 'Admin')],
    layouts: [],
  },
  {
    workspace: WORK,
    dashboards: [dashboard(WORK.id, 'd-work', 'Work'), dashboard(WORK.id, 'd-sales', 'Sales')],
    panels: [panel('d-work', 'p-work-admin', 'Admin'), panel('d-sales', 'p-sales-admin', 'Admin'), panel('d-sales', 'p-quotes', 'Quotes')],
    layouts: [],
  },
];

describe('Capture', () => {
  describe("an app's capture is read against the workspaces as they are", () => {
    it.each([
      {
        situation: 'a message alone, which waits undecided',
        args: { message: '  Ring the plumber  ' },
        workspaces: bare(HOME, WORK),
        read: { ok: true, message: 'Ring the plumber', workspaceId: HOME.id, decided: false },
      },
      {
        situation: 'a workspace named in another case',
        args: { message: 'Send the quote', workspace: 'work' },
        workspaces: bare(HOME, WORK),
        read: { ok: true, message: 'Send the quote', workspaceId: WORK.id, decided: true },
      },
      {
        situation: 'an empty workspace, read as none named',
        args: { message: 'Something', workspace: '' },
        workspaces: bare(HOME),
        read: { ok: true, message: 'Something', workspaceId: HOME.id, decided: false },
      },
    ])('$situation', ({ args, workspaces, read }) => {
      expect(readCapture(args, workspaces)).toEqual({ panels: [], files: [], ...read });
    });

    it.each([
      { situation: 'a workspace nobody has', args: { message: 'x', workspace: 'Garden' }, says: ['"Garden"', '"Home", "Work"'] },
      { situation: 'a workspace that is not a name at all', args: { message: 'x', workspace: 7 }, says: ['"Home", "Work"'] },
      { situation: 'a type, of any name', args: { message: 'x', type: 'Task' }, says: ['type is not an argument'] },
      { situation: 'an empty type', args: { message: 'x', type: '' }, says: ['type is not an argument'] },
      { situation: 'no message', args: {}, says: ['1 and 60,000'] },
      { situation: 'a message of spaces', args: { message: '   ' }, says: ['1 and 60,000'] },
      { situation: 'a message one over the limit', args: { message: 'x'.repeat(60_001) }, says: ['1 and 60,000'] },
      { situation: 'no arguments at all', args: undefined, says: ['message'] },
    ])('refuses $situation, saying what would do', ({ args, says }) => {
      const read = readCapture(args, bare(HOME, WORK));
      expect(read.ok).toBe(false);
      for (const words of says) expect(read.ok ? '' : read.refusal).toContain(words);
    });

    it('refuses a capture with no workspace to put it in, and says to make one', () => {
      const read = readCapture({ message: 'Somewhere to go' }, []);
      expect(read).toEqual({ ok: false, refusal: expect.stringContaining('no workspace yet') });
    });

    it('takes a message of exactly the limit', () => {
      expect(readCapture({ message: 'x'.repeat(60_000) }, bare(HOME)).ok).toBe(true);
    });
  });

  describe("an app's capture sets every field the capture box does", () => {
    it('reads a title, next action, priority, due date and Panel beside the message, filing it in the Panel’s workspace', () => {
      const read = readCapture(
        {
          message: 'Send the quote to Bart',
          title: ' Quote for Bart ',
          next_action: 'Find the figures',
          priority: 'HIGH',
          due_date: '2026-11-06',
          panels: ['quotes'],
        },
        WITH_PANELS,
      );
      expect(read).toEqual({
        ok: true,
        message: 'Send the quote to Bart',
        workspaceId: WORK.id,
        decided: true,
        title: 'Quote for Bart',
        nextAction: 'Find the figures',
        priority: 'high',
        dueDate: '2026-11-06',
        panels: [{ id: 'p-quotes', place: 'Sales ▸ Quotes' }],
        files: [],
      });
    });

    it('reads a field given empty as left out, since a new item has nothing to clear', () => {
      const read = readCapture({ message: 'x', title: '', next_action: null, priority: null, due_date: '', panels: [] }, bare(HOME));
      expect(read).toEqual({ ok: true, message: 'x', workspaceId: HOME.id, decided: false, panels: [], files: [] });
    });

    it('keeps the workspace named and looks for Panels in it only', () => {
      expect(readCapture({ message: 'x', workspace: 'Work', panels: ['Quotes'] }, WITH_PANELS)).toMatchObject({ ok: true, workspaceId: WORK.id });
      const refused = readCapture({ message: 'x', workspace: 'Home', panels: ['Quotes'] }, WITH_PANELS);
      expect(refused).toEqual({ ok: false, refusal: expect.stringContaining('in the workspace "Home" that take items are "Admin"') });
    });

    it('refuses Panels of different workspaces, since an item belongs to one', () => {
      const read = readCapture({ message: 'x', panels: ['Home ▸ Day to day ▸ Admin', 'Quotes'] }, WITH_PANELS);
      expect(read).toEqual({ ok: false, refusal: expect.stringContaining('different workspaces ("Home", "Work")') });
    });

    it.each([
      { situation: 'a shared Panel name', args: { panels: ['Admin'] }, says: ['Work ▸ Admin', 'Sales ▸ Admin'] },
      { situation: 'a Panel nobody has', args: { workspace: 'Work', panels: ['Garden'] }, says: ['"Garden"', 'Quotes'] },
      { situation: 'Panels that are not a list', args: { panels: 'Quotes' }, says: ['panels must be a list'] },
      { situation: 'a next action over 200 characters', args: { next_action: 'x'.repeat(201) }, says: ['next_action', '200'] },
      { situation: 'a title of two lines', args: { title: 'one\ntwo' }, says: ['title must be one line'] },
      { situation: 'a due date that is no day', args: { due_date: '2026-02-30' }, says: ['due_date'] },
      { situation: 'a priority nobody has', args: { priority: 'urgent' }, says: ['priority'] },
      { situation: 'waiting with no days', args: { status: 'waiting' }, says: ['needs days'] },
      { situation: 'a description, which the message is', args: { description: 'x' }, says: ['description is not an argument'] },
    ])('refuses $situation, saying what would do', ({ args, says }) => {
      const read = readCapture({ message: 'x', ...args }, WITH_PANELS);
      expect(read.ok).toBe(false);
      for (const words of says) expect(read.ok ? '' : read.refusal).toContain(words);
    });

    it.each([
      { situation: 'to do, which is how a capture starts', status: { status: 'to_do' }, commands: [] },
      { situation: 'in progress', status: { status: 'in_progress' }, commands: ['set_started'] },
      { situation: 'done', status: { status: 'done' }, commands: ['set_done'] },
      { situation: 'waiting for a reply', status: { status: 'waiting', days: 3 }, commands: ['wait_for_reply'] },
      { situation: 'waiting, with a due date given beside it', status: { status: 'waiting', days: 3, due_date: '2026-11-06' }, commands: ['wait_for_reply', 'set_due_date'] },
    ])('follows the capture, for status $situation, with the row’s own steps', ({ status, commands }) => {
      const read = readCapture({ message: 'x', ...status }, bare(HOME));
      if (!read.ok) throw new Error(read.refusal);
      const steps = stepsAfterCapture(read, 'item-1', '2026-10-19T12:00:00.000Z', 'UTC');
      expect(steps.map((step) => step.name)).toEqual(commands);
    });
  });

  describe("an app is told every workspace's Panels that take items", () => {
    it('names them in the description, the shared ones as Dashboard ▸ Panel, and allows them as the values of panels', () => {
      const tool = createItemTool(WITH_PANELS);
      expect(tool.description).toContain('Panels that take items: Home: "Admin"; Work: "Work ▸ Admin", "Sales ▸ Admin", "Quotes"');
      const items = (tool.inputSchema.properties.panels as { items: { enum: string[] } }).items;
      expect(items.enum).toContain('Sales ▸ Admin');
      expect(Object.keys(tool.inputSchema.properties)).toEqual(
        expect.arrayContaining(['message', 'workspace', 'title', 'next_action', 'priority', 'due_date', 'status', 'days', 'panels']),
      );
      expect(tool.inputSchema.required).toEqual(['message']);
    });

    it('says none yet, with no empty list of values, for an account with no Panel', () => {
      const tool = createItemTool(bare(HOME, WORK));
      expect(tool.description).toContain('Panels that take items: none yet');
      expect(tool.inputSchema.properties.panels).not.toHaveProperty('items.enum');
    });
  });

  describe("an app is told the account's own workspaces", () => {
    it('names each, in the description and as the only values allowed, and offers no type', () => {
      const tool = createItemTool(bare(HOME, WORK));
      expect(tool.name).toBe('create_item');
      expect(tool.inputSchema.required).toEqual(['message']);
      expect(tool.inputSchema.properties.workspace!.enum).toEqual(['Home', 'Work']);
      expect(tool.inputSchema.properties).not.toHaveProperty('type');
      expect(tool.description).toContain('"Home", "Work"');
      expect(tool.description).not.toMatch(/types?:/i);
    });

    it('offers no list of workspaces to choose from where there are none, rather than an empty one', () => {
      const tool = createItemTool([]);
      expect(tool.inputSchema.properties.workspace).not.toHaveProperty('enum');
      expect(tool.description).toContain('Workspaces: none yet');
    });
  });
});

describe('Capture', () => {
  describe("an app's captures are signed with the name it registered, never with half a character", () => {
    it.each([
      { situation: 'a plain name', name: '  Claude  ', sender: 'Claude' },
      { situation: 'a name of nothing but spaces', name: '   ', sender: null },
      { situation: 'a name too long, cut at the limit', name: 'a'.repeat(250), sender: 'a'.repeat(200) },
      { situation: 'a name too long whose limit falls inside an emoji', name: `${'a'.repeat(199)}😀tail`, sender: 'a'.repeat(199) },
    ])('$situation', ({ name, sender }) => {
      expect(senderFrom(name)).toBe(sender);
    });
  });
});
