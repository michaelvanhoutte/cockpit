import { afterEach, beforeEach, describe, expect, inject, it, vi } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { itemHasOpenReadings, itemStatus, type Filing, type FinishedItems, type Item, type ServerEvent } from '@cockpit/shared';
import {
  ACCOUNT_NAME,
  DASHBOARD_ID,
  OTHER_ACCOUNT_NAME,
  OTHER_USER_ID,
  USER_ID,
  WORKSPACE_ID,
  accountOf,
  alsoWorkspaces,
  asUser,
  inStoreAsItIs,
  seedRegister,
  startFromEmpty,
  storeNamed,
  withoutTheGuide,
} from '../seed.js';
import { ORIGIN, connected, mcp } from './connected-apps.support.js';

interface ToolAnswer {
  isError?: boolean;
  content: { type: string; text: string }[];
}

/**
 * Integration level, through the whole Worker: a connected app changing an Item
 * ("MCP changes and deletes: add update_item for the texts, priority, due date
 * and status", issue 1811). Every case enters the way an app does, through
 * `/mcp`, because whose Items may be touched, how often, and that the commands
 * land as the form's own do are facts about the account's own store and the
 * routing in front of it. How the arguments are read against the form's limits,
 * which commands each comes to and what the reply says is proved at L1
 * (tests/unit/mcp/update-item.test.ts); the status steps are the shared ones
 * (packages/shared), and each command's own rules are its tests'.
 */

beforeEach(async () => {
  await applyD1Migrations(env.DB, inject('migrations'));
  await startFromEmpty();
  await seedRegister();
  await withoutTheGuide();
  await withoutTheGuide(OTHER_ACCOUNT_NAME);
});

afterEach(() => {
  vi.useRealTimers();
});

/** When the person's own changes were made: long before the app's calls, which the Worker times itself. */
const EARLIER = '2026-01-01T00:00:00.000Z';
const SWIPED = '2026-01-02T00:00:00.000Z';
const LATER = '2026-02-01T00:00:00.000Z';

let seq = 0;
function nextId(): string {
  seq += 1;
  return `018f0000-0000-7000-8000-${String(seq).padStart(12, '0')}`;
}

async function send(command: string, body: Record<string, unknown>, userId: string = USER_ID, issuedAt = EARLIER) {
  return asUser(
    `${ORIGIN}/v1/commands/${command}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ commandId: nextId(), issuedAt, workspaceId: WORKSPACE_ID, ...body }),
    },
    userId,
  );
}

async function anItem(message: string, extra: Record<string, unknown> = {}, userId: string = USER_ID): Promise<string> {
  const itemId = nextId();
  expect((await send('capture_item', { itemId, message, ...extra }, userId)).status).toBe(200);
  return itemId;
}

async function aPanel(name: string): Promise<string> {
  const panelId = nextId();
  expect((await send('add_panel', { dashboardId: DASHBOARD_ID, panelId, name, kind: 'items' })).status).toBe(200);
  return panelId;
}

/** The Workspace as an open tab reads it. */
async function snapshot(workspaceId: string = WORKSPACE_ID): Promise<{ items: Item[]; filings: Filing[] }> {
  return (await (await asUser(`${ORIGIN}/v1/workspaces/${workspaceId}/snapshot`)).json()) as { items: Item[]; filings: Filing[] };
}

/** The Item as a tab reads it back. */
async function read(itemId: string): Promise<Item> {
  const found = (await snapshot()).items.find((item) => item.id === itemId);
  if (!found) throw new Error(`item ${itemId} is not in the snapshot`);
  return found;
}

async function call(token: string, tool: string, args: Record<string, unknown>): Promise<ToolAnswer> {
  const answer = await mcp(token, 'tools/call', { name: tool, arguments: args });
  expect(answer.status).toBe(200);
  return ((await answer.json()) as { result: ToolAnswer }).result;
}

const updateItem = (token: string, args: Record<string, unknown>) => call(token, 'update_item', args);
const textOf = (answer: ToolAnswer) => answer.content[0]!.text;

/** How many times a command was logged, applied or not. */
const logged = (name: string) =>
  inStoreAsItIs(accountOf(USER_ID), (sql) => sql.exec('SELECT count(*) AS n FROM commands WHERE name = ?', name).one().n);

const WRITES = ['set_title', 'set_next_action', 'set_description', 'set_priority', 'set_due_date', 'set_done', 'set_started', 'wait_for_reply'];
const writtenByTheApp = async () => (await Promise.all(WRITES.map(logged))).reduce<number>((sum, n) => sum + Number(n), 0);

describe('MCP connections', () => {
  describe('an app changes only the fields it gives, and they land as the item’s form would write them', () => {
    it('changes the title and the priority and leaves the description, the due date and the status as they were', async () => {
      const { token } = await connected();
      const itemId = await anItem('Send the quote to Bart, with the figures from the spreadsheet we talked about on Monday', {
        priority: 'low',
      });
      expect((await send('set_due_date', { itemId, dueDate: '2026-11-06' })).status).toBe(200);
      const before = await read(itemId);

      const changed = await updateItem(token, { id: itemId, title: 'Send Bart the quote', priority: 'high' });

      expect(changed.isError).toBeFalsy();
      expect(textOf(changed)).toContain('Changed title and priority high');
      const after = await read(itemId);
      expect(after).toMatchObject({ title: 'Send Bart the quote', priority: 'high' });
      expect(after.description).toBe(before.description);
      expect(after.dueDate).toBe('2026-11-06');
      expect(itemStatus(after)).toBe('to_do');
    });

    it('clears a description given empty, and a next action and due date given null', async () => {
      const { token } = await connected();
      const itemId = await anItem('Ring the plumber');
      expect((await send('set_description', { itemId, description: 'About the boiler' })).status).toBe(200);
      expect((await send('set_next_action', { itemId, nextAction: 'Find the number' })).status).toBe(200);
      expect((await send('set_due_date', { itemId, dueDate: '2026-11-06' })).status).toBe(200);

      const cleared = await updateItem(token, { id: itemId, description: '', next_action: null, due_date: null });

      expect(cleared.isError).toBeFalsy();
      expect(await read(itemId)).toMatchObject({ description: null, nextAction: null, dueDate: null });
    });

    it('takes the texts over from Cockpit when it sets the title, withdrawing the proposal as editing the title does', async () => {
      const { token } = await connected();
      const itemId = await anItem('Reply to Bart');
      await inStoreAsItIs(accountOf(USER_ID), (sql) =>
        sql.exec(
          'UPDATE items SET texts_proposed_at = ?, readings = ? WHERE id = ?',
          EARLIER,
          JSON.stringify([{ title: 'Reply to Bart in January', description: '', meaning: "'jan' is short for January" }]),
          itemId,
        ),
      );
      const proposed = await read(itemId);
      expect(proposed.textsSettledAt).toBeNull();
      expect(itemHasOpenReadings(proposed)).toBe(true);

      expect((await updateItem(token, { id: itemId, title: 'Mail Bart the numbers' })).isError).toBeFalsy();

      const settled = await read(itemId);
      expect(settled.title).toBe('Mail Bart the numbers');
      expect(settled.textsSettledAt).not.toBeNull();
      expect(itemHasOpenReadings(settled)).toBe(false);
    });

    it('sets Done on an item filed on a panel, which takes it off every list and keeps it in All items', async () => {
      const { token } = await connected();
      const admin = await aPanel('Admin');
      const itemId = await anItem('Pay the invoice', { panelIds: [admin] });

      const done = await updateItem(token, { id: itemId, status: 'done' });

      expect(done.isError).toBeFalsy();
      expect(itemStatus(await read(itemId))).toBe('done');
      const finished = (await (await asUser(`${ORIGIN}/v1/workspaces/${WORKSPACE_ID}/finished-items`)).json()) as FinishedItems;
      expect(finished.items.map((item) => item.id)).toContain(itemId);
      expect(finished.filings.filter((filing) => filing.itemId === itemId).map((filing) => filing.panelId)).toEqual([admin]);
      expect(textOf(await call(token, 'find_items', { panel: 'Admin' }))).toBe('No item matches.');
    });

    it('reopens a finished item and starts it, as the row’s Status does', async () => {
      const { token } = await connected();
      const itemId = await anItem('Book the dentist');
      expect((await send('set_done', { itemId, done: true })).status).toBe(200);

      const started = await updateItem(token, { id: itemId, status: 'in_progress' });

      expect(started.isError).toBeFalsy();
      const after = await read(itemId);
      expect(itemStatus(after)).toBe('in_progress');
      expect(after.completedAt).toBeNull();
    });

    it('changes an item that belongs to no workspace yet, and leaves it on Any workspace', async () => {
      const { token } = await connected();
      const itemId = await anItem('Something for later', { workspaceDecided: false });

      const changed = await updateItem(token, { id: itemId, title: 'Something for Friday', priority: 'normal' });

      expect(changed.isError).toBeFalsy();
      expect(await read(itemId)).toMatchObject({ title: 'Something for Friday', priority: 'normal', workspaceDecided: false });
    });
  });

  describe('a wait’s days are counted on the calendar of the account’s latest capture', () => {
    /** 23:30 UTC, when Brussels has already started the next day. */
    const LATE_EVENING = Date.parse('2026-10-19T23:30:00.000Z');

    it('is due 7 days from today in Brussels, and waiting since now, for an account whose latest capture was made there', async () => {
      vi.useFakeTimers({ toFake: ['Date'], now: LATE_EVENING });
      const { token } = await connected();
      await anItem('Captured in Brussels', { timeZone: 'Europe/Brussels' });
      const itemId = await anItem('Wait on Bart');

      const waited = await updateItem(token, { id: itemId, status: 'waiting', days: 7 });

      expect(waited.isError).toBeFalsy();
      expect(textOf(waited)).toContain('status Waiting for reply, due 2026-10-27');
      const after = await read(itemId);
      expect(after.dueDate).toBe('2026-10-27');
      expect(after.waitingSince).toBe('2026-10-19T23:30:00.000Z');
      expect(itemStatus(after)).toBe('waiting');
    });

    it('counts on UTC where no capture ever carried a time zone', async () => {
      vi.useFakeTimers({ toFake: ['Date'], now: LATE_EVENING });
      const { token } = await connected();
      const itemId = await anItem('Wait on Bart');

      const waited = await updateItem(token, { id: itemId, status: 'waiting', days: 7 });

      expect(waited.isError).toBeFalsy();
      expect((await read(itemId)).dueDate).toBe('2026-10-26');
    });

    it('is due on the date given beside the wait, which is written after it', async () => {
      const { token } = await connected();
      const itemId = await anItem('Wait on Bart');

      await updateItem(token, { id: itemId, status: 'waiting', days: 7, due_date: '2027-01-15' });

      expect((await read(itemId)).dueDate).toBe('2027-01-15');
    });
  });

  describe('one call is one store call, and a refusal partway says what applied', () => {
    it('is announced once for a title, a priority and a status, and a tab reading after it holds all three', async () => {
      const { token } = await connected();
      const itemId = await anItem('Send the quote');
      const before = await storeNamed(ACCOUNT_NAME).newestChange(ACCOUNT_NAME);
      const since = before.status === 'ok' ? (before.value ?? '') : '';

      const changed = await updateItem(token, { id: itemId, title: 'Send Bart the quote', priority: 'high', status: 'in_progress' });

      expect(changed.isError).toBeFalsy();
      const heard = await storeNamed(ACCOUNT_NAME).changesSince(ACCOUNT_NAME, since);
      if (heard.status !== 'ok') throw new Error(JSON.stringify(heard));
      const announcements = heard.value.events.filter(
        (event: ServerEvent) => event.type === 'snapshot_invalidated' && event.workspaceId === WORKSPACE_ID,
      );
      expect(announcements).toHaveLength(1);
      expect(await read(itemId)).toMatchObject({ title: 'Send Bart the quote', priority: 'high' });
      expect(itemStatus(await read(itemId))).toBe('in_progress');
      // Each command kept its own line in the log, as when a tab sends them one by one.
      expect(await writtenByTheApp()).toBe(3);
    });

    /**
     * **Entered at the store, not through `/mcp`**, which is the exception the
     * testing skill allows: what is wrong here is an Item finished and dismissed
     * between the Worker reading it and the commands running, and no request
     * can be timed to land there. The commands are the ones `update_item` sends
     * for a title and a start on the Item as the Worker read it, open.
     */
    it('keeps the title it wrote and stops at the status when the item was finished and dismissed in between', async () => {
      const itemId = await anItem('Send the quote');
      expect((await send('set_done', { itemId, done: true }, USER_ID, SWIPED)).status).toBe(200);
      expect((await send('set_dismissed', { itemId, dismissed: true }, USER_ID, SWIPED)).status).toBe(200);
      const command = { issuedAt: LATER, workspaceId: WORKSPACE_ID, itemId };

      const answer = await storeNamed(ACCOUNT_NAME).applyChanges(ACCOUNT_NAME, [
        { name: 'set_title', payload: { ...command, commandId: nextId(), title: 'Send Bart the quote' } },
        { name: 'set_started', payload: { ...command, commandId: nextId(), started: true } },
        { name: 'set_priority', payload: { ...command, commandId: nextId(), priority: 'high' } },
      ]);

      if (answer.status !== 'ok') throw new Error(JSON.stringify(answer));
      expect(answer.value.results).toHaveLength(1);
      expect(answer.value.stopped).toMatchObject({ at: 1, because: 'missing' });
      const row = await inStoreAsItIs(accountOf(USER_ID), (sql) =>
        sql.exec('SELECT title, priority, started_at FROM items WHERE id = ?', itemId).one(),
      );
      expect(row).toMatchObject({ title: 'Send Bart the quote', priority: null, started_at: null });
      expect(await logged('set_priority')).toBe(0);
    });

    it('answers the same call sent twice as nothing new, saying the fields are already so, and writes nothing twice', async () => {
      const { token } = await connected();
      const itemId = await anItem('Send the quote');
      const args = { id: itemId, title: 'Send Bart the quote', priority: 'high', status: 'in_progress' };
      await updateItem(token, args);
      const written = await writtenByTheApp();

      const again = await updateItem(token, args);

      expect(again.isError).toBeFalsy();
      expect(textOf(again)).toContain('Nothing to change');
      expect(textOf(again)).toContain('Already so: title, priority and status');
      expect(await writtenByTheApp()).toBe(written);
    });
  });

  describe('the item named is this account’s, or the call is refused and nothing changes', () => {
    it('refuses an id no item has, and writes nothing', async () => {
      const { token } = await connected();
      const kept = await anItem('Keep me');

      const refused = await updateItem(token, { id: nextId(), title: 'Changed' });

      expect(refused.isError).toBe(true);
      expect(textOf(refused)).toContain('There is no item with that id');
      expect(await writtenByTheApp()).toBe(0);
      expect((await read(kept)).title).toBe('Keep me');
    });

    it('refuses another account’s item in the very words it refuses one nobody has, and writes nothing in either', async () => {
      const { token } = await connected();
      const theirs = await anItem('Their secret', {}, OTHER_USER_ID);

      const nobodys = await updateItem(token, { id: nextId(), title: 'Changed', priority: 'high' });
      const theirChange = await updateItem(token, { id: theirs, title: 'Changed', priority: 'high' });

      expect(theirChange.isError).toBe(true);
      expect(textOf(theirChange)).toBe(textOf(nobodys));
      const theirs2 = await asUser(`${ORIGIN}/v1/workspaces/${WORKSPACE_ID}/snapshot`, {}, OTHER_USER_ID);
      expect(((await theirs2.json()) as { items: Item[] }).items.find((item) => item.id === theirs)?.title).toBe('Their secret');
      expect(await inStoreAsItIs(OTHER_ACCOUNT_NAME, (sql) => sql.exec("SELECT count(*) AS n FROM commands WHERE name = 'set_title'").one().n)).toBe(0);
    });

    it('refuses a dismissed item, saying to restore it first, and changes nothing', async () => {
      const { token } = await connected();
      const itemId = await anItem('Gone from the lists');
      expect((await call(token, 'delete_item', { id: itemId })).isError).toBeFalsy();

      const refused = await updateItem(token, { id: itemId, title: 'Changed' });

      expect(refused.isError).toBe(true);
      expect(textOf(refused)).toContain('restore_item');
      expect(await writtenByTheApp()).toBe(0);
      expect((await call(token, 'restore_item', { id: itemId })).isError).toBeFalsy();
      expect((await read(itemId)).title).toBe('Gone from the lists');
    });

    it('refuses a call with one bad field before writing the good one beside it', async () => {
      const { token } = await connected();
      const itemId = await anItem('Send the quote');

      const refused = await updateItem(token, { id: itemId, title: 'Changed', priority: 'urgent' });

      expect(refused.isError).toBe(true);
      expect(textOf(refused)).toContain('priority');
      expect(await writtenByTheApp()).toBe(0);
      expect((await read(itemId)).title).toBe('Send the quote');
    });
  });

  describe('changing counts against the 60 calls a minute an app shares with capture', () => {
    it('refuses the 61st call of a minute, mixing create_item and update_item, and changes nothing for it', async () => {
      const { token } = await connected();
      const itemId = await anItem('Change me');
      for (let n = 1; n <= 30; n += 1) {
        expect((await call(token, 'create_item', { message: `Note ${n}`, workspace: 'Workspace 1' })).isError, `note ${n}`).toBeFalsy();
        expect((await updateItem(token, { id: itemId, title: `Title ${n}` })).isError, `title ${n}`).toBeFalsy();
      }

      const sixtyFirst = await updateItem(token, { id: itemId, title: 'One too many' });

      expect(sixtyFirst.isError).toBe(true);
      expect(textOf(sixtyFirst)).toContain('Too many');
      expect((await read(itemId)).title).toBe('Title 30');
    });
  });
});

/** The Panel's Items, top first, as the Workspace's read carries them. */
async function onPanel(panelId: string, workspaceId: string = WORKSPACE_ID): Promise<string[]> {
  const { filings } = await snapshot(workspaceId);
  return filings
    .filter((filing) => filing.panelId === panelId)
    .sort((a, b) => a.position - b.position)
    .map((filing) => filing.itemId);
}

/** The Panels an Item is on, as the Workspace's read carries them. */
async function panelsOf(itemId: string, workspaceId: string = WORKSPACE_ID): Promise<string[]> {
  return (await snapshot(workspaceId)).filings.filter((filing) => filing.itemId === itemId).map((filing) => filing.panelId).sort();
}

const createItem = (token: string, args: Record<string, unknown>) => call(token, 'create_item', args);

describe('MCP connections', () => {
  describe('filing over MCP leaves the item exactly where Move to… or Add to would', () => {
    it('adds it to another Panel, on top of that Panel and still on the one it was on', async () => {
      const { token } = await connected();
      const [admin, calls] = [await aPanel('Admin'), await aPanel('Calls')];
      const waiting = await anItem('Already on Calls', { panelIds: [calls] });
      const itemId = await anItem('Pay the invoice', { panelIds: [admin] });

      const said = await updateItem(token, { id: itemId, add_panels: ['calls'] });

      expect(said.isError).toBeFalsy();
      expect(textOf(said)).toContain('Changed Panels: filed on top of Dashboard 1 ▸ Calls');
      expect(await panelsOf(itemId)).toEqual([admin, calls].sort());
      expect(await onPanel(calls)).toEqual([itemId, waiting]);
      expect(await onPanel(admin)).toEqual([itemId]);
    });

    it('takes it off its only Panel and leaves it in the Inbox', async () => {
      const { token } = await connected();
      const admin = await aPanel('Admin');
      const itemId = await anItem('Pay the invoice', { panelIds: [admin] });

      expect((await updateItem(token, { id: itemId, remove_panels: ['Admin'] })).isError).toBeFalsy();

      expect(await panelsOf(itemId)).toEqual([]);
      expect(await onPanel(admin)).toEqual([]);
      expect((await read(itemId)).workspaceId).toBe(WORKSPACE_ID);
    });

    it('moves it to one Panel off all the others, on top', async () => {
      const { token } = await connected();
      const [a, b, c] = [await aPanel('A'), await aPanel('B'), await aPanel('C')];
      const held = await anItem('Already on C', { panelIds: [c] });
      const itemId = await anItem('Move me', { panelIds: [a, b] });
      expect(await panelsOf(itemId)).toEqual([a, b].sort());

      const said = await updateItem(token, { id: itemId, move_to_panel: 'c' });

      expect(said.isError).toBeFalsy();
      expect(await panelsOf(itemId)).toEqual([c]);
      expect(await onPanel(c)).toEqual([itemId, held]);
      expect(await onPanel(a)).toEqual([]);
    });

    it('moves it to the Inbox, off every Panel', async () => {
      const { token } = await connected();
      const [a, b] = [await aPanel('A'), await aPanel('B')];
      const itemId = await anItem('Move me', { panelIds: [a, b] });

      expect((await updateItem(token, { id: itemId, move_to_panel: 'Inbox' })).isError).toBeFalsy();

      expect(await panelsOf(itemId)).toEqual([]);
    });

    it('leaves an item finished more than a day ago where it was on the Panel, so reopening it finds it there', async () => {
      const { token } = await connected();
      const admin = await aPanel('Admin');
      const old = await anItem('Finished long ago', { panelIds: [admin] });
      const open = await anItem('Still open', { panelIds: [admin] });
      expect((await send('set_done', { itemId: old, done: true })).status).toBe(200);
      const before = await inStoreAsItIs(accountOf(USER_ID), (sql) =>
        sql.exec('SELECT item_id, position FROM panel_items WHERE item_id = ?', old).one(),
      );
      const itemId = await anItem('Newcomer');

      expect((await updateItem(token, { id: itemId, add_panels: ['Admin'] })).isError).toBeFalsy();

      expect(await onPanel(admin)).toEqual([itemId, open]);
      const kept = await inStoreAsItIs(accountOf(USER_ID), (sql) =>
        sql.exec('SELECT item_id, position FROM panel_items WHERE item_id = ?', old).one(),
      );
      expect(kept).toEqual(before);
      expect((await send('set_done', { itemId: old, done: false })).status).toBe(200);
      expect(await panelsOf(old)).toEqual([admin]);
    });

    it('settles an item on Any workspace in the workspace of the Panel, and takes it out of the other Inboxes', async () => {
      await alsoWorkspaces();
      const { token } = await connected();
      const itemId = await anItem('Waits everywhere', { workspaceDecided: false });
      for (const workspaceId of [WORKSPACE_ID, 'ws-atlas', 'ws-personal']) {
        expect((await snapshot(workspaceId)).items.map((item) => item.id), workspaceId).toContain(itemId);
      }

      const said = await updateItem(token, { id: itemId, move_to_panel: 'Atlas Copco ▸ Dashboard 1 ▸ Panel 1' });

      expect(said.isError).toBeFalsy();
      expect(await onPanel('ws-atlas-panel-1', 'ws-atlas')).toEqual([itemId]);
      expect((await snapshot('ws-atlas')).items.find((item) => item.id === itemId)).toMatchObject({ workspaceId: 'ws-atlas', workspaceDecided: true });
      for (const workspaceId of [WORKSPACE_ID, 'ws-personal']) {
        expect((await snapshot(workspaceId)).items.map((item) => item.id), workspaceId).not.toContain(itemId);
      }
    });

    it('refuses a Panel name several share, naming each as Dashboard ▸ Panel, and files nothing', async () => {
      const { token } = await connected();
      const dashboardId = nextId();
      expect((await send('add_dashboard', { dashboardId, panelId: nextId(), name: 'Sales' })).status).toBe(200);
      const [one, two] = [nextId(), nextId()];
      expect((await send('add_panel', { dashboardId: DASHBOARD_ID, panelId: one, name: 'Admin', kind: 'items' })).status).toBe(200);
      expect((await send('add_panel', { dashboardId, panelId: two, name: 'Admin', kind: 'items' })).status).toBe(200);
      const itemId = await anItem('Pay the invoice');

      const shared = await updateItem(token, { id: itemId, add_panels: ['Admin'] });

      expect(shared.isError).toBe(true);
      expect(textOf(shared)).toContain('Dashboard 1 ▸ Admin; Sales ▸ Admin');
      expect(await panelsOf(itemId)).toEqual([]);
      expect((await updateItem(token, { id: itemId, add_panels: ['sales ▸ admin'] })).isError).toBeFalsy();
      expect(await panelsOf(itemId)).toEqual([two]);
    });

    it('writes nothing for a call that names a Panel nobody has, and lists the ones there are', async () => {
      const { token } = await connected();
      await aPanel('Admin');
      const itemId = await anItem('Pay the invoice');

      const refused = await updateItem(token, { id: itemId, move_to_panel: 'Garden' });

      expect(refused.isError).toBe(true);
      expect(textOf(refused)).toContain('"Admin"');
      expect(await panelsOf(itemId)).toEqual([]);
      expect(await writtenByTheApp()).toBe(0);
    });
  });

  describe('create_item sets every field a capture can, in one capture', () => {
    it('captures a titled item on top of a Panel with a priority and a due date, the message as its description', async () => {
      const { token } = await connected();
      const admin = await aPanel('Admin');
      const first = await anItem('Already on Admin', { panelIds: [admin] });

      const said = await createItem(token, {
        message: 'Send Bart the quote with the figures from Monday',
        title: 'Quote for Bart',
        panels: ['admin'],
        priority: 'high',
        due_date: '2026-11-06',
      });

      expect(said.isError).toBeFalsy();
      expect(textOf(said)).toContain('Captured "Quote for Bart" on top of Dashboard 1 ▸ Admin in Workspace 1');
      const [created] = await onPanel(admin);
      expect(created).not.toBe(first);
      expect(await onPanel(admin)).toEqual([created, first]);
      expect(await read(created!)).toMatchObject({
        title: 'Quote for Bart',
        description: 'Send Bart the quote with the figures from Monday',
        priority: 'high',
        dueDate: '2026-11-06',
        workspaceDecided: true,
      });
    });

    it('starts it where the status says', async () => {
      const { token } = await connected();
      await createItem(token, { message: 'Started now', workspace: 'Workspace 1', status: 'in_progress' });

      const started = (await snapshot()).items.find((item) => item.capturedMessage === 'Started now')!;
      expect(itemStatus(started)).toBe('in_progress');
      expect(started.startedAt).not.toBeNull();
    });

    it('sets Waiting for reply with the days, due that many days on', async () => {
      const { token } = await connected();
      const said = await createItem(token, { message: 'Waiting on Bart', workspace: 'Workspace 1', status: 'waiting', days: 3 });

      expect(said.isError).toBeFalsy();
      const waiting = (await snapshot()).items.find((item) => item.capturedMessage === 'Waiting on Bart')!;
      expect(itemStatus(waiting)).toBe('waiting');
      const due = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
      expect(waiting.dueDate).toBe(due);
    });

    it.each([
      { situation: 'a Panel name that is refused', args: { panels: ['Garden'] }, says: '"Garden"' },
      { situation: 'a next action over 200 characters', args: { next_action: 'x'.repeat(201) }, says: 'next_action' },
    ])('captures nothing for $situation', async ({ args, says }) => {
      const { token } = await connected();
      await aPanel('Admin');

      const refused = await createItem(token, { message: 'Should not exist', workspace: 'Workspace 1', ...args });

      expect(refused.isError).toBe(true);
      expect(textOf(refused)).toContain(says);
      expect(textOf(await call(token, 'find_items', { text: 'Should not exist' }))).toBe('No item matches.');
    });

    it('proposes the title from the message as before when none is given', async () => {
      const { token } = await connected();
      const said = await createItem(token, { message: 'Ring the plumber about the boiler', workspace: 'Workspace 1' });

      expect(said.isError).toBeFalsy();
      const item = (await snapshot()).items.find((one) => one.capturedMessage === 'Ring the plumber about the boiler')!;
      expect(item.title).toBe('Ring the plumber about the boiler');
      expect(textOf(said)).toContain('in the Workspace 1 Inbox');
    });

    it('files an item with Panels and no workspace in the workspace of the Panels', async () => {
      await alsoWorkspaces();
      const { token } = await connected();

      const said = await createItem(token, { message: 'Garden hose', panels: ['Personal ▸ Dashboard 1 ▸ Panel 1'] });

      expect(said.isError).toBeFalsy();
      expect(await onPanel('ws-personal-panel-1', 'ws-personal')).toHaveLength(1);
      expect((await snapshot(WORKSPACE_ID)).items.some((item) => item.capturedMessage === 'Garden hose')).toBe(false);
    });
  });
});
