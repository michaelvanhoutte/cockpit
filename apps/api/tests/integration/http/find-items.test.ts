import { afterEach, beforeEach, describe, expect, inject, it, vi } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
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
import { ORIGIN, connected, mcp, type ToolAnswer } from '../mcp-app.js';

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
