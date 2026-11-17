import { afterEach, beforeEach, describe, expect, inject, it, vi } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import type { Filing, Item } from '@cockpit/shared';
import {
  DASHBOARD_ID,
  OTHER_ACCOUNT_NAME,
  OTHER_USER_ID,
  USER_ID,
  WORKSPACE_ID,
  accountOf,
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
 * Integration level, through the whole Worker: a connected app deleting an Item
 * and bringing it back ("MCP changes and deletes: add delete_item and
 * restore_item, dismissing as a swipe does", issue 1810). Every case enters the
 * way an app does, through `/mcp`, because whose Items may be touched and how
 * often are facts about the account's own store and the routing in front of it.
 * How the id is read and what the tools say is proved at L1
 * (tests/unit/mcp/delete-item.test.ts); the swipe's own rules, a Gmail label
 * included, are the command's (`set_dismissed`'s tests), which this calls.
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
      body: JSON.stringify({ commandId: nextId(), issuedAt: EARLIER, workspaceId: WORKSPACE_ID, ...body }),
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
async function snapshot(): Promise<{ items: Item[]; filings: Filing[] }> {
  const answer = await asUser(`${ORIGIN}/v1/workspaces/${WORKSPACE_ID}/snapshot`);
  return (await answer.json()) as { items: Item[]; filings: Filing[] };
}

const shown = async (itemId: string) => (await snapshot()).items.some((item) => item.id === itemId);

async function call(token: string, tool: string, args: Record<string, unknown>): Promise<ToolAnswer> {
  const answer = await mcp(token, 'tools/call', { name: tool, arguments: args });
  expect(answer.status).toBe(200);
  return ((await answer.json()) as { result: ToolAnswer }).result;
}

const deleteItem = (token: string, id: string) => call(token, 'delete_item', { id });
const restoreItem = (token: string, id: string) => call(token, 'restore_item', { id });
const textOf = (answer: ToolAnswer) => answer.content[0]!.text;

const dismissals = () =>
  inStoreAsItIs(accountOf(USER_ID), (sql) => sql.exec("SELECT count(*) AS n FROM commands WHERE name = 'set_dismissed'").one().n);

describe('MCP connections', () => {
  describe('deleting an item over MCP dismisses it as a swipe does, and restoring it brings it back where it was', () => {
    it('removes an open item filed on a panel from the panel and from find_items, naming its title and id', async () => {
      const { token } = await connected();
      const admin = await aPanel('Admin');
      const itemId = await anItem('Chase the invoice', { panelIds: [admin] });
      expect(await shown(itemId)).toBe(true);

      const deleted = await deleteItem(token, itemId);

      expect(deleted.isError).toBeFalsy();
      expect(textOf(deleted)).toContain('"Chase the invoice"');
      expect(textOf(deleted)).toContain(itemId);
      expect(await shown(itemId)).toBe(false);
      expect(textOf(await call(token, 'find_items', { panel: 'Admin' }))).toBe('No item matches.');
    });

    it('puts an item of the Inbox back in the Inbox once it is restored', async () => {
      const { token } = await connected();
      const itemId = await anItem('Ring the plumber');

      await deleteItem(token, itemId);
      expect(await shown(itemId)).toBe(false);
      const restored = await restoreItem(token, itemId);

      expect(restored.isError).toBeFalsy();
      expect(textOf(restored)).toContain(itemId);
      const { items, filings } = await snapshot();
      expect(items.map((item) => item.id)).toEqual([itemId]);
      expect(filings.filter((filing) => filing.itemId === itemId)).toEqual([]);
    });

    it('puts an item a swipe dismissed from a panel back on that panel, in its place', async () => {
      const { token } = await connected();
      const admin = await aPanel('Admin');
      const first = await anItem('First', { panelIds: [admin] });
      const second = await anItem('Second', { panelIds: [admin] });
      const filedBefore = (await snapshot()).filings.filter((filing) => filing.panelId === admin);
      expect(
        (await send('set_dismissed', { itemId: second, dismissed: true, issuedAt: SWIPED })).status,
      ).toBe(200);
      expect(await shown(second)).toBe(false);

      await restoreItem(token, second);

      expect((await snapshot()).filings.filter((filing) => filing.panelId === admin)).toEqual(filedBefore);
      expect(await shown(first)).toBe(true);
      expect(await shown(second)).toBe(true);
    });

    it.each([
      { situation: 'the link find_items gave', open: (found: string) => /Open it: (\S+)/.exec(found)![1]! },
      { situation: 'the bare id', open: (_found: string, itemId?: string) => itemId! },
    ])('dismisses the same item by $situation', async ({ open }) => {
      const { token } = await connected();
      const itemId = await anItem('Renew the passport');
      await anItem('Water the plants');
      const named = open(textOf(await call(token, 'find_items', { text: 'passport' })), itemId);

      const deleted = await deleteItem(token, named);

      expect(deleted.isError).toBeFalsy();
      expect(await shown(itemId)).toBe(false);
      expect((await snapshot()).items.map((item) => item.title)).toEqual(['Water the plants']);
    });
  });

  describe('an id names an item of this account, or the call is refused and nothing changes', () => {
    it('refuses an id no item has, and writes nothing', async () => {
      const { token } = await connected();
      const kept = await anItem('Keep me');

      const deleted = await deleteItem(token, nextId());

      expect(deleted.isError).toBe(true);
      expect(textOf(deleted)).toContain('There is no item with that id');
      expect(await dismissals()).toBe(0);
      expect(await shown(kept)).toBe(true);
    });

    it("refuses another account's item in the same words as one nobody has, for delete and restore alike", async () => {
      const { token } = await connected();
      const theirs = await anItem('Their secret', {}, OTHER_USER_ID);

      const nobodys = await deleteItem(token, nextId());
      const theirDelete = await deleteItem(token, theirs);
      const theirRestore = await restoreItem(token, theirs);

      expect([theirDelete.isError, theirRestore.isError]).toEqual([true, true]);
      expect(textOf(theirDelete)).toBe(textOf(nobodys));
      expect(textOf(theirRestore)).toBe(textOf(nobodys));
      const theirs2 = await asUser(`${ORIGIN}/v1/workspaces/${WORKSPACE_ID}/snapshot`, {}, OTHER_USER_ID);
      expect(((await theirs2.json()) as { items: Item[] }).items.map((item) => item.id)).toContain(theirs);
    });

    it.each([
      { situation: 'delete an item already dismissed', first: 'delete', again: 'delete', says: 'Already dismissed' },
      { situation: 'restore an item that is not dismissed', first: 'none', again: 'restore', says: 'Already open' },
    ])('answers $situation as done and writes nothing twice', async ({ first, again, says }) => {
      const { token } = await connected();
      const itemId = await anItem('Once is enough');
      if (first === 'delete') await deleteItem(token, itemId);
      const written = await dismissals();
      const changedAt = () =>
        inStoreAsItIs(accountOf(USER_ID), (sql) => sql.exec('SELECT updated_at FROM items WHERE id = ?', itemId).one().updated_at);
      const before = await changedAt();

      const answered = await (again === 'delete' ? deleteItem : restoreItem)(token, itemId);

      expect(answered.isError).toBeFalsy();
      expect(textOf(answered)).toContain(says);
      expect(await dismissals()).toBe(written);
      expect(await changedAt()).toBe(before);
    });
  });

  describe('delete and restore count against the 60 calls a minute an app shares with capture', () => {
    it('refuses the 61st call of a minute, mixing create_item and delete_item, and dismisses nothing for it', async () => {
      const { token } = await connected();
      const spared = await anItem('Spare me');
      for (let n = 1; n <= 30; n += 1) {
        expect((await call(token, 'create_item', { message: `Note ${n}`, workspace: 'Workspace 1' })).isError, `note ${n}`).toBeFalsy();
        expect((await deleteItem(token, nextId())).content[0]!.text, `delete ${n}`).toContain('There is no item');
      }

      const sixtyFirst = await deleteItem(token, spared);

      expect(sixtyFirst.isError).toBe(true);
      expect(textOf(sixtyFirst)).toContain('Too many');
      expect(await shown(spared)).toBe(true);
    });
  });
});
