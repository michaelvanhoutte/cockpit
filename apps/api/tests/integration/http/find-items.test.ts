import { afterEach, beforeEach, describe, expect, inject, it, vi } from 'vitest';
import { SELF, env, applyD1Migrations } from 'cloudflare:test';
import {
  DASHBOARD_ID,
  OTHER_USER_ID,
  USER_ID,
  WORKSPACE_ID,
  OTHER_ACCOUNT_NAME,
  accountOf,
  alsoWorkspaces,
  asUser,
  inStoreAsItIs,
  seedRegister,
  startFromEmpty,
  withoutTheGuide,
} from '../seed.js';
import { ORIGIN, connected, mcp } from './connected-apps.support.js';

interface ToolAnswer {
  isError?: boolean;
  content: { type: string; text: string }[];
}

/**
 * Integration level, through the whole Worker: a connected app finding items
 * ("Find items in Cockpit by text and condition, over MCP", issue 1242). Every
 * case enters the way an app does, through `/mcp`, because whose Items are read,
 * in what order, with where each is filed, and how often, are facts about the
 * account's own store and the routing in front of it. What the arguments come
 * to, how a page is told and how the limits count is proved at L1
 * (tests/unit/mcp/find-items.test.ts, tests/unit/domain/item-search.test.ts,
 * tests/unit/accounts/call-window.test.ts).
 */

beforeEach(async () => {
  await applyD1Migrations(env.DB, inject('migrations'));
  await startFromEmpty();
  await seedRegister();
  // Every account arrives with a guide of its own Items; these cases count only what they make.
  await withoutTheGuide();
  await withoutTheGuide(OTHER_ACCOUNT_NAME);
});

afterEach(() => {
  vi.useRealTimers();
});

let seq = 0;
function nextId(): string {
  seq += 1;
  return `018f0000-0000-7000-8000-${String(seq).padStart(12, '0')}`;
}

async function send(command: string, body: Record<string, unknown>, userId: string = USER_ID) {
  return asUser(
    `${ORIGIN}/v1/commands/${command}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ commandId: nextId(), issuedAt: new Date().toISOString(), workspaceId: WORKSPACE_ID, ...body }),
    },
    userId,
  );
}

/** An Item made the way the Capture page makes one, and where it is said to be changed. */
async function anItem(
  message: string,
  extra: Record<string, unknown> = {},
  userId: string = USER_ID,
  changedAt?: string,
): Promise<string> {
  const itemId = nextId();
  expect((await send('capture_item', { itemId, message, ...extra }, userId)).status).toBe(200);
  if (changedAt) await changedAtMoment(itemId, changedAt, userId);
  return itemId;
}

async function changedAtMoment(itemId: string, at: string, userId: string = USER_ID): Promise<void> {
  await inStoreAsItIs(accountOf(userId), (sql) => {
    sql.exec('UPDATE items SET updated_at = ? WHERE id = ?', at, itemId);
  });
}

async function aPanel(name: string, workspaceId = WORKSPACE_ID, dashboardId = DASHBOARD_ID): Promise<string> {
  const panelId = nextId();
  expect((await send('add_panel', { workspaceId, dashboardId, panelId, name, kind: 'items' })).status).toBe(200);
  return panelId;
}

async function findItems(token: string, args: Record<string, unknown> = {}): Promise<ToolAnswer> {
  const answer = await mcp(token, 'tools/call', { name: 'find_items', arguments: args });
  expect(answer.status).toBe(200);
  return ((await answer.json()) as { result: ToolAnswer }).result;
}

const textOf = (answer: ToolAnswer) => answer.content[0]!.text;

/** The titles in a reply, top to bottom. */
const titlesIn = (answer: ToolAnswer) => [...textOf(answer).matchAll(/^(.*)\nNext action: /gm)].map((found) => found[1]);

const cursorIn = (answer: ToolAnswer) => /cursor "([^"]+)"/.exec(textOf(answer))?.[1];

const AT = (second: number) => `2026-10-19T09:00:${String(second).padStart(2, '0')}.000Z`;

describe('MCP connections', () => {
  describe('an app finds the open items whose words hold the text, ignoring case', () => {
    it('returns an item with the text in its title, and no other', async () => {
      const { token } = await connected();
      await anItem('Renew the PASSPORT');
      await anItem('Water the plants');

      const found = await findItems(token, { text: 'passport' });

      expect(found.isError).toBeFalsy();
      expect(titlesIn(found)).toEqual(['Renew the PASSPORT']);
    });

    it('returns an item with the text in its sender alone, which is the app that captured it', async () => {
      const { token } = await connected(USER_ID, 'Pigeon Mail');
      const captured = await mcp(token, 'tools/call', { name: 'create_item', arguments: { message: 'Buy stamps' } });
      expect(captured.status).toBe(200);

      const found = await findItems(token, { text: 'pigeon' });

      expect(titlesIn(found)).toEqual(['Buy stamps']);
      expect(textOf(found)).toContain('Sender: Pigeon Mail');
    });

    it('says no item matches, and does not call it an error, where none does', async () => {
      const { token } = await connected();
      await anItem('Water the plants');

      const found = await findItems(token, { text: 'dentist' });

      expect(found.isError).toBeFalsy();
      expect(textOf(found)).toBe('No item matches.');
    });

    it('lists every open item, the most recently changed first, where it is given no criteria', async () => {
      const { token } = await connected();
      await anItem('Oldest', {}, USER_ID, AT(1));
      await anItem('Newest', {}, USER_ID, AT(30));
      await anItem('Middle', {}, USER_ID, AT(15));

      expect(titlesIn(await findItems(token))).toEqual(['Newest', 'Middle', 'Oldest']);
    });
  });

  describe('an app narrows its search with every criterion it gives', () => {
    it('finds only the items of the workspace it names, in any case', async () => {
      await alsoWorkspaces();
      const { token } = await connected();
      await anItem('Quote for Atlas', { workspaceId: 'ws-atlas' });
      await anItem('Quote for the plumber');

      expect(titlesIn(await findItems(token, { text: 'quote', workspace: 'atlas COPCO' }))).toEqual(['Quote for Atlas']);
      expect(titlesIn(await findItems(token, { text: 'quote', workspace: 'workspace 1' }))).toEqual(['Quote for the plumber']);
    });

    it('finds only the items meeting a workspace, a priority and a text together', async () => {
      await alsoWorkspaces();
      const { token } = await connected();
      await anItem('Pay the tax bill', { workspaceId: 'ws-atlas', priority: 'high' });
      await anItem('Pay the tax bill later', { workspaceId: 'ws-atlas', priority: 'low' });
      await anItem('Pay the tax bill at home', { priority: 'high' });
      await anItem('Pay the gas bill', { workspaceId: 'ws-atlas', priority: 'high' });

      const found = await findItems(token, { text: 'tax', workspace: 'Atlas Copco', priority: 'High' });

      expect(titlesIn(found)).toEqual(['Pay the tax bill']);
    });

    it('counts a due window from the day the app gives, and from the UTC day where it gives none', async () => {
      const { token } = await connected();
      const today = new Date().toISOString().slice(0, 10);
      const threeDaysOn = new Date(Date.parse(today) + 3 * 86_400_000).toISOString().slice(0, 10);
      await anItem('Due today in UTC', { dueDate: today });
      await anItem('Due in three days', { dueDate: threeDaysOn });

      const fromTheirDay = await findItems(token, { due: 'Today', or_overdue: false, today: threeDaysOn });
      const fromTheUtcDay = await findItems(token, { due: 'Today', or_overdue: false });

      expect(titlesIn(fromTheirDay)).toEqual(['Due in three days']);
      expect(titlesIn(fromTheUtcDay)).toEqual(['Due today in UTC']);
    });

    it('refuses a workspace there is none of, listing the ones there are', async () => {
      await alsoWorkspaces();
      const { token } = await connected();

      const said = await findItems(token, { workspace: 'Nowhere' });

      expect(said.isError).toBe(true);
      expect(textOf(said)).toContain('"Workspace 1", "Atlas Copco", "Personal"');
    });

    it('refuses an argument it does not have, naming it, rather than ignoring it', async () => {
      const { token } = await connected();
      await anItem('Anything');

      const said = await findItems(token, { text: 'anything', colour: 'red' });

      expect(said).toMatchObject({ isError: true, content: [{ text: expect.stringContaining('colour is not an argument') }] });
    });

    it('finds an item that belongs to no workspace yet in any workspace it names, as every Inbox shows it', async () => {
      await alsoWorkspaces();
      const { token } = await connected();
      await anItem('Undecided note', { workspaceDecided: false });

      expect(titlesIn(await findItems(token, { workspace: 'Personal' }))).toEqual(['Undecided note']);
      expect(titlesIn(await findItems(token))).toEqual(['Undecided note']);
    });

    it('does not find the items of a workspace that has been deleted', async () => {
      await alsoWorkspaces();
      const { token } = await connected();
      await anItem('Left in Atlas', { workspaceId: 'ws-atlas' });
      await anItem('Still here');
      expect((await send('delete_workspace', { workspaceId: 'ws-atlas' })).status).toBe(200);

      expect(titlesIn(await findItems(token))).toEqual(['Still here']);
    });
  });

  describe('an app finds open items only, unless it asks for the finished, and never a dismissed one', () => {
    async function aFinishedAndADismissed() {
      const done = await anItem('Finished errand');
      const dismissed = await anItem('Dismissed errand');
      await anItem('Open errand');
      expect((await send('set_done', { itemId: done, done: true })).status).toBe(200);
      expect((await send('set_dismissed', { itemId: dismissed, dismissed: true })).status).toBe(200);
    }

    it('leaves a finished item out unless include_done is true, and then marks it Done', async () => {
      const { token } = await connected();
      await aFinishedAndADismissed();

      const open = await findItems(token, { text: 'errand' });
      const withDone = await findItems(token, { text: 'errand', include_done: true });

      expect(titlesIn(open)).toEqual(['Open errand']);
      expect(titlesIn(withDone).toSorted()).toEqual(['Finished errand', 'Open errand']);
      expect(textOf(withDone)).toMatch(/Finished errand\nNext action: none\nStatus: Done/);
    });

    it('does not return a dismissed item even when include_done is true', async () => {
      const { token } = await connected();
      await aFinishedAndADismissed();

      expect(titlesIn(await findItems(token, { text: 'dismissed', include_done: true }))).toEqual([]);
    });
  });

  describe('an app finds across every workspace of its own account and nothing of another’s', () => {
    it('returns matches from two workspaces where none is named', async () => {
      await alsoWorkspaces();
      const { token } = await connected();
      await anItem('Passport photos', { workspaceId: 'ws-atlas' }, USER_ID, AT(5));
      await anItem('Passport renewal', {}, USER_ID, AT(9));

      expect(titlesIn(await findItems(token, { text: 'passport' }))).toEqual(['Passport renewal', 'Passport photos']);
    });

    it('never returns a matching item of another account', async () => {
      const { token } = await connected(USER_ID);
      await anItem('Passport renewal');
      await anItem('Passport renewal, Ada’s', {}, OTHER_USER_ID);

      const mine = await findItems(token, { text: 'passport' });
      const theirs = await findItems((await connected(OTHER_USER_ID)).token, { text: 'passport' });

      expect(titlesIn(mine)).toEqual(['Passport renewal']);
      expect(titlesIn(theirs)).toEqual(['Passport renewal, Ada’s']);
    });
  });

  describe('an app finds the items on a panel by its name', () => {
    async function aDashboardCalled(name: string, workspaceId = WORKSPACE_ID): Promise<string> {
      const dashboardId = nextId();
      expect((await send('add_dashboard', { workspaceId, dashboardId, panelId: nextId(), name })).status).toBe(200);
      return dashboardId;
    }

    /** A Filter panel gathering the filed items of a priority. */
    async function aFilterOfPriority(name: string, priority: string, workspaceId = WORKSPACE_ID): Promise<string> {
      const panelId = nextId();
      expect((await send('add_panel', { workspaceId, dashboardId: DASHBOARD_ID, panelId, name, kind: 'filter' })).status).toBe(200);
      const rows = [[{ field: 'priority', values: [priority] }]];
      expect((await send('set_panel_filter', { workspaceId, panelId, rows })).status).toBe(200);
      return panelId;
    }

    it('returns the items filed on a panel of that name and no others', async () => {
      const { token } = await connected();
      const admin = await aPanel('Admin');
      const waiting = await aPanel('Waiting');
      await anItem('Chase the invoice', { panelIds: [admin] });
      await anItem('Pay the tax', { panelIds: [admin, waiting] });
      await anItem('Call the plumber', { panelIds: [waiting] });
      await anItem('Water the plants');

      const found = await findItems(token, { panel: 'admin' });

      expect(titlesIn(found).toSorted()).toEqual(['Chase the invoice', 'Pay the tax']);
    });

    it('returns the filed items a Filter panel of that name gathers, as the screen shows them', async () => {
      const { token } = await connected();
      const admin = await aPanel('Admin');
      await aFilterOfPriority('Hot', 'high');
      await anItem('Filed and high', { panelIds: [admin], priority: 'high' });
      await anItem('Filed and low', { panelIds: [admin], priority: 'low' });
      await anItem('High but never filed', { priority: 'high' });

      const found = await findItems(token, { panel: 'Hot' });

      expect(titlesIn(found)).toEqual(['Filed and high']);
      expect(textOf(found)).toContain('Where: Workspace 1 ▸ Dashboard 1 ▸ Admin');
    });

    it('returns the items of two panels going by the name on different dashboards', async () => {
      const { token } = await connected();
      const first = await aPanel('Admin');
      const second = nextId();
      const dashboardId = await aDashboardCalled('Later');
      expect((await send('add_panel', { dashboardId, panelId: second, name: 'Admin', kind: 'items' })).status).toBe(200);
      await anItem('On the first', { panelIds: [first] });
      await anItem('On the second', { panelIds: [second] });
      await anItem('On neither');

      expect(titlesIn(await findItems(token, { panel: 'Admin' })).toSorted()).toEqual(['On the first', 'On the second']);
    });

    it('returns the items of the panel in the workspace it is given with, and the panels of every workspace without one', async () => {
      await alsoWorkspaces();
      const { token } = await connected();
      const here = await aPanel('Admin');
      const there = await aPanel('Admin', 'ws-atlas', 'ws-atlas-dashboard-1');
      await anItem('Admin here', { panelIds: [here] });
      await anItem('Admin there', { workspaceId: 'ws-atlas', panelIds: [there] });
      await anItem('Atlas inbox', { workspaceId: 'ws-atlas' });
      await anItem('Workspace 1 inbox');

      expect(titlesIn(await findItems(token, { panel: 'Admin', workspace: 'Atlas Copco' }))).toEqual(['Admin there']);
      expect(titlesIn(await findItems(token, { panel: 'Admin', workspace: 'Workspace 1' }))).toEqual(['Admin here']);
      expect(titlesIn(await findItems(token, { panel: 'Admin' })).toSorted()).toEqual(['Admin here', 'Admin there']);
    });

    it('narrows the items on a panel by every other criterion given', async () => {
      const { token } = await connected();
      const admin = await aPanel('Admin');
      await anItem('Pay the tax', { panelIds: [admin], priority: 'high' });
      await anItem('Pay the gas', { panelIds: [admin], priority: 'low' });
      await anItem('Pay the rent', { priority: 'high' });

      const found = await findItems(token, { panel: 'Admin', text: 'pay', priority: 'High' });

      expect(titlesIn(found)).toEqual(['Pay the tax']);
    });

    it('gives the items on a panel 25 at a time, continued by a cursor, without those on other panels', async () => {
      const { token } = await connected();
      const admin = await aPanel('Admin');
      const waiting = await aPanel('Waiting');
      for (let n = 0; n < 26; n += 1) await anItem(`Errand ${String(n).padStart(2, '0')}`, { panelIds: [admin] }, USER_ID, AT(n));
      await anItem('Errand elsewhere', { panelIds: [waiting] }, USER_ID, AT(30));

      const first = await findItems(token, { panel: 'Admin' });
      const second = await findItems(token, { panel: 'Admin', cursor: cursorIn(first) });

      expect(titlesIn(first)).toHaveLength(25);
      expect(titlesIn(first)[0]).toBe('Errand 25');
      expect(titlesIn(second)).toEqual(['Errand 00']);
      expect(cursorIn(second)).toBeUndefined();
    });

    it('counts a Filter panel’s due window from the day the app gives', async () => {
      const { token } = await connected();
      const admin = await aPanel('Admin');
      const filterId = nextId();
      expect((await send('add_panel', { dashboardId: DASHBOARD_ID, panelId: filterId, name: 'Due today', kind: 'filter' })).status).toBe(200);
      const rows = [[{ field: 'dueDate', window: 'today', orOverdue: false }]];
      expect((await send('set_panel_filter', { workspaceId: WORKSPACE_ID, panelId: filterId, rows })).status).toBe(200);
      await anItem('Due on the 3rd', { panelIds: [admin], dueDate: '2030-01-03' });
      await anItem('Due on the 4th', { panelIds: [admin], dueDate: '2030-01-04' });

      expect(titlesIn(await findItems(token, { panel: 'Due today', today: '2030-01-03' }))).toEqual(['Due on the 3rd']);
      expect(titlesIn(await findItems(token, { panel: 'Due today', today: '2030-01-04' }))).toEqual(['Due on the 4th']);
    });

    it('does not return a finished item filed on the panel, even where finished items are asked for', async () => {
      const { token } = await connected();
      const admin = await aPanel('Admin');
      await anItem('Still to do', { panelIds: [admin] });
      const finished = await anItem('Already done', { panelIds: [admin] });
      expect((await send('set_done', { itemId: finished, done: true })).status).toBe(200);

      expect(titlesIn(await findItems(token, { panel: 'Admin', include_done: true }))).toEqual(['Still to do']);
    });

    it('never returns the items on another account’s panel of the name', async () => {
      const { token } = await connected(USER_ID);
      const mine = await aPanel('Admin');
      await anItem('My invoice', { panelIds: [mine] });
      const ada = await asUser(`${ORIGIN}/v1/commands/add_panel`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ commandId: nextId(), issuedAt: new Date().toISOString(), workspaceId: WORKSPACE_ID, dashboardId: DASHBOARD_ID, panelId: nextId(), name: 'Admin', kind: 'items' }),
      }, OTHER_USER_ID);
      expect(ada.status).toBe(200);

      expect(titlesIn(await findItems(token, { panel: 'Admin' }))).toEqual(['My invoice']);
    });
  });

  describe('an app is refused a panel nobody has, and told the names there are', () => {
    it('lists the panels there are, in the workspace named or in all of them', async () => {
      await alsoWorkspaces();
      const { token } = await connected();
      await aPanel('Admin');
      await aPanel('Waiting', 'ws-atlas', 'ws-atlas-dashboard-1');

      const everywhere = await findItems(token, { panel: 'Garden' });
      const inAtlas = await findItems(token, { panel: 'Garden', workspace: 'Atlas Copco' });

      expect(everywhere.isError).toBe(true);
      expect(textOf(everywhere)).toContain('No panel is called "Garden"');
      expect(textOf(everywhere)).toContain('"Admin"');
      expect(textOf(everywhere)).toContain('"Waiting"');
      expect(textOf(inAtlas)).toContain('in the workspace "Atlas Copco"');
      expect(textOf(inAtlas)).toContain('"Waiting"');
      expect(textOf(inAtlas)).not.toContain('"Admin"');
    });

    it('finds no panel of a workspace that has been deleted', async () => {
      await alsoWorkspaces();
      const { token } = await connected();
      const there = await aPanel('Admin', 'ws-atlas', 'ws-atlas-dashboard-1');
      await anItem('Left in Atlas', { workspaceId: 'ws-atlas', panelIds: [there] });
      expect((await send('delete_workspace', { workspaceId: 'ws-atlas' })).status).toBe(200);

      const said = await findItems(token, { panel: 'Admin' });

      expect(said.isError).toBe(true);
      expect(textOf(said)).toContain('No panel is called "Admin"');
    });
  });

  describe('an app is told where each item is', () => {
    it('names each panel an item is filed on, as the workspace, the dashboard and the panel', async () => {
      const { token } = await connected();
      const admin = await aPanel('Admin');
      const waiting = await aPanel('Waiting');
      await anItem('Chase the invoice', { panelIds: [admin, waiting] });

      const found = await findItems(token, { text: 'invoice' });

      expect(textOf(found)).toContain('Where: Workspace 1 ▸ Dashboard 1 ▸ Admin; Workspace 1 ▸ Dashboard 1 ▸ Waiting');
    });

    it('names an item never filed as in the Inbox', async () => {
      const { token } = await connected();
      await anItem('Chase the invoice');

      expect(textOf(await findItems(token, { text: 'invoice' }))).toContain('Where: Workspace 1 ▸ Inbox');
    });

    it('names a finished item by where it was filed', async () => {
      const { token } = await connected();
      const admin = await aPanel('Admin');
      const itemId = await anItem('Chase the invoice', { panelIds: [admin] });
      expect((await send('set_done', { itemId, done: true })).status).toBe(200);

      const found = await findItems(token, { text: 'invoice', include_done: true });

      expect(textOf(found)).toContain('Where: Workspace 1 ▸ Dashboard 1 ▸ Admin');
    });

    it('opens the item through a link to its workspace, and gives the description whole', async () => {
      const { token } = await connected();
      const long = `${'A long description goes on and on. '.repeat(200)}The very end.`;
      const itemId = await anItem(long, { title: 'A long one' });

      const said = textOf(await findItems(token, { text: 'long one' }));

      expect(said).toContain(`${ORIGIN}/w/${WORKSPACE_ID}?item=${itemId}`);
      expect(said).toContain('The very end.');
    });
  });

  describe('an app is given pages of 25, continued by a cursor that repeats and skips nothing', () => {
    it('gives 25 and then a cursor, which gives the 26th and no cursor', async () => {
      const { token } = await connected();
      for (let n = 0; n < 26; n += 1) await anItem(`Errand ${String(n).padStart(2, '0')}`, {}, USER_ID, AT(n));

      const first = await findItems(token, { text: 'errand' });
      const second = await findItems(token, { text: 'errand', cursor: cursorIn(first) });

      expect(titlesIn(first)).toHaveLength(25);
      expect(titlesIn(first)[0]).toBe('Errand 25');
      expect(textOf(first)).toContain('More follow');
      expect(titlesIn(second)).toEqual(['Errand 00']);
      expect(textOf(second)).not.toContain('More follow');
      expect(cursorIn(second)).toBeUndefined();
    });

    it('refuses a cursor Cockpit did not give, in words', async () => {
      const { token } = await connected();

      const said = await findItems(token, { cursor: 'page two' });

      expect(said).toMatchObject({ isError: true, content: [{ text: expect.stringContaining('cursor is not one Cockpit gave') }] });
    });
  });

  describe('an app may find 10 times a minute, apart from its captures', () => {
    it('refuses the 11th in a minute saying to wait, and admits the next minute', async () => {
      const { token } = await connected();
      for (let n = 1; n <= 10; n += 1) expect((await findItems(token)).isError, `find ${n}`).toBeFalsy();

      const eleventh = await findItems(token);
      expect(eleventh.isError).toBe(true);
      expect(textOf(eleventh)).toContain('Wait a minute');

      vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 61_000 });
      expect((await findItems(token)).isError).toBeFalsy();
    });

    it('still captures once the finds are spent, and still finds once the captures are', async () => {
      const { token } = await connected();
      for (let n = 1; n <= 11; n += 1) await findItems(token);

      const captured = await mcp(token, 'tools/call', { name: 'create_item', arguments: { message: 'Still captures' } });
      expect(((await captured.json()) as { result: ToolAnswer }).result.isError).toBeFalsy();

      const { token: another } = await connected(USER_ID, 'Another app');
      for (let n = 1; n <= 61; n += 1) {
        await mcp(another, 'tools/call', { name: 'create_item', arguments: { message: `Note ${n}` } });
      }
      expect((await findItems(another)).isError).toBeFalsy();
    });

    it('counts each app’s grant apart', async () => {
      const { token } = await connected(USER_ID, 'One');
      const { token: other } = await connected(USER_ID, 'Two');
      for (let n = 1; n <= 11; n += 1) await findItems(token);

      expect((await findItems(token)).isError).toBe(true);
      expect((await findItems(other)).isError).toBeFalsy();
    });
  });

  describe('an app is given the files of the items it finds, by name and by a link that opens each without signing in', () => {
    const BYTES = new Uint8Array([137, 80, 78, 71, 7, 8, 9]);

    async function attach(itemId: string, filename: string): Promise<string> {
      const attachmentId = nextId();
      const uploaded = await asUser(
        `${ORIGIN}/v1/items/${itemId}/attachments`,
        {
          method: 'POST',
          headers: {
            'content-type': 'image/png',
            'x-attachment-id': attachmentId,
            'x-command-id': nextId(),
            'x-issued-at': new Date().toISOString(),
            'x-workspace-id': WORKSPACE_ID,
            'x-filename': filename,
          },
          body: BYTES,
        },
      );
      expect(uploaded.status).toBe(201);
      return attachmentId;
    }

    /** The addresses a reply gives for files, by file name. */
    const linksIn = (answer: ToolAnswer) =>
      Object.fromEntries([...textOf(answer).matchAll(/^- (.*?): (https?:\/\/\S+)$/gm)].map((found) => [found[1], found[2]]));

    it('names a file and gives a link that, fetched with no cookie, gives the file', async () => {
      const { token } = await connected();
      const itemId = await anItem('A broken layout');
      await attach(itemId, 'layout.png');

      const found = await findItems(token);

      const link = linksIn(found)['layout.png'];
      expect(link).toBeDefined();
      const opened = await SELF.fetch(link!);
      expect(opened.status).toBe(200);
      expect(new Uint8Array(await opened.arrayBuffer())).toEqual(BYTES);
    });

    it('names every file of an item, oldest first, and gives each its own link', async () => {
      const { token } = await connected();
      const itemId = await anItem('Two pictures');
      await attach(itemId, 'first.png');
      await attach(itemId, 'second.png');

      const found = await findItems(token);

      expect(Object.keys(linksIn(found))).toEqual(['first.png', 'second.png']);
      expect(new Set(Object.values(linksIn(found))).size).toBe(2);
    });

    it('lists no attachments for an item with none, whatever the item beside it has', async () => {
      const { token } = await connected();
      await anItem('Bare', {}, USER_ID, AT(1));
      await attach(await anItem('With a file', {}, USER_ID, AT(2)), 'layout.png');

      const found = await findItems(token);

      const [withFile, bare] = textOf(found).split('\n\n---\n\n');
      expect(withFile).toContain('Attachments:\n- layout.png: ');
      expect(bare).toContain('Attachments: none');
    });

    it('gives the names alone where the environment has no key to seal links with', async () => {
      const { token } = await connected();
      await attach(await anItem('A broken layout'), 'layout.png');
      const key = env.CONNECTOR_CREDENTIAL_KEY;
      env.CONNECTOR_CREDENTIAL_KEY = '';
      try {
        const found = await findItems(token);

        expect(found.isError).toBeFalsy();
        expect(textOf(found)).toContain('Attachments:\n- layout.png\nDescription:');
        expect(textOf(found)).not.toContain('/v1/attachment-links/');
      } finally {
        env.CONNECTOR_CREDENTIAL_KEY = key ?? '';
      }
    });

    it('gives the files of the items on a panel, found by its name', async () => {
      const { token } = await connected();
      const admin = await aPanel('Admin');
      await attach(await anItem('Chase the invoice', { panelIds: [admin] }), 'invoice.png');
      await attach(await anItem('Not on the panel'), 'elsewhere.png');

      const found = await findItems(token, { panel: 'Admin' });

      expect(Object.keys(linksIn(found))).toEqual(['invoice.png']);
      expect(textOf(found)).not.toContain('elsewhere.png');
    });

    it('names and links the files of the 25 items on a page and no others', async () => {
      const { token } = await connected();
      for (let n = 1; n < 26; n += 1) await anItem(`Errand ${String(n).padStart(2, '0')}`, {}, USER_ID, AT(n));
      await attach(await anItem('Errand 00', {}, USER_ID, AT(0)), 'second-page.png');
      await attach(await anItem('Errand 26', {}, USER_ID, AT(26)), 'first-page.png');

      const first = await findItems(token);
      const second = await findItems(token, { cursor: cursorIn(first) });

      expect(Object.keys(linksIn(first))).toEqual(['first-page.png']);
      expect(textOf(first)).not.toContain('second-page.png');
      expect(Object.keys(linksIn(second))).toEqual(['second-page.png']);
    });
  });

  describe('an app is told what it can do', () => {
    it('lists find_items naming this account’s workspaces and no other account’s', async () => {
      await alsoWorkspaces();
      const asked = await mcp((await connected(OTHER_USER_ID)).token, 'tools/list');
      const { tools } = ((await asked.json()) as { result: { tools: { name: string; description: string }[] } }).result;
      const mineAsked = await mcp((await connected(USER_ID)).token, 'tools/list');
      const mine = ((await mineAsked.json()) as { result: { tools: { name: string; description: string }[] } }).result.tools;

      expect(tools.find((tool) => tool.name === 'find_items')?.description).not.toContain('Atlas Copco');
      expect(mine.find((tool) => tool.name === 'find_items')?.description).toContain('"Atlas Copco"');
    });

    it('says in its instructions when to use find_items', async () => {
      const { token } = await connected();

      const answer = await mcp(token, 'initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'Claude', version: '1' },
      });

      const { result } = (await answer.json()) as { result: { instructions: string } };
      expect(result.instructions).toContain('Use find_items when the user asks what is in Cockpit');
    });
  });
});
