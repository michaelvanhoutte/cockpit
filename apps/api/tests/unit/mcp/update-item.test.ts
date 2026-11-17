import { describe, expect, it } from 'vitest';
import { itemSchema, panelSchema, type Item, type ReadableWorkspace } from '@cockpit/shared';
import type { ChangesApplied } from '../../../src/accounts/answer.js';
import { SERVER_INSTRUCTIONS } from '../../../src/mcp/create-item.js';
import {
  describeUpdate,
  planUpdate,
  readUpdate,
  resolveUpdatePanels,
  updateItemTool,
  waitTimeZone,
  type UpdateFields,
} from '../../../src/mcp/update-item.js';

/**
 * L1: how an app's change is read against the form's own limits, which commands
 * it comes to for the Item as it stands, and what the app is told afterwards.
 * Whose Item it touches, that it lands as the form's commands land and that the
 * limit reaches it is tests/integration/http/update-item.test.ts.
 */

const ID = '018f0000-0000-7000-8000-000000000001';
const NOON_UTC = new Date('2026-10-19T12:00:00.000Z');

function anItem(over: Partial<Item> = {}): Item {
  return {
    ...itemSchema.parse({
      id: ID,
      tenantId: 'tenant',
      workspaceId: 'ws-work',
      workspaceDecided: true,
      capturedMessage: null,
      capturedTimeZone: null,
      source: 'internal',
      sourceId: null,
      sourceLink: null,
      sender: null,
      sourceTimestamp: null,
      sourceResolvedAt: null,
      title: 'Send the quote',
      description: null,
      textsSettledAt: null,
      textsProposedAt: null,
      readings: null,
      proposedPanelId: null,
      proposedPanelReason: null,
      proposedPanelFit: null,
      claudeProposals: null,
      seriesId: null,
      waitingSince: null,
      nextAction: null,
      completedAt: null,
      startedAt: null,
      priority: null,
      prioritySetAt: null,
      dueDate: null,
      dueDateSetAt: null,
      dueDateChosenAt: null,
      unseen: false,
      deletedAt: null,
      createdAt: '2026-10-01T09:00:00.000Z',
      updatedAt: '2026-10-01T09:00:00.000Z',
    }),
    ...over,
  };
}

const fieldsOf = (args: Record<string, unknown>): UpdateFields => {
  const read = readUpdate({ id: ID, ...args });
  if (!read.ok) throw new Error(read.refusal);
  return read.fields;
};
const refusal = (args: unknown) => {
  const read = readUpdate(args);
  return read.ok ? null : read.refusal;
};

/** What a plan writes, in the words a reader of the table would use. */
const writes = (item: Item, args: Record<string, unknown>, timeZone = 'UTC') =>
  planUpdate(item, fieldsOf(args), NOON_UTC, timeZone).steps.map(({ change }) => {
    const { name, payload } = change as { name: string; payload: Record<string, unknown> };
    const { commandId: _c, issuedAt: _i, workspaceId: _w, itemId: _it, ...rest } = payload;
    return `${name} ${JSON.stringify(rest)}`;
  });

/** Work, with Admin on its Work Dashboard and again on Sales, and Quotes. */
const WORK_WS = { id: 'ws-work', tenantId: 'tenant', name: 'Work', color: '#6f62b5', bar: '#594e91', ground: '#e2e2df', header: '#2d2e35' };
const HOME_WS = { ...WORK_WS, id: 'ws-home', name: 'Home' };
const PANELS: ReadableWorkspace[] = [
  {
    workspace: WORK_WS,
    dashboards: [
      { id: 'd-work', tenantId: 'tenant', workspaceId: 'ws-work', name: 'Work' },
      { id: 'd-sales', tenantId: 'tenant', workspaceId: 'ws-work', name: 'Sales' },
    ],
    panels: [
      panelSchema.parse({ id: 'p-admin', tenantId: 'tenant', dashboardId: 'd-work', name: 'Admin', kind: 'items' }),
      panelSchema.parse({ id: 'p-sales-admin', tenantId: 'tenant', dashboardId: 'd-sales', name: 'Admin', kind: 'items' }),
    ],
    layouts: [],
  },
  {
    workspace: HOME_WS,
    dashboards: [{ id: 'd-day', tenantId: 'tenant', workspaceId: 'ws-home', name: 'Day to day' }],
    panels: [panelSchema.parse({ id: 'p-garden', tenantId: 'tenant', dashboardId: 'd-day', name: 'Garden', kind: 'items' })],
    layouts: [],
  },
];

/** What a plan with Panels writes: each command and the Panel it is for. */
const filed = (item: Item, args: Record<string, unknown>) => {
  const read = readUpdate({ id: ID, ...args });
  if (!read.ok) throw new Error(read.refusal);
  const resolved = resolveUpdatePanels(item, PANELS, read.fields.panels!);
  if (!resolved.ok) throw new Error(resolved.refusal);
  const plan = planUpdate(item, read.fields, NOON_UTC, 'UTC', resolved.panels);
  return {
    plan,
    commands: plan.steps.map(({ change }) => {
      const p = change.payload as { panelId?: string | null; workspaceId: string };
      return `${change.name}${'onTop' in change ? ' on top' : ''} ${p.panelId === undefined ? '' : (p.panelId ?? 'inbox')} in ${p.workspaceId}`.replace(/ +/g, ' ');
    }),
  };
};

describe('MCP connections', () => {
  describe('an app changes an item within the form’s own limits, and is refused before anything is written', () => {
    it.each([
      { situation: 'a title over the title limit', args: { title: 'x'.repeat(201) }, says: ['title', '200 characters'] },
      { situation: 'a title with a line break in it', args: { title: 'one\ntwo' }, says: ['title', 'one line'] },
      { situation: 'a next action over 200 characters', args: { next_action: 'x'.repeat(201) }, says: ['next_action', '200 characters'] },
      { situation: 'a next action with a line break in it', args: { next_action: 'a\nb' }, says: ['next_action', 'one line'] },
      { situation: 'a description over 60,000 characters', args: { description: 'x'.repeat(60_001) }, says: ['description', '60,000 characters'] },
      { situation: 'a priority that is not offered', args: { priority: 'urgent' }, says: ['priority', 'low, normal or high'] },
      { situation: 'a due date that is not a calendar date', args: { due_date: '2026-02-30' }, says: ['due_date', 'YYYY-MM-DD'] },
      { situation: 'a due date written another way', args: { due_date: '19/10/2026' }, says: ['due_date', 'YYYY-MM-DD'] },
      { situation: 'a wait of 0 days', args: { status: 'waiting', days: 0 }, says: ['days', '1 to 365'] },
      { situation: 'a wait of 366 days', args: { status: 'waiting', days: 366 }, says: ['days', '1 to 365'] },
      { situation: 'a wait of half a day', args: { status: 'waiting', days: 0.5 }, says: ['days', '1 to 365'] },
      { situation: 'a wait with no days', args: { status: 'waiting' }, says: ['waiting', 'needs days'] },
      { situation: 'days on a status that does not wait', args: { status: 'done', days: 3 }, says: ['days', 'waiting only'] },
      { situation: 'days with no status at all', args: { days: 3 }, says: ['days', 'waiting only'] },
      { situation: 'a status that is not offered', args: { status: 'paused' }, says: ['status', 'to_do, in_progress, done or waiting'] },
      { situation: 'a status given empty', args: { status: null }, says: ['status', 'to_do, in_progress, done or waiting'] },
      { situation: 'a title that is not text', args: { title: 5 }, says: ['title', 'must be text'] },
      { situation: 'a type, which an update has none of', args: { type: 'task', title: 'Fine' }, says: ['type', 'not an argument'] },
      { situation: 'a workspace, which an item cannot be moved to', args: { workspace: 'Home', title: 'Fine' }, says: ['workspace', 'not an argument'] },
      { situation: 'no field at all', args: {}, says: ['at least one field', 'title', 'status'] },
      { situation: 'only days, with nothing to wait on', args: { days: null }, says: ['at least one field'] },
    ])('refuses $situation, naming it', ({ args, says }) => {
      const refused = refusal({ id: ID, ...args });
      expect(refused).not.toBeNull();
      for (const word of says) expect(refused).toContain(word);
    });

    it('refuses a call with no readable id, saying what to pass, before looking at the fields', () => {
      expect(refusal({ title: 'Fine' })).toContain('id of an item or the link that opens it');
    });

    it('refuses the first thing wrong, so a good field beside a bad one changes nothing', () => {
      expect(refusal({ id: ID, title: 'Fine', priority: 'urgent' })).toContain('priority');
    });

    it.each([
      { situation: 'title', args: { title: null }, fields: { title: '' } },
      { situation: 'title, empty', args: { title: '   ' }, fields: { title: '' } },
      { situation: 'next action', args: { next_action: null }, fields: { nextAction: '' } },
      { situation: 'next action, empty', args: { next_action: '' }, fields: { nextAction: '' } },
      { situation: 'description', args: { description: null }, fields: { description: null } },
      { situation: 'description, empty', args: { description: '' }, fields: { description: null } },
      { situation: 'priority', args: { priority: null }, fields: { priority: null } },
      { situation: 'priority, empty', args: { priority: '' }, fields: { priority: null } },
      { situation: 'due date', args: { due_date: null }, fields: { dueDate: null } },
      { situation: 'due date, empty', args: { due_date: '' }, fields: { dueDate: null } },
    ])('reads a $situation given as nothing as clearing it', ({ args, fields }) => {
      expect(fieldsOf(args)).toEqual(fields);
    });

    it('reads the texts trimmed, a priority in any case and the status as the form names it', () => {
      expect(
        fieldsOf({ title: '  Send the quote  ', description: ' More ', priority: 'High', due_date: '2026-11-06', status: 'In_Progress' }),
      ).toEqual({
        title: 'Send the quote',
        description: 'More',
        priority: 'high',
        dueDate: '2026-11-06',
        status: { to: 'in_progress' },
      });
    });

    it('reads null days beside a status that does not wait as no days', () => {
      expect(fieldsOf({ status: 'done', days: null })).toEqual({ status: { to: 'done' } });
    });
  });

  describe('only the fields given are written, each as the form writes it', () => {
    it('writes the title and the priority, and nothing for the rest', () => {
      expect(writes(anItem(), { title: 'Send the revised quote', priority: 'high' })).toEqual([
        'set_title {"title":"Send the revised quote"}',
        'set_priority {"priority":"high"}',
      ]);
    });

    it('writes the texts, the priority and the due date as cleared where they are given empty', () => {
      const item = anItem({ nextAction: 'Call', description: 'More', priority: 'low', dueDate: '2026-11-01' });

      expect(writes(item, { next_action: null, description: '', priority: null, due_date: null })).toEqual([
        'set_next_action {"nextAction":""}',
        'set_description {"description":null}',
        'set_priority {"priority":null}',
        'set_due_date {"dueDate":null}',
      ]);
    });

    it('writes a status as the row does, reopening a finished item before it starts it', () => {
      const finished = anItem({ completedAt: '2026-10-10T09:00:00.000Z' });

      expect(writes(finished, { status: 'in_progress' })).toEqual([
        'set_done {"done":false}',
        'set_started {"started":true}',
      ]);
      expect(writes(anItem(), { status: 'done' })).toEqual(['set_done {"done":true}']);
    });

    it('writes a wait of so many days with the time zone its days are counted on, reopening a finished item first', () => {
      const finished = anItem({ completedAt: '2026-10-10T09:00:00.000Z' });

      expect(writes(finished, { status: 'waiting', days: 3 }, 'Europe/Brussels')).toEqual([
        'set_done {"done":false}',
        'wait_for_reply {"days":3,"timeZone":"Europe/Brussels"}',
      ]);
    });

    it('writes the status before the due date, so a date given beside a wait is the one that stays', () => {
      expect(writes(anItem(), { due_date: '2026-11-06', status: 'waiting', days: 7 })).toEqual([
        'wait_for_reply {"days":7,"timeZone":"UTC"}',
        'set_due_date {"dueDate":"2026-11-06"}',
      ]);
    });

    it('does not write a due date that is the one the wait gives', () => {
      expect(writes(anItem(), { due_date: '2026-10-26', status: 'waiting', days: 7 })).toEqual([
        'wait_for_reply {"days":7,"timeZone":"UTC"}',
      ]);
    });
  });

  describe('a field the item already holds is not written again, so the same call sent twice changes nothing new', () => {
    it.each([
      { situation: 'a title, ignoring the space round it', item: { title: 'Send the quote ' }, args: { title: 'Send the quote' }, so: ['title'] },
      { situation: 'a next action that is none', item: {}, args: { next_action: '' }, so: ['nextAction'] },
      { situation: 'a description that is none', item: {}, args: { description: null }, so: ['description'] },
      { situation: 'a priority', item: { priority: 'high' as const }, args: { priority: 'high' }, so: ['priority'] },
      { situation: 'a due date', item: { dueDate: '2026-11-06' }, args: { due_date: '2026-11-06' }, so: ['dueDate'] },
      { situation: 'a status', item: { startedAt: '2026-10-10T09:00:00.000Z' }, args: { status: 'in_progress' }, so: ['status'] },
      {
        situation: 'a wait already due the day it would be',
        item: { waitingSince: '2026-10-19T09:00:00.000Z', dueDate: '2026-10-26' },
        args: { status: 'waiting', days: 7 },
        so: ['status'],
      },
    ])('names $situation as already so and writes nothing', ({ item, args, so }) => {
      const plan = planUpdate(anItem(item), fieldsOf(args), NOON_UTC, 'UTC');

      expect(plan.steps).toEqual([]);
      expect(plan.alreadySo).toEqual(so);
    });

    it('writes a wait that moves the due date, since waiting again is chasing', () => {
      const waiting = anItem({ waitingSince: '2026-10-12T09:00:00.000Z', dueDate: '2026-10-19' });

      expect(writes(waiting, { status: 'waiting', days: 7 })).toEqual(['wait_for_reply {"days":7,"timeZone":"UTC"}']);
    });
  });

  describe('a wait counts its days on the calendar of the account’s latest capture', () => {
    it('is due the days after today on that calendar, which is already tomorrow in Brussels at 23:30 UTC', () => {
      const lateEvening = new Date('2026-10-19T23:30:00.000Z');

      const brussels = planUpdate(anItem(), fieldsOf({ status: 'waiting', days: 7 }), lateEvening, 'Europe/Brussels');
      const utc = planUpdate(anItem(), fieldsOf({ status: 'waiting', days: 7 }), lateEvening, 'UTC');

      expect(brussels.waitDue).toBe('2026-10-27');
      expect(utc.waitDue).toBe('2026-10-26');
    });

    it.each([
      { situation: 'the latest capture that had a zone', zones: ['Europe/Brussels', 'America/New_York'], zone: 'Europe/Brussels' },
      { situation: 'the next one where the latest is a zone the runtime cannot read', zones: ['Mars/Olympus', 'America/New_York'], zone: 'America/New_York' },
      { situation: 'UTC where no capture ever had one', zones: [], zone: 'UTC' },
      { situation: 'UTC where none can be read', zones: ['Mars/Olympus'], zone: 'UTC' },
    ])('counts on $situation', ({ zones, zone }) => {
      expect(waitTimeZone(zones, NOON_UTC)).toBe(zone);
    });
  });

  describe('the app is told which fields changed, and where one was refused partway, which did not', () => {
    const ran = (n: number, stopped?: ChangesApplied['stopped']): ChangesApplied => ({
      results: Array.from({ length: n }, () => ({ ok: true as const, applied: true })),
      ...(stopped ? { stopped } : {}),
    });
    const link = 'https://cockpit.test/w/ws-work?item=1';
    const plan = (args: Record<string, unknown>, item = anItem()) => planUpdate(item, fieldsOf(args), NOON_UTC, 'UTC');

    it('names one due date where a wait is given beside its own', () => {
      const args = { status: 'waiting', days: 3, due_date: '2026-11-01' };

      expect(describeUpdate('Send the quote', fieldsOf(args), plan(args), ran(2), link)).toEqual({
        reply: `Changed status Waiting for reply and due date 2026-11-01 on "Send the quote". Open it: ${link}`,
      });
    });

    it('names each field that changed, what it is now, and the link', () => {
      const args = { title: 'Send the revised quote', priority: 'high', status: 'waiting', days: 7 };

      expect(describeUpdate('Send the quote', fieldsOf(args), plan(args), ran(3), link)).toEqual({
        reply: `Changed title, priority high and status Waiting for reply, due 2026-10-26 on "Send the quote". Open it: ${link}`,
      });
    });

    it('says which fields were already so beside the ones that changed', () => {
      const args = { title: 'Send the quote', priority: 'high' };

      expect(describeUpdate('Send the quote', fieldsOf(args), plan(args), ran(1), link)).toEqual({
        reply: `Changed priority high on "Send the quote". Already so: title. Open it: ${link}`,
      });
    });

    it('says there was nothing to change where every field is already so', () => {
      const args = { title: 'Send the quote' };

      expect(describeUpdate('Send the quote', fieldsOf(args), plan(args), null, link)).toEqual({
        reply: 'Nothing to change on "Send the quote". Already so: title.',
      });
    });

    it('names what applied before a refusal and what did not, the refused field and the ones never tried', () => {
      const args = { title: 'Send the revised quote', priority: 'high', status: 'in_progress', due_date: '2026-11-06' };
      const stopped = { at: 2, because: 'missing' as const, what: 'item not found' };

      const told = describeUpdate('Send the quote', fieldsOf(args), plan(args), ran(2, stopped), link);

      expect(told).toEqual({
        refusal:
          'Changed title and priority high on "Send the quote". Not changed: status (refused: the item was finished or dismissed while this ran); due date (not attempted).',
      });
    });

    it('says a status stopped after its first step applied did so after part of it', () => {
      const args = { status: 'in_progress' };
      const finished = anItem({ completedAt: '2026-10-10T09:00:00.000Z' });
      const stopped = { at: 1, because: 'missing' as const, what: 'item not found' };

      const told = describeUpdate('Send the quote', fieldsOf(args), plan(args, finished), ran(1, stopped), link);

      expect(told).toEqual({
        refusal:
          'Nothing was changed on "Send the quote". Not changed: status (refused after part of it applied: the item was finished or dismissed while this ran).',
      });
    });

    it('gives the form’s own words where the command refused', () => {
      const args = { status: 'waiting', days: 3 };
      const stopped = { at: 0, because: 'refused' as const, what: 'Cockpit does not know the time zone this device is in.' };

      const told = describeUpdate('Send the quote', fieldsOf(args), plan(args), ran(0, stopped), link);

      expect(told).toEqual({
        refusal:
          'Nothing was changed on "Send the quote". Not changed: status (refused: Cockpit does not know the time zone this device is in.).',
      });
    });
  });

  describe('an app files an item by naming Panels', () => {
    it.each([
      { situation: 'add_panels', args: { add_panels: ['work ▸ admin', 'Sales ▸ Admin'] }, says: ['add_item_to_panel on top p-admin in ws-work', 'add_item_to_panel on top p-sales-admin in ws-work'] },
      { situation: 'remove_panels', args: { remove_panels: ['Work ▸ Admin'] }, says: ['remove_item_from_panel p-admin in ws-work'] },
      { situation: 'move_to_panel', args: { move_to_panel: 'sales ▸ admin' }, says: ['move_item_to_panel on top p-sales-admin in ws-work'] },
      { situation: 'move_to_panel Inbox, in any case', args: { move_to_panel: 'inbox' }, says: ['move_item_to_panel inbox in ws-work'] },
      { situation: 'remove_panels then add_panels, in that order', args: { add_panels: ['Sales ▸ Admin'], remove_panels: ['Work ▸ Admin'] }, says: ['remove_item_from_panel p-admin in ws-work', 'add_item_to_panel on top p-sales-admin in ws-work'] },
    ])('writes the form’s own filing commands for $situation, each on top', ({ args, says }) => {
      expect(filed(anItem(), args).commands).toEqual(says);
    });

    it('files a status given beside them first, so the item is filed in the status it ends with', () => {
      const { commands } = filed(anItem(), { status: 'in_progress', add_panels: ['Work ▸ Admin'] });
      expect(commands).toEqual(['set_started in ws-work', 'add_item_to_panel on top p-admin in ws-work']);
    });

    it('settles an item no workspace has been chosen for in the workspace of the Panel, naming a Panel of any', () => {
      const undecided = anItem({ workspaceDecided: false, workspaceId: 'ws-work' });
      expect(filed(undecided, { move_to_panel: 'Garden' }).commands).toEqual(['move_item_to_panel on top p-garden in ws-home']);
    });

    it('has nothing to do to move an item no workspace has been chosen for to the Inbox, and says so', () => {
      const { plan } = filed(anItem({ workspaceDecided: false }), { move_to_panel: 'Inbox' });
      expect(plan.steps).toEqual([]);
      expect(plan.alreadySo).toEqual(['panels']);
    });

    it.each([
      { situation: 'move_to_panel beside add_panels', args: { move_to_panel: 'Garden', add_panels: ['Garden'] }, says: ['move_to_panel cannot be combined'] },
      { situation: 'Panels that are not a list', args: { add_panels: 'Garden' }, says: ['add_panels must be a list of Panel names'] },
      { situation: 'a Panel that is not a name', args: { remove_panels: [7] }, says: ['remove_panels must be a list of Panel names'] },
      { situation: 'move_to_panel that is a list', args: { move_to_panel: ['A'] }, says: ['move_to_panel must be the name of one Panel'] },
    ])('refuses $situation before anything is looked up', ({ args, says }) => {
      const said = refusal({ id: ID, ...args });
      for (const words of says) expect(said).toContain(words);
    });

    it.each([
      { situation: 'a shared name written bare', item: anItem(), args: { add_panels: ['Admin'] }, says: ['Several Panels are called "Admin"', 'Work ▸ Admin; Sales ▸ Admin'] },
      { situation: 'a Panel of another workspace, for an item that has one', item: anItem(), args: { move_to_panel: 'Garden' }, says: ['No Panel is called "Garden"', 'in the workspace "Work"'] },
      { situation: 'a Panel in both lists', item: anItem(), args: { add_panels: ['Work ▸ Admin'], remove_panels: ['work ▸ admin'] }, says: ['both add_panels and remove_panels'] },
      { situation: 'Panels of two workspaces', item: anItem({ workspaceDecided: false }), args: { add_panels: ['Work ▸ Admin', 'Garden'] }, says: ['different workspaces ("Work", "Home")'] },
      { situation: 'remove_panels on an item no workspace has been chosen for', item: anItem({ workspaceDecided: false }), args: { remove_panels: ['Garden'] }, says: ['on no Panel yet'] },
    ])('refuses $situation, with what would do', ({ item, args, says }) => {
      const read = readUpdate({ id: ID, ...args });
      if (!read.ok) throw new Error(read.refusal);
      const resolved = resolveUpdatePanels(item, PANELS, read.fields.panels!);
      expect(resolved.ok).toBe(false);
      for (const words of says) expect(resolved.ok ? '' : resolved.refusal).toContain(words);
    });

    it('tells the model where the item went', () => {
      const { plan } = filed(anItem(), { add_panels: ['Work ▸ Admin'], remove_panels: ['Sales ▸ Admin'] });
      const read = readUpdate({ id: ID, add_panels: ['Work ▸ Admin'], remove_panels: ['Sales ▸ Admin'] });
      if (!read.ok) throw new Error(read.refusal);
      const ran: ChangesApplied = { results: plan.steps.map(() => ({ applied: true }) as ChangesApplied['results'][number]) };
      const told = describeUpdate('Send the quote', read.fields, plan, ran, 'https://cockpit.test/w/ws-work?item=1');
      expect(told).toEqual({
        reply: 'Changed Panels: taken off Sales ▸ Admin; filed on top of Work ▸ Admin on "Send the quote". Open it: https://cockpit.test/w/ws-work?item=1',
      });
    });
  });

  describe('the tool is listed, and says what it does', () => {
    it('lists update_item with an id required and every other field optional, and no argument beyond them', () => {
      const tool = updateItemTool();

      expect(tool.name).toBe('update_item');
      expect(tool.inputSchema.required).toEqual(['id']);
      expect(Object.keys(tool.inputSchema.properties)).toEqual([
        'id', 'title', 'next_action', 'description', 'priority', 'due_date', 'status', 'days',
        'add_panels', 'remove_panels', 'move_to_panel',
      ]);
      expect(tool.inputSchema.additionalProperties).toBe(false);
      expect(tool.description).toContain('only the fields you give change');
      expect(tool.description).toContain('restore_item');
    });

    it('lists the statuses an app may set, and the limits of the texts, read off the form’s own', () => {
      const { properties } = updateItemTool().inputSchema;

      expect(properties.status).toMatchObject({ enum: ['to_do', 'in_progress', 'done', 'waiting'] });
      expect(properties.title).toMatchObject({ maxLength: 200 });
      expect(properties.next_action).toMatchObject({ maxLength: 200 });
      expect(properties.description).toMatchObject({ maxLength: 60_000 });
      expect(properties.days).toMatchObject({ minimum: 1, maximum: 365 });
    });

    it('names every workspace’s Panels that take items, the shared ones as Dashboard ▸ Panel, and offers the Inbox', () => {
      const tool = updateItemTool(PANELS);
      expect(tool.description).toContain('Panels that take items: Work: "Work ▸ Admin", "Sales ▸ Admin"; Home: "Garden"');
      const { add_panels, move_to_panel } = tool.inputSchema.properties as Record<string, any>;
      expect(add_panels.items.enum).toEqual(['Work ▸ Admin', 'Sales ▸ Admin', 'Garden']);
      expect(move_to_panel.enum).toEqual(['Work ▸ Admin', 'Sales ▸ Admin', 'Garden', 'Inbox', null]);
    });

    it('lists Inbox once where a Panel is called Inbox', () => {
      const tool = updateItemTool(PANELS.map((one, i) => (i === 0 ? { ...one, panels: [{ ...one.panels[0]!, name: 'Inbox' }] } : one)));
      const { enum: names } = tool.inputSchema.properties.move_to_panel as { enum: unknown[] };
      expect(names.filter((name) => name === 'Inbox')).toHaveLength(1);
    });

    it('says none yet and offers no empty list of Panels for an account with none', () => {
      const tool = updateItemTool(PANELS.map((one) => ({ ...one, panels: [] })));
      expect(tool.description).toContain('Panels that take items: none yet');
      expect(tool.inputSchema.properties.add_panels).not.toHaveProperty('items.enum');
      expect(tool.inputSchema.properties.move_to_panel).toMatchObject({ enum: ['Inbox', null] });
    });

    it('tells the model in the server instructions to use update_item to change an item', () => {
      expect(SERVER_INSTRUCTIONS).toContain('Use update_item when the user asks to change an item in Cockpit');
    });
  });
});
