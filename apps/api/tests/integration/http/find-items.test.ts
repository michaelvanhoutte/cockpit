import { afterEach, beforeEach, describe, expect, inject, it, vi } from 'vitest';
import { SELF, applyD1Migrations, env } from 'cloudflare:test';
import {
  OTHER_ACCOUNT_NAME,
  OTHER_USER_ID,
  USER_ID,
  WORKSPACE_ID,
  alsoWorkspaces,
  asUser,
  seedRegister,
  startFromEmpty,
  withoutTheGuide,
} from '../seed.js';
import { ORIGIN, connected, mcp, type ToolAnswer } from '../mcp-app.js';

/**
 * Integration level, through the whole Worker as an app connected over MCP
 * enters it: what `find_items` finds in the account's own Items, across
 * workspaces and Panels, which of another account's it never finds, what it
 * says an Item is and where, the pages it is cut into, the limits it is held
 * to and the links it hands out ("Find items in Cockpit from a connected app,
 * over MCP", issue 1240). How the arguments are read and how a page is told
 * back is proved at L1 (tests/unit/mcp/find-items.test.ts); the rules the
 * Items are narrowed by are the shared package's (packages/shared/tests).
 *
 * **The Items are arranged through the commands API** the browser uses, and
 * each is given the time it last changed, so the order a page comes back in is
 * a fact the case states rather than one the clock decides.
 */

let sequence = 0;
const nextId = () => {
  sequence += 1;
  return `018f0000-0000-7000-8000-${String(sequence).padStart(12, '0')}`;
};
let minute = 0;
/** A later moment each time it is asked, a minute apart. */
const later = () => {
  minute += 1;
  return new Date(Date.UTC(2026, 9, 1, 8, minute)).toISOString();
};

/** The Panel of items the first workspace's first Dashboard is given. */
const WORKSPACE_ONE = 'Workspace 1';

async function command(name: string, payload: Record<string, unknown>, userId = USER_ID, workspaceId = WORKSPACE_ID) {
  const answer = await asUser(
    `${ORIGIN}/v1/commands/${name}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ commandId: nextId(), issuedAt: later(), workspaceId, ...payload }),
    },
    userId,
  );
  expect(answer.status, `${name}: ${await answer.clone().text()}`).toBe(200);
}

interface Arranged {
  message: string;
  workspaceId?: string;
  userId?: string;
  priority?: 'high' | 'normal' | 'low';
  dueDate?: string;
  /** The moment it was last changed, as the order of a page is read from it. */
  at?: string;
  /** Captured before anybody has said which workspace it belongs to, so it waits in every Inbox. */
  undecided?: boolean;
}

/** An Item captured the way the Capture page does, answering its id. */
async function anItem({ message, workspaceId = WORKSPACE_ID, userId = USER_ID, priority, dueDate, at, undecided }: Arranged): Promise<string> {
  const itemId = nextId();
  const body = {
    commandId: nextId(),
    issuedAt: at ?? later(),
    workspaceId,
    itemId,
    message,
    ...(priority ? { priority } : {}),
    ...(dueDate ? { dueDate } : {}),
    ...(undecided ? { workspaceDecided: false } : {}),
  };
  const answer = await asUser(
    `${ORIGIN}/v1/commands/capture_item`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
    userId,
  );
  expect(answer.status, await answer.clone().text()).toBe(200);
  return itemId;
}

/** A Panel of items (or a Filter panel) on a workspace's first Dashboard, answering its id. */
async function aPanel(name: string, workspaceId = WORKSPACE_ID, kind: 'items' | 'filter' = 'items', dashboardId = `${workspaceId}-dashboard-1`): Promise<string> {
  const panelId = nextId();
  await command('add_panel', { dashboardId, panelId, name, kind }, USER_ID, workspaceId);
  return panelId;
}

/** Items filed on a Panel, the whole of what it then holds being the order. */
async function fileOn(panelId: string, itemIds: readonly string[], workspaceId = WORKSPACE_ID): Promise<void> {
  const order: string[] = [];
  for (const itemId of itemIds) {
    order.unshift(itemId);
    await command('add_item_to_panel', { itemId, panelId, order: [...order] }, USER_ID, workspaceId);
  }
}

async function find(token: string, args: Record<string, unknown> = {}): Promise<ToolAnswer> {
  const answer = await mcp(token, 'tools/call', { name: 'find_items', arguments: args });
  expect(answer.status).toBe(200);
  return ((await answer.json()) as { result: ToolAnswer }).result;
}

/** What a successful find said. */
async function found(token: string, args: Record<string, unknown> = {}): Promise<string> {
  const said = await find(token, args);
  expect(said.isError, said.content[0]!.text).toBeFalsy();
  return said.content[0]!.text;
}

/** The titles a reply lists, in the order it lists them. */
const titlesIn = (text: string) => [...text.matchAll(/^\d+\. (.*)$/gm)].map((match) => match[1]!);

async function createItem(token: string, args: Record<string, unknown>): Promise<ToolAnswer> {
  const answer = await mcp(token, 'tools/call', { name: 'create_item', arguments: args });
  expect(answer.status).toBe(200);
  return ((await answer.json()) as { result: ToolAnswer }).result;
}

beforeEach(async () => {
  minute = 0;
  await applyD1Migrations(env.DB, inject('migrations'));
  await startFromEmpty();
  await seedRegister();
  await withoutTheGuide();
  await withoutTheGuide(OTHER_ACCOUNT_NAME);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('MCP connections', () => {
  describe('find_items finds the open Items whose title, description, next action or sender holds the text, ignoring case', () => {
    it('returns an Item with the text in its title', async () => {
      const { token } = await connected();
      await anItem({ message: 'Ring the plumber about the boiler' });
      await anItem({ message: 'Buy stamps' });

      expect(titlesIn(await found(token, { text: 'PLUMBER' }))).toEqual(['Ring the plumber about the boiler']);
    });

    it('returns an Item with the text in its sender only, which the Item’s own words never say', async () => {
      const { token } = await connected(USER_ID, 'Zorbulon Assistant');
      expect((await createItem(token, { message: 'Water the plants', workspace: WORKSPACE_ONE })).isError).toBeFalsy();
      await anItem({ message: 'Buy stamps' });

      expect(titlesIn(await found(token, { text: 'zorbulon' }))).toEqual(['Water the plants']);
    });

    it('says No item matches, and is no error, where the text is in no Item', async () => {
      const { token } = await connected();
      await anItem({ message: 'Buy stamps' });

      const said = await find(token, { text: 'submarine' });

      expect(said.isError).toBeFalsy();
      expect(said.content[0]!.text).toBe('No item matches.');
    });

    it('returns every open Item, newest change first, where no criterion is given', async () => {
      const { token } = await connected();
      const first = await anItem({ message: 'First captured', at: '2026-10-01T08:00:00.000Z' });
      await anItem({ message: 'Second captured', at: '2026-10-02T08:00:00.000Z' });
      await anItem({ message: 'Third captured', at: '2026-10-03T08:00:00.000Z' });
      // Changed last, so it comes first.
      await command('set_priority', { itemId: first, priority: 'low', issuedAt: '2026-10-04T08:00:00.000Z' });

      expect(titlesIn(await found(token))).toEqual(['First captured', 'Third captured', 'Second captured']);
    });
  });

  describe('every criterion given narrows the answer, and a name the account does not have is refused with the names there are', () => {
    it('finds only the Items of the workspace named, in any case', async () => {
      await alsoWorkspaces();
      const { token } = await connected();
      await anItem({ message: 'Quote for the pump', workspaceId: 'ws-atlas' });
      await anItem({ message: 'Quote for the garden' });

      expect(titlesIn(await found(token, { text: 'quote', workspace: 'ATLAS copco' }))).toEqual(['Quote for the pump']);
    });

    it('finds only the Items meeting workspace, priority and text together', async () => {
      await alsoWorkspaces();
      const { token } = await connected();
      await anItem({ message: 'Quote for the pump', workspaceId: 'ws-atlas', priority: 'high' });
      await anItem({ message: 'Quote for the valve', workspaceId: 'ws-atlas', priority: 'low' });
      await anItem({ message: 'Quote for the garden', priority: 'high' });
      await anItem({ message: 'Call the bank', workspaceId: 'ws-atlas', priority: 'high' });

      expect(titlesIn(await found(token, { text: 'quote', workspace: 'Atlas Copco', priority: 'High' }))).toEqual(['Quote for the pump']);
    });

    it('counts a due window from the day the app says is today, and from the UTC day when it says none', async () => {
      const { token } = await connected();
      await anItem({ message: 'Due on the 20th', dueDate: '2026-10-20' });
      await anItem({ message: 'Due next month', dueDate: '2026-11-25' });
      const utcToday = new Date().toISOString().slice(0, 10);
      await anItem({ message: 'Due today in UTC', dueDate: utcToday });

      expect(titlesIn(await found(token, { due: 'Today', today: '2026-10-20', or_overdue: false }))).toEqual(['Due on the 20th']);
      expect(titlesIn(await found(token, { due: 'Today', or_overdue: false }))).toEqual(['Due today in UTC']);
    });

    it('refuses a workspace nobody has, listing the workspaces', async () => {
      await alsoWorkspaces();
      const { token } = await connected();

      const said = await find(token, { workspace: 'Garden' });

      expect(said.isError).toBe(true);
      expect(said.content[0]!.text).toContain('"Workspace 1", "Atlas Copco", "Personal"');
    });
  });

  describe('only open Items are found, unless finished ones are asked for, and a dismissed one never is', () => {
    it('leaves out a done Item unless include_done is given, and then marks it Done', async () => {
      const { token } = await connected();
      const done = await anItem({ message: 'Sent the invoice' });
      await anItem({ message: 'Send the reminder' });
      await command('set_done', { itemId: done, done: true });

      expect(titlesIn(await found(token))).toEqual(['Send the reminder']);
      const all = await found(token, { include_done: true });
      expect(titlesIn(all)).toEqual(['Sent the invoice', 'Send the reminder']);
      expect(all).toContain('Status: Done');
    });

    it('never returns a dismissed Item, even when finished ones are asked for', async () => {
      const { token } = await connected();
      const gone = await anItem({ message: 'Thrown away' });
      await command('set_dismissed', { itemId: gone, dismissed: true });

      expect(await found(token, { include_done: true })).toBe('No item matches.');
      expect(await found(token, { text: 'thrown', include_done: true })).toBe('No item matches.');
    });
  });

  describe('a grant finds across every workspace of its own account and nothing of another’s', () => {
    it('returns matches in two workspaces when none is named', async () => {
      await alsoWorkspaces();
      const { token } = await connected();
      await anItem({ message: 'Pump quote' });
      await anItem({ message: 'Pump order', workspaceId: 'ws-atlas' });

      expect(titlesIn(await found(token, { text: 'pump' })).toSorted()).toEqual(['Pump order', 'Pump quote']);
    });

    it('never returns a matching Item of another account', async () => {
      const { token } = await connected();
      await anItem({ message: 'Pump quote' });
      await anItem({ message: 'Pump quote, secretly Ada’s', userId: OTHER_USER_ID });

      const said = await found(token, { text: 'pump' });

      expect(titlesIn(said)).toEqual(['Pump quote']);
      expect(said).not.toContain('Ada');
      // And the other way: Ada's app sees her own and none of Michael's.
      const ada = await connected(OTHER_USER_ID, 'Ada’s Claude');
      expect(titlesIn(await found(ada.token, { text: 'pump' }))).toEqual(['Pump quote, secretly Ada’s']);
    });
  });

  describe('only Items the screens show are found: those of a live workspace, and those waiting in every Inbox', () => {
    it('does not find an Item of a workspace that was deleted, when no workspace is named', async () => {
      await alsoWorkspaces();
      const { token } = await connected();
      await anItem({ message: 'Pump quote at Atlas', workspaceId: 'ws-atlas' });
      await anItem({ message: 'Pump quote at home' });
      await command('delete_workspace', {}, USER_ID, 'ws-atlas');

      expect(titlesIn(await found(token, { text: 'pump' }))).toEqual(['Pump quote at home']);
    });

    it('finds an Item captured from another workspace that nobody has placed, when this workspace is named', async () => {
      await alsoWorkspaces();
      const { token } = await connected();
      const waiting = await anItem({ message: 'Undecided pump quote', undecided: true });
      await anItem({ message: 'Decided pump quote', workspaceId: 'ws-personal' });

      const said = await found(token, { text: 'pump', workspace: 'Atlas Copco' });

      expect(titlesIn(said)).toEqual(['Undecided pump quote']);
      expect(said).toContain('Where: Inbox');
      // Opened in the workspace asked about, which is one the Item is offered in.
      expect(said).toContain(`Open: ${ORIGIN}/w/ws-atlas?item=${waiting}`);
    });
  });

  describe('each result says where the Item is', () => {
    it('names Workspace ▸ Dashboard ▸ Panel for each Panel an Item is filed on, and its link opens it', async () => {
      const { token } = await connected();
      const item = await anItem({ message: 'File me twice' });
      const calls = await aPanel('Calls');
      const admin = await aPanel('Admin');
      await fileOn(calls, [item]);
      await fileOn(admin, [item]);

      const said = await found(token, { text: 'twice' });

      expect(said).toMatch(/Where: Workspace 1 ▸ [^;]+ ▸ Calls; Workspace 1 ▸ [^;]+ ▸ Admin|Where: Workspace 1 ▸ [^;]+ ▸ Admin; Workspace 1 ▸ [^;]+ ▸ Calls/);
      expect(said).toContain(`Open: ${ORIGIN}/w/${WORKSPACE_ID}?item=${item}`);
    });

    it('says Inbox for an Item never filed', async () => {
      const { token } = await connected();
      await anItem({ message: 'Never filed' });

      expect(await found(token, { text: 'never filed' })).toContain('Where: Inbox');
    });
  });

  describe('Items come in pages of 25, newest change first, continued by a cursor that repeats and skips nothing', () => {
    it('gives 25, then more follow with a cursor, whose page gives the 26th and no cursor', async () => {
      const { token } = await connected();
      for (let n = 1; n <= 26; n += 1) {
        await anItem({ message: `Pump ${String(n).padStart(2, '0')}`, at: `2026-10-01T08:${String(n).padStart(2, '0')}:00.000Z` });
      }

      const first = await found(token, { text: 'pump' });
      expect(titlesIn(first)).toHaveLength(25);
      expect(titlesIn(first)[0]).toBe('Pump 26');
      expect(first).toContain('More follow');
      const cursor = /cursor "([^"]+)"/.exec(first)![1]!;

      const second = await found(token, { text: 'pump', cursor });
      expect(titlesIn(second)).toEqual(['Pump 01']);
      expect(second).not.toContain('More follow');
    });

    it('refuses a cursor Cockpit did not give, in words', async () => {
      const { token } = await connected();

      const said = await find(token, { cursor: 'not-a-cursor!' });

      expect(said).toMatchObject({ isError: true, content: [{ text: expect.stringContaining('cursor is not one Cockpit gave') }] });
    });
  });

  describe('a grant may find 10 times a minute, apart from the 60 captures it may make', () => {
    it('refuses the 11th find inside a minute, saying to wait', async () => {
      const { token } = await connected();
      for (let n = 1; n <= 10; n += 1) expect((await find(token)).isError, `find ${n}`).toBeFalsy();

      const eleventh = await find(token);

      expect(eleventh.isError).toBe(true);
      expect(eleventh.content[0]!.text).toContain('Wait a minute');
    });

    it('still answers a find after 60 captures in the minute', async () => {
      const { token } = await connected();
      for (let n = 1; n <= 60; n += 1) {
        expect((await createItem(token, { message: `Note ${n}`, workspace: WORKSPACE_ONE })).isError, `note ${n}`).toBeFalsy();
      }
      expect((await createItem(token, { message: 'Note 61', workspace: WORKSPACE_ONE })).isError).toBe(true);

      expect((await find(token, { text: 'note 60' })).isError).toBeFalsy();
    });

    it('counts each grant apart, so a second app is not refused for the first’s calls', async () => {
      const first = await connected(USER_ID, 'Claude');
      const second = await connected(USER_ID, 'Cowork');
      for (let n = 1; n <= 10; n += 1) await find(first.token);

      expect((await find(first.token)).isError).toBe(true);
      expect((await find(second.token)).isError).toBeFalsy();
    });
  });

  describe('find_items on a panel finds the Items filed on a Panel of that name, or gathered by a Filter panel of that name', () => {
    it('finds the Items filed on a Panel of items, and none that are not', async () => {
      const { token } = await connected();
      const one = await anItem({ message: 'On the Panel one' });
      const two = await anItem({ message: 'On the Panel two' });
      await anItem({ message: 'Left in the Inbox' });
      await fileOn(await aPanel('Calls'), [one, two]);

      expect(titlesIn(await found(token, { panel: 'calls' })).toSorted()).toEqual(['On the Panel one', 'On the Panel two']);
    });

    it('finds the Items a Filter panel gathers by priority, as the screen shows them', async () => {
      const { token } = await connected();
      const high = await anItem({ message: 'Filed and high', priority: 'high' });
      const low = await anItem({ message: 'Filed and low', priority: 'low' });
      await anItem({ message: 'High but unfiled', priority: 'high' });
      await fileOn(await aPanel('Calls'), [high, low]);
      const urgent = await aPanel('Urgent', WORKSPACE_ID, 'filter');
      await command('set_panel_filter', { panelId: urgent, rows: [[{ field: 'priority', values: ['high'] }]], groupBy: 'none' });

      // Filed on Calls and gathered by Urgent: a filter gathers only what is filed elsewhere, and only the High one.
      expect(titlesIn(await found(token, { panel: 'Urgent' }))).toEqual(['Filed and high']);
    });

    it('finds the Items of two Panels of the same name on different Dashboards', async () => {
      const { token } = await connected();
      const other = nextId();
      await command('add_dashboard', { dashboardId: other, panelId: nextId(), name: 'Second' });
      const one = await anItem({ message: 'On the first Calls' });
      const two = await anItem({ message: 'On the second Calls' });
      await fileOn(await aPanel('Calls'), [one]);
      await fileOn(await aPanel('Calls', WORKSPACE_ID, 'items', other), [two]);

      expect(titlesIn(await found(token, { panel: 'Calls' })).toSorted()).toEqual(['On the first Calls', 'On the second Calls']);
    });

    it('finds only the named workspace’s Panel of that name when workspace is given as well', async () => {
      await alsoWorkspaces();
      const { token } = await connected();
      const here = await anItem({ message: 'Calls here' });
      const there = await anItem({ message: 'Calls there', workspaceId: 'ws-atlas' });
      await fileOn(await aPanel('Calls'), [here]);
      await fileOn(await aPanel('Calls', 'ws-atlas'), [there], 'ws-atlas');

      expect(titlesIn(await found(token, { panel: 'Calls', workspace: 'Atlas Copco' }))).toEqual(['Calls there']);
    });

    it('refuses a Panel nobody has, listing the Panels there are', async () => {
      const { token } = await connected();
      await aPanel('Calls');

      const said = await find(token, { panel: 'Nowhere' });

      expect(said.isError).toBe(true);
      expect(said.content[0]!.text).toContain('"Calls"');
    });
  });

  describe('each result names its attachments with a link that opens the file without signing in', () => {
    const BYTES = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);

    async function attach(itemId: string, filename: string): Promise<string> {
      const attachmentId = nextId();
      const answer = await asUser(`${ORIGIN}/v1/items/${itemId}/attachments`, {
        method: 'POST',
        headers: {
          'content-type': 'image/png',
          'x-attachment-id': attachmentId,
          'x-command-id': nextId(),
          'x-issued-at': later(),
          'x-workspace-id': WORKSPACE_ID,
          'x-filename': filename,
        },
        body: BYTES,
      });
      expect(answer.status).toBe(201);
      return attachmentId;
    }

    it('gives an attachment’s name and a link that, fetched with no cookie, gives the file', async () => {
      const { token } = await connected();
      const item = await anItem({ message: 'A broken layout' });
      await attach(item, 'layout.png');

      const said = await found(token, { text: 'broken layout' });

      const link = /Files: layout\.png \((\S+)\)/.exec(said)?.[1];
      expect(link).toBeTruthy();
      const opened = await SELF.fetch(link!);
      expect(opened.status).toBe(200);
      expect(new Uint8Array(await opened.arrayBuffer())).toEqual(BYTES);
    });

    it('lists no attachments for an Item with none', async () => {
      const { token } = await connected();
      await anItem({ message: 'Nothing attached' });

      expect(await found(token, { text: 'nothing attached' })).not.toContain('Files:');
    });

    it('gives names only, no link, where the environment has no sealing key', async () => {
      const { token } = await connected();
      const item = await anItem({ message: 'A broken layout' });
      await attach(item, 'layout.png');
      const key = env.CONNECTOR_CREDENTIAL_KEY;
      env.CONNECTOR_CREDENTIAL_KEY = '';
      try {
        const said = await found(token, { text: 'broken layout' });
        expect(said).toContain('Files: layout.png');
        expect(said).not.toContain('attachment-links');
      } finally {
        if (key === undefined) delete (env as Partial<typeof env>).CONNECTOR_CREDENTIAL_KEY;
        else env.CONNECTOR_CREDENTIAL_KEY = key;
      }
    });
  });

  describe('an app is told what it can do', () => {
    it('lists find_items among its tools, naming this account’s workspaces and no other’s', async () => {
      await alsoWorkspaces();
      const { token } = await connected(USER_ID);
      const listed = await mcp(token, 'tools/list');
      const { tools } = ((await listed.json()) as { result: { tools: { name: string; description: string }[] } }).result;
      const tool = tools.find((one) => one.name === 'find_items');

      expect(tool?.description).toContain('"Atlas Copco"');

      const ada = await connected(OTHER_USER_ID, 'Ada’s Claude');
      const adas = ((await (await mcp(ada.token, 'tools/list')).json()) as { result: { tools: { name: string; description: string }[] } }).result.tools;
      expect(adas.find((one) => one.name === 'find_items')?.description).not.toContain('Atlas Copco');
    });
  });
});

