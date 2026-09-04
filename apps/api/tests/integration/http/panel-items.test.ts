import { beforeEach, describe, expect, inject, it } from 'vitest';
import { applyD1Migrations, env } from 'cloudflare:test';
import { ACCOUNT_WIDE } from '@cockpit/shared';
import type { WorkspaceSnapshot } from '@cockpit/shared';
import { WORKSPACE_ID, asUser, inTheStore, seedRegister, startFromEmpty } from '../seed.js';

/**
 * Integration level, through the real Worker (`asUser`), because what a panel
 * holds and what the Inbox holds are two complementary queries over the same
 * rows - neither exists anywhere but against a real store. Which order a move
 * writes, and which orders are refused, are pure decisions settled in
 * apps/api/tests/unit/domain/filings.test.ts; what is asked here is the scope
 * they are applied in and what actually ends up stored.
 *
 * What these cases write survives into the next one, so every case makes its
 * own dashboard and panels rather than reusing a fixed pair.
 */

let seq = 0;
function nextId(): string {
  seq += 1;
  return `018f0000-0000-7000-8000-${String(seq).padStart(12, '0')}`;
}

const AT = '2026-09-01T10:00:00.000Z';

async function send(command: string, body: Record<string, unknown>) {
  return asUser(`http://cockpit.test/v1/commands/${command}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ commandId: nextId(), issuedAt: AT, ...body }),
  });
}

async function snapshot(workspaceId: string = WORKSPACE_ID): Promise<WorkspaceSnapshot> {
  const res = await asUser(`http://cockpit.test/v1/workspaces/${workspaceId}/snapshot`);
  expect(res.status).toBe(200);
  return (await res.json()) as WorkspaceSnapshot;
}

/**
 * The panels an item is filed on, by name — empty meaning it is in the Inbox,
 * which is the whole of what "in the Inbox" is.
 *
 * Read off the snapshot rather than the store, because the snapshot is what the
 * rule is about: it is the one answer both the Inbox and every panel are drawn
 * from.
 */
async function filedOn(itemId: string, workspaceId: string = WORKSPACE_ID): Promise<string[]> {
  const held = await snapshot(workspaceId);
  return held.filings
    .filter((filing) => filing.itemId === itemId)
    .map((filing) => held.panels.find((panel) => panel.id === filing.panelId)?.name ?? filing.panelId)
    .sort();
}

/** The items on one panel, in the order the panel would draw them. */
async function inOrderOn(panelId: string): Promise<string[]> {
  const held = await snapshot();
  return held.filings
    .filter((filing) => filing.panelId === panelId)
    .sort((a, b) => a.position - b.position)
    .map((filing) => held.items.find((item) => item.id === filing.itemId)?.title ?? filing.itemId);
}

async function aDashboard(workspaceId: string = WORKSPACE_ID): Promise<string> {
  const dashboardId = nextId();
  expect((await send('add_dashboard', { workspaceId, dashboardId, name: `Today ${seq}` })).status).toBe(200);
  return dashboardId;
}

async function aPanel(dashboardId: string, name: string, workspaceId = WORKSPACE_ID): Promise<string> {
  const panelId = nextId();
  expect((await send('add_panel', { workspaceId, dashboardId, panelId, name })).status).toBe(200);
  return panelId;
}

async function anItem(title: string, workspaceId: string = WORKSPACE_ID): Promise<string> {
  const itemId = nextId();
  expect((await send('capture_item', { workspaceId, itemId, title })).status).toBe(200);
  return itemId;
}

function move(
  itemId: string,
  panelId: string | null,
  order: string[] = panelId ? [itemId] : [],
  workspaceId: string = WORKSPACE_ID,
) {
  return send('move_item_to_panel', { workspaceId, itemId, panelId, order });
}

function addTo(itemId: string, panelId: string, order: string[] = [itemId]) {
  return send('add_item_to_panel', { workspaceId: WORKSPACE_ID, itemId, panelId, order });
}

function removeFrom(itemId: string, panelId: string) {
  return send('remove_item_from_panel', { workspaceId: WORKSPACE_ID, itemId, panelId });
}

/**
 * Files an item onto a panel by writing the row.
 *
 * Kept now that `add_item_to_panel` exists, and deliberately: the cases below
 * that are about *reading* two filings should not depend on the command that
 * writes the second one, or a fault in that command would be reported as a
 * fault in the read.
 */
async function alsoFileOn(panelId: string, itemId: string, position: number): Promise<void> {
  await inTheStore((sql) =>
    sql.exec(
      'INSERT INTO panel_items (tenant_id, panel_id, item_id, position, created_at) VALUES (?, ?, ?, ?, ?)',
      'tenant-default',
      panelId,
      itemId,
      position,
      AT,
    ),
  );
}

beforeEach(async () => {
  await applyD1Migrations(env.DB, inject('migrations'));
  await startFromEmpty();
  await seedRegister();
  seq = 0;
});

describe('Panels', () => {
  describe('a panel holds exactly the items filed into it, and an item filed nowhere is in the Inbox', () => {
    it.each([
      { situation: 'filed onto a panel from the Inbox', through: ['Falcon'], ends: ['Falcon'] },
      { situation: 'moved from one panel to another', through: ['Falcon', 'Anna'], ends: ['Anna'] },
      { situation: 'moved back to the Inbox', through: ['Falcon', null], ends: [] },
      {
        situation: 'filed onto a panel on another dashboard',
        through: ['To read'],
        ends: ['To read'],
      },
      {
        situation: 'moved to a panel on another dashboard and back',
        through: ['Falcon', 'To read', 'Falcon'],
        ends: ['Falcon'],
      },
    ])('$situation', async ({ through, ends }) => {
      const today = await aDashboard();
      const research = await aDashboard();
      const panels: Record<string, string> = {
        Falcon: await aPanel(today, 'Falcon'),
        Anna: await aPanel(today, 'Anna'),
        'To read': await aPanel(research, 'To read'),
      };
      const itemId = await anItem('Reply to Bart');

      for (const step of through) {
        expect((await move(itemId, step === null ? null : panels[step]!)).status).toBe(200);
      }

      expect(await filedOn(itemId)).toEqual(ends);
    });

    it('holds an item that is filed on two panels at once, and it is in neither Inbox nor one of them only', async () => {
      const today = await aDashboard();
      const falcon = await aPanel(today, 'Falcon');
      const anna = await aPanel(today, 'Anna');
      const itemId = await anItem('Reply to Bart');

      expect((await move(itemId, falcon)).status).toBe(200);
      await alsoFileOn(anna, itemId, 0);

      expect(await filedOn(itemId)).toEqual(['Anna', 'Falcon']);
    });

    it('gives an item back to the Inbox when the only panel holding it is deleted', async () => {
      const today = await aDashboard();
      const falcon = await aPanel(today, 'Falcon');
      const itemId = await anItem('Reply to Bart');
      expect((await move(itemId, falcon)).status).toBe(200);

      expect((await send('delete_panel', { workspaceId: WORKSPACE_ID, panelId: falcon })).status).toBe(200);

      expect(await filedOn(itemId)).toEqual([]);
    });

    it('leaves an item on its other panel when one of two is deleted', async () => {
      const today = await aDashboard();
      const falcon = await aPanel(today, 'Falcon');
      const anna = await aPanel(today, 'Anna');
      const itemId = await anItem('Reply to Bart');
      expect((await move(itemId, falcon)).status).toBe(200);
      await alsoFileOn(anna, itemId, 0);

      expect((await send('delete_panel', { workspaceId: WORKSPACE_ID, panelId: falcon })).status).toBe(200);

      expect(await filedOn(itemId)).toEqual(['Anna']);
    });

    it.each([
      {
        situation: 'added to a second panel while it is on the first',
        act: async (itemId: string, falcon: string, anna: string) => {
          await move(itemId, falcon);
          return addTo(itemId, anna);
        },
        ends: ['Anna', 'Falcon'],
      },
      {
        situation: 'removed from one of the two panels holding it',
        act: async (itemId: string, falcon: string, anna: string) => {
          await move(itemId, falcon);
          await addTo(itemId, anna);
          return removeFrom(itemId, falcon);
        },
        ends: ['Anna'],
      },
      {
        situation: 'removed from the only panel holding it',
        act: async (itemId: string, falcon: string) => {
          await move(itemId, falcon);
          return removeFrom(itemId, falcon);
        },
        ends: [],
      },
      {
        situation: 'added to a panel it is already on',
        act: async (itemId: string, falcon: string) => {
          await move(itemId, falcon);
          return addTo(itemId, falcon);
        },
        ends: ['Falcon'],
      },
    ])('$situation', async ({ act, ends }) => {
      const today = await aDashboard();
      const falcon = await aPanel(today, 'Falcon');
      const anna = await aPanel(today, 'Anna');
      const itemId = await anItem('Reply to Bart');

      expect((await act(itemId, falcon, anna)).status).toBe(200);

      expect(await filedOn(itemId)).toEqual(ends);
    });

    it('takes a dismissed item off every list it was on', async () => {
      const today = await aDashboard();
      const falcon = await aPanel(today, 'Falcon');
      const itemId = await anItem('Reply to Bart');
      expect((await move(itemId, falcon)).status).toBe(200);

      expect(
        (await send('set_dismissed', { workspaceId: WORKSPACE_ID, itemId, dismissed: true })).status,
      ).toBe(200);

      // Gone from the workspace's items, which is what both lists are drawn
      // from. Its filing stays, deliberately: nothing has erased the item, and
      // putting it back has to put it back where it was.
      expect((await snapshot()).items.map((item) => item.id)).not.toContain(itemId);
    });
  });

  describe('a panel keeps its items in the order the last move put them in', () => {
    it('files a new item where the order sent says, leaving the others in theirs', async () => {
      const today = await aDashboard();
      const falcon = await aPanel(today, 'Falcon');
      const first = await anItem('Renew the domain');
      const second = await anItem('Read the routing paper');
      const arriving = await anItem('Reply to Bart');

      expect((await move(first, falcon, [first])).status).toBe(200);
      expect((await move(second, falcon, [first, second])).status).toBe(200);
      expect((await move(arriving, falcon, [first, arriving, second])).status).toBe(200);

      expect(await inOrderOn(falcon)).toEqual([
        'Renew the domain',
        'Reply to Bart',
        'Read the routing paper',
      ]);
    });

    it('reorders a panel when an item it already holds is moved to it again', async () => {
      const today = await aDashboard();
      const falcon = await aPanel(today, 'Falcon');
      const first = await anItem('Renew the domain');
      const second = await anItem('Read the routing paper');
      expect((await move(first, falcon, [first])).status).toBe(200);
      expect((await move(second, falcon, [first, second])).status).toBe(200);

      expect((await move(second, falcon, [second, first])).status).toBe(200);

      expect(await inOrderOn(falcon)).toEqual(['Read the routing paper', 'Renew the domain']);
    });
  });

  describe('a move that names something that is not there is refused and nothing is stored', () => {
    it.each([
      {
        situation: 'a panel of another workspace',
        expected: 404,
        arrange: async (itemId: string) => {
          const elsewhere = await aDashboard('ws-personal');
          return { panelId: await aPanel(elsewhere, 'Somewhere else', 'ws-personal'), order: [itemId] };
        },
      },
      {
        situation: 'a panel that has been deleted',
        expected: 404,
        arrange: async (itemId: string) => {
          const today = await aDashboard();
          const panelId = await aPanel(today, 'Gone by lunchtime');
          await send('delete_panel', { workspaceId: WORKSPACE_ID, panelId });
          return { panelId, order: [itemId] };
        },
      },
      {
        situation: 'an order that leaves out an item the panel holds',
        expected: 409,
        arrange: async (itemId: string) => {
          const today = await aDashboard();
          const panelId = await aPanel(today, 'Falcon');
          const held = await anItem('Renew the domain');
          await move(held, panelId, [held]);
          return { panelId, order: [itemId] };
        },
      },
      {
        situation: 'an order naming an item that is not on the panel',
        expected: 409,
        arrange: async (itemId: string) => {
          const today = await aDashboard();
          const panelId = await aPanel(today, 'Falcon');
          const stranger = await anItem('Somewhere else entirely');
          return { panelId, order: [itemId, stranger] };
        },
      },
    ])('$situation', async ({ arrange, expected }) => {
      const itemId = await anItem('Reply to Bart');
      const { panelId, order } = await arrange(itemId);

      const refused = await move(itemId, panelId, order);

      expect(refused.status).toBe(expected);
      expect(await filedOn(itemId)).toEqual([]);
    });

    it('refuses a move of an item that does not exist, and files nothing', async () => {
      const today = await aDashboard();
      const falcon = await aPanel(today, 'Falcon');
      const neverReal = nextId();

      const refused = await move(neverReal, falcon, [neverReal]);

      expect(refused.status).toBe(404);
      expect((await snapshot()).filings).toEqual([]);
    });

    it.each([
      {
        situation: 'an add naming a panel that has been deleted',
        act: async (itemId: string, panelId: string) => {
          await send('delete_panel', { workspaceId: WORKSPACE_ID, panelId });
          return addTo(itemId, panelId);
        },
      },
      {
        situation: 'a remove naming a panel that has been deleted',
        act: async (itemId: string, panelId: string) => {
          await send('delete_panel', { workspaceId: WORKSPACE_ID, panelId });
          return removeFrom(itemId, panelId);
        },
      },
    ])('refuses $situation', async ({ act }) => {
      const today = await aDashboard();
      const panelId = await aPanel(today, 'Gone by lunchtime');
      const itemId = await anItem('Reply to Bart');

      expect((await act(itemId, panelId)).status).toBe(404);
      expect(await filedOn(itemId)).toEqual([]);
    });

    it('changes nothing when an item is removed from a panel it is not on', async () => {
      const today = await aDashboard();
      const falcon = await aPanel(today, 'Falcon');
      const anna = await aPanel(today, 'Anna');
      const itemId = await anItem('Reply to Bart');
      expect((await move(itemId, falcon)).status).toBe(200);

      // Accepted rather than refused: the answer asked for is that the panel is
      // not showing it, and it already is not.
      expect((await removeFrom(itemId, anna)).status).toBe(200);

      expect(await filedOn(itemId)).toEqual(['Falcon']);
    });

    it('refuses a move of an item that belongs to another workspace', async () => {
      const today = await aDashboard();
      const falcon = await aPanel(today, 'Falcon');
      const elsewhere = await anItem('Not this workspace’s', 'ws-personal');

      const refused = await move(elsewhere, falcon, [elsewhere]);

      expect(refused.status).toBe(404);
      expect((await snapshot()).filings).toEqual([]);
    });
  });

  describe('filing is keyed to the panel, not to its title', () => {
    it('keeps a renamed panel’s items on it', async () => {
      const today = await aDashboard();
      const falcon = await aPanel(today, 'Falcon');
      const itemId = await anItem('Reply to Bart');
      expect((await move(itemId, falcon)).status).toBe(200);

      expect((await send('rename_panel', { workspaceId: WORKSPACE_ID, panelId: falcon, name: 'Project Falcon' })).status).toBe(200);

      expect(await filedOn(itemId)).toEqual(['Project Falcon']);
    });
  });

  describe('a workspace never sees another workspace’s filing', () => {
    it('leaves another workspace’s items and panels out of both lists', async () => {
      const mine = await aDashboard();
      const falcon = await aPanel(mine, 'Falcon');
      const itemId = await anItem('Reply to Bart');
      expect((await move(itemId, falcon)).status).toBe(200);

      const theirs = await aDashboard('ws-personal');
      const shopping = await aPanel(theirs, 'Shopping', 'ws-personal');
      const theirItem = await anItem('Buy milk', 'ws-personal');
      expect((await move(theirItem, shopping, [theirItem], 'ws-personal')).status).toBe(200);

      expect(await filedOn(itemId)).toEqual(['Falcon']);
      expect(await filedOn(theirItem)).toEqual([]);
      expect(await filedOn(theirItem, 'ws-personal')).toEqual(['Shopping']);
    });
  });

  describe('the same change sent twice happens once', () => {
    it('files an item once when its move is replayed', async () => {
      const today = await aDashboard();
      const falcon = await aPanel(today, 'Falcon');
      const itemId = await anItem('Reply to Bart');
      const commandId = nextId();
      const body = {
        commandId,
        issuedAt: AT,
        workspaceId: WORKSPACE_ID,
        itemId,
        panelId: falcon,
        order: [itemId],
      };
      const once = async () =>
        asUser('http://cockpit.test/v1/commands/move_item_to_panel', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });

      expect(await (await once()).json()).toEqual({ ok: true, applied: true });
      expect(await (await once()).json()).toEqual({ ok: true, applied: false });

      expect((await snapshot()).filings.filter((filing) => filing.itemId === itemId)).toHaveLength(1);
    });
  });

  /**
   * A store binds 100 values per statement (architecture, "No statement's
   * parameter count grows with the data") and a filing row is five of them, so
   * filing onto a panel used to fail at twenty-one items - a panel a person
   * fills in an ordinary week. Thirty rather than twenty-one, so the case goes
   * on being about the limit if the batch size moves.
   */
  describe('a panel holds however many items are filed onto it', () => {
    it('keeps all thirty, in the order the move put them in', async () => {
      const dashboardId = await aDashboard();
      const panelId = await aPanel(dashboardId, 'Project Falcon');

      // One at a time, because an order must name exactly the panel's items
      // plus the one arriving - which is also what makes the last move the
      // widest statement: thirty rows of five values in a single insert.
      // Newest first, so an order that came back as the order they were
      // captured in would be visibly wrong rather than accidentally right.
      const wanted: string[] = [];
      const titles: string[] = [];
      for (let n = 0; n < 30; n += 1) {
        const itemId = await anItem(`Thing ${n}`);
        wanted.unshift(itemId);
        titles.unshift(`Thing ${n}`);
        expect((await move(itemId, panelId, wanted)).status).toBe(200);
      }

      expect(await inOrderOn(panelId)).toEqual(titles);
      // Thirty captures plus the move, against the workers pool - past the
      // default five seconds on requests alone.
    }, 30_000);
  });
});

/**
 * Integration level for the reason the panels above are: which items an Inbox
 * holds is a query, and one belonging to no workspace is in every Inbox at
 * once - which exists only against a real store with real workspaces in it.
 * Which workspace a settling gives an item, and that the first answer wins,
 * are pure decisions settled in apps/api/tests/unit/domain/items.test.ts.
 */
describe('Capture', () => {
  /** The titles in one workspace's Inbox: its open items filed on no panel. */
  async function inboxOf(workspaceId: string): Promise<string[]> {
    const held = await snapshot(workspaceId);
    const filed = new Set(held.filings.map((filing) => filing.itemId));
    return held.items
      .filter((item) => !filed.has(item.id) && item.completedAt === null)
      .map((item) => item.title)
      .sort();
  }

  async function anItemBelongingNowhere(title: string, from = WORKSPACE_ID): Promise<string> {
    const itemId = nextId();
    expect(
      (await send('capture_item', { workspaceId: from, itemId, title, workspaceDecided: false })).status,
    ).toBe(200);
    return itemId;
  }

  const EVERY_WORKSPACE = ['ws-work', 'ws-atlas', 'ws-personal'];

  describe('an item belonging to no workspace waits in every workspace’s Inbox', () => {
    it('is in the Inbox of the workspace it was captured from and of every other', async () => {
      await anItemBelongingNowhere('Where does this go');
      for (const workspaceId of EVERY_WORKSPACE) {
        expect(await inboxOf(workspaceId)).toContain('Where does this go');
      }
    });

    it('leaves an item captured into a workspace in that workspace alone', async () => {
      await anItem('Reply to Bart');
      expect(await inboxOf('ws-work')).toContain('Reply to Bart');
      expect(await inboxOf('ws-personal')).not.toContain('Reply to Bart');
    });

    it.each([
      { situation: 'finished with', command: 'set_done', body: { done: true } },
      { situation: 'dismissed', command: 'set_dismissed', body: { dismissed: true } },
    ])('is out of every Inbox once it is $situation', async ({ command, body }) => {
      const itemId = await anItemBelongingNowhere('Where does this go');
      // Asked from a workspace it does not belong to, which is every one.
      expect((await send(command, { workspaceId: 'ws-personal', itemId, ...body })).status).toBe(200);

      for (const workspaceId of EVERY_WORKSPACE) {
        expect(await inboxOf(workspaceId)).not.toContain('Where does this go');
      }
    });
  });

  describe('an item gets its workspace the first time somebody says where it belongs', () => {
    it('takes the workspace of the panel it is filed onto, and leaves every other Inbox', async () => {
      const itemId = await anItemBelongingNowhere('Where does this go');
      const elsewhere = await aDashboard('ws-personal');
      const panelId = await aPanel(elsewhere, 'Errands', 'ws-personal');

      expect(
        (await send('move_item_to_panel', { workspaceId: 'ws-personal', itemId, panelId, order: [itemId] }))
          .status,
      ).toBe(200);

      expect(await filedOn(itemId, 'ws-personal')).toEqual(['Errands']);
      expect(await inboxOf('ws-work')).not.toContain('Where does this go');
      expect(await inboxOf('ws-atlas')).not.toContain('Where does this go');
    });

    it.each([
      { situation: 'the workspace it was captured from', into: 'ws-work', gone: 'ws-personal' },
      { situation: 'another workspace entirely', into: 'ws-personal', gone: 'ws-work' },
    ])('takes $situation when its Inbox is chosen, and leaves the others', async ({ into, gone }) => {
      const itemId = await anItemBelongingNowhere('Where does this go');

      expect(
        (await send('move_item_to_panel', { workspaceId: into, itemId, panelId: null, order: [] })).status,
      ).toBe(200);

      expect(await inboxOf(into)).toContain('Where does this go');
      expect(await inboxOf(gone)).not.toContain('Where does this go');
    });

    it('stays where it was put, and is out of reach of the workspaces it left', async () => {
      const itemId = await anItemBelongingNowhere('Where does this go');
      expect(
        (await send('move_item_to_panel', { workspaceId: 'ws-personal', itemId, panelId: null, order: [] }))
          .status,
      ).toBe(200);
      // Asked from a workspace it no longer belongs to, which now names
      // nothing that workspace can reach.
      expect(
        (await send('move_item_to_panel', { workspaceId: 'ws-work', itemId, panelId: null, order: [] })).status,
      ).toBe(404);

      expect(await inboxOf('ws-personal')).toContain('Where does this go');
      expect(await inboxOf('ws-work')).not.toContain('Where does this go');
    });

    it('refuses a workspace that is not there rather than failing on the way in', async () => {
      const itemId = await anItemBelongingNowhere('Where does this go');
      expect(
        (await send('move_item_to_panel', { workspaceId: 'ws-nothing', itemId, panelId: null, order: [] }))
          .status,
      ).toBe(404);
      // Still everybody's, because nothing was decided.
      expect(await inboxOf('ws-work')).toContain('Where does this go');
      expect(await inboxOf('ws-personal')).toContain('Where does this go');
    });
  });

  /**
   * The stream derives what to invalidate from the command log's own workspace
   * column (accounts/events.ts), so a change every workspace can see has to be
   * logged as the account's rather than as one workspace's - otherwise a tab
   * open on another workspace never hears about it.
   */
  describe('a change every workspace can see is logged as the account’s', () => {
    const loggedWorkspaceFor = async (name: string) =>
      inTheStore((sql) =>
        sql
          .exec<{ workspace_id: string }>(
            'SELECT workspace_id FROM commands WHERE name = ? ORDER BY received_at DESC LIMIT 1',
            name,
          )
          .toArray(),
      );

    it('logs a capture with no workspace against the account, not the one it came from', async () => {
      await anItemBelongingNowhere('Where does this go');
      expect((await loggedWorkspaceFor('capture_item'))[0]?.workspace_id).toBe(ACCOUNT_WIDE);
    });

    it('logs the settling against the account too, because every other Inbox loses it', async () => {
      const itemId = await anItemBelongingNowhere('Where does this go');
      expect(
        (await send('move_item_to_panel', { workspaceId: 'ws-personal', itemId, panelId: null, order: [] }))
          .status,
      ).toBe(200);
      expect((await loggedWorkspaceFor('move_item_to_panel'))[0]?.workspace_id).toBe(ACCOUNT_WIDE);
    });

    it('logs an ordinary move against its own workspace, as it always did', async () => {
      const today = await aDashboard();
      const falcon = await aPanel(today, 'Falcon');
      const itemId = await anItem('Reply to Bart');
      expect(
        (
          await send('move_item_to_panel', {
            workspaceId: WORKSPACE_ID,
            itemId,
            panelId: falcon,
            order: [itemId],
          })
        ).status,
      ).toBe(200);
      expect((await loggedWorkspaceFor('move_item_to_panel'))[0]?.workspace_id).toBe(WORKSPACE_ID);
    });
  });
});
