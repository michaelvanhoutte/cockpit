import { beforeEach, describe, expect, inject, it } from 'vitest';
import { applyD1Migrations, env } from 'cloudflare:test';
import { filingsThatFile, itemsInTheInbox, type WorkspaceSnapshot } from '@cockpit/shared';
import { ACCOUNT_NAME, DASHBOARD_ID, WORKSPACE_ID, asUser, inTheStore, seedRegister, startFromEmpty, storeNamed, withoutTheGuide } from '../seed.js';

/**
 * Integration level, through the real Worker: "Brainstorming: related loose
 * notes can't be brought together" (issue 1826). A Merge moves rows between an
 * Item, its words, its files and its places in one transaction, and Undo
 * reverses them in another, so each holds only against a real store; the
 * dialog that sends them is the browser's (ItemList.test.tsx).
 */

beforeEach(async () => {
  await applyD1Migrations(env.DB, inject('migrations'));
  await startFromEmpty();
  await seedRegister();
  await withoutTheGuide();
});

let seq = 0;
function nextId(): string {
  seq += 1;
  return `018f0000-0000-7000-8000-${String(seq).padStart(12, '0')}`;
}

async function send(command: string, body: Record<string, unknown>) {
  return asUser(`http://cockpit.test/v1/commands/${command}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ commandId: nextId(), issuedAt: '2026-11-19T10:00:00.000Z', workspaceId: WORKSPACE_ID, ...body }),
  });
}

async function aNote(message: string): Promise<string> {
  const itemId = nextId();
  expect((await send('capture_item', { itemId, message })).status).toBe(200);
  return itemId;
}

async function aPanel(name: string): Promise<string> {
  const panelId = nextId();
  expect((await send('add_panel', { dashboardId: DASHBOARD_ID, panelId, name, kind: 'items' })).status).toBe(200);
  return panelId;
}

async function file(itemId: string, panelId: string) {
  const order = await inTheStore((sql) =>
    sql.exec<{ item_id: string }>('SELECT item_id FROM panel_items WHERE panel_id = ? ORDER BY position', panelId).toArray().map((row) => row.item_id),
  );
  expect((await send('add_item_to_panel', { itemId, panelId, order: [itemId, ...order] })).status).toBe(200);
}

async function attach(itemId: string, filename: string) {
  const res = await asUser(`http://cockpit.test/v1/items/${itemId}/attachments`, {
    method: 'POST',
    headers: {
      'content-type': 'image/png',
      'x-attachment-id': nextId(),
      'x-command-id': nextId(),
      'x-issued-at': '2026-11-19T10:00:00.000Z',
      'x-workspace-id': WORKSPACE_ID,
      'x-filename': encodeURIComponent(filename),
    },
    body: new Uint8Array([1, 2, 3]),
  });
  expect(res.status).toBe(201);
}

async function snapshot(): Promise<WorkspaceSnapshot> {
  const res = await asUser(`http://cockpit.test/v1/workspaces/${WORKSPACE_ID}/snapshot`);
  expect(res.status).toBe(200);
  return (await res.json()) as WorkspaceSnapshot;
}

const rows = <T,>(query: string, ...bindings: string[]) =>
  inTheStore((sql) => sql.exec<Record<string, string | number | null>>(query, ...bindings).toArray() as T[]);

describe('Triage', () => {
  describe('a Merge replaces its Items with one that carries their words, files and places', () => {
    it('makes one Item holding every capture, file and place, and dismisses the originals as merged', async () => {
      const [a, b, c] = [await aNote('Storm over the ferry'), await aNote('Captain asleep'), await aNote('Gulls')];
      const [people, plot] = [await aPanel('People'), await aPanel('Plot')];
      await file(a, people);
      await file(b, plot);
      await attach(b, 'one.png');
      await attach(b, 'two.png');
      const merged = nextId();

      expect((await send('merge_items', { itemId: merged, originalIds: [a, b, c], title: 'The crossing', description: 'All three' })).status).toBe(200);

      const read = await snapshot();
      expect(read.items.find((item) => item.id === merged)).toMatchObject({ title: 'The crossing', description: 'All three' });
      expect(read.items.filter((item) => [a, b, c].includes(item.id))).toEqual([]);
      expect(read.attachments.filter((file) => file.itemId === merged).map((file) => file.filename).sort()).toEqual(['one.png', 'two.png']);
      expect((read.additions ?? []).filter((addition) => addition.itemId === merged).map((addition) => addition.message).sort()).toEqual([
        'Captain asleep',
        'Gulls',
        'Storm over the ferry',
      ]);
      expect(read.filings.filter((filing) => filing.itemId === merged).map((filing) => filing.panelId).sort()).toEqual([people, plot].sort());
      expect(await rows('SELECT id, merged_into_id FROM items WHERE deleted_at IS NOT NULL AND merged_into_id IS NOT NULL ORDER BY id')).toHaveLength(3);
    });

    it('refuses an Item from a source, naming it, and changes nothing', async () => {
      const [a, b] = [await aNote('Mine'), await aNote('From the mail')];
      await inTheStore((sql) => {
        sql.exec("UPDATE items SET source_connector = 'gmail' WHERE id = ?", b);
      });
      const merged = nextId();

      const refused = await send('merge_items', { itemId: merged, originalIds: [a, b], title: 'T', description: 'D' });

      expect(refused.status).toBe(400);
      expect(((await refused.json()) as { error: string }).error).toContain('From the mail');
      expect((await snapshot()).items.map((item) => item.id)).toEqual(expect.arrayContaining([a, b]));
      expect((await snapshot()).items.some((item) => item.id === merged)).toBe(false);
    });
  });

  describe('Undo after a Merge puts everything back exactly', () => {
    it('reopens the originals on their Panels with their files and takes the merged Item away', async () => {
      const [a, b, c] = [await aNote('Alpha'), await aNote('Bravo'), await aNote('Charlie')];
      const people = await aPanel('People');
      await file(a, people);
      await attach(b, 'one.png');
      const before = await snapshot();
      const merged = nextId();
      await send('merge_items', { itemId: merged, originalIds: [a, b, c], title: 'T', description: 'D' });

      expect((await send('unmerge_items', { itemId: merged, originalIds: [a, b, c] })).status).toBe(200);

      const after = await snapshot();
      expect(after.items.map((item) => item.id).sort()).toEqual(before.items.map((item) => item.id).sort());
      const open = new Set(after.items.map((item) => item.id));
      expect(after.filings.filter((filing) => filing.panelId === people && open.has(filing.itemId)).map((filing) => filing.itemId)).toEqual([a]);
      expect(after.attachments.filter((file) => file.itemId === b).map((file) => file.filename)).toEqual(['one.png']);
      expect((after.additions ?? []).filter((addition) => addition.itemId === merged)).toEqual([]);
      expect(await rows('SELECT id FROM items WHERE merged_into_id IS NOT NULL')).toEqual([]);
    });

    it('applies once when sent twice', async () => {
      const [a, b] = [await aNote('Alpha'), await aNote('Bravo')];
      const merged = nextId();
      await send('merge_items', { itemId: merged, originalIds: [a, b], title: 'T', description: 'D' });

      const first = await send('unmerge_items', { itemId: merged, originalIds: [a, b] });
      const second = await send('unmerge_items', { itemId: merged, originalIds: [a, b] });

      expect(((await first.json()) as { applied: boolean }).applied).toBe(true);
      expect(((await second.json()) as { applied: boolean }).applied).toBe(false);
      expect((await snapshot()).items.map((item) => item.id)).toEqual(expect.arrayContaining([a, b]));
    });
  });

  describe('Combine under a new parent keeps the Items and adds a parent where the first one was', () => {
    it('makes a child Panel of the Panel the first was on, keeping its story up to date', async () => {
      const [a, b, c] = [await aNote('Alpha'), await aNote('Bravo'), await aNote('Charlie')];
      const people = await aPanel('People');
      await file(a, people);
      const parent = nextId();

      expect((await send('combine_under_new_parent', { parentId: parent, title: 'Chapter 3', description: 'About three', childIds: [a, b, c], panelId: people, dashboardId: null })).status).toBe(200);

      const read = await snapshot();
      expect(read.filings).toContainEqual(expect.objectContaining({ panelId: people, itemId: parent }));
      expect(read.filings).toContainEqual(expect.objectContaining({ panelId: people, itemId: a }));
      expect(read.children).toEqual(expect.arrayContaining([expect.objectContaining({ parentId: parent, childId: b })]));
      expect(read.items.find((item) => item.id === parent)).toMatchObject({ title: 'Chapter 3', childrenCount: 3, childrenDone: 0 });
      expect(await rows('SELECT keeps_story FROM items WHERE id = ?', parent)).toEqual([{ keeps_story: 1 }]);
    });

    it('makes a new Panel on the Dashboard from the Inbox, and the Items leave the Inbox', async () => {
      const [a, b] = [await aNote('Alpha'), await aNote('Bravo')];
      const parent = nextId();

      expect((await send('combine_under_new_parent', { parentId: parent, title: 'Chapter 3', description: null, childIds: [a, b], panelId: null, dashboardId: DASHBOARD_ID })).status).toBe(200);

      const read = await snapshot();
      expect(read.panels.find((panel) => panel.id === parent)).toMatchObject({ name: 'Chapter 3', dashboardId: DASHBOARD_ID });
      expect(read.filings.filter((filing) => filing.panelId === parent).map((filing) => filing.itemId)).toEqual([a, b]);
      const inbox = itemsInTheInbox(read.items, filingsThatFile(read.filings, read.panels), read.children ?? [], read.panels);
      expect(inbox.filter((item) => [a, b].includes(item.id))).toEqual([]);
      const unfiled = await storeNamed(ACCOUNT_NAME).unfiledItemsInWorkspace(ACCOUNT_NAME, WORKSPACE_ID);
      expect(unfiled.status === 'ok' && unfiled.value.some((item) => [a, b].includes(item.id))).toBe(false);
      expect(await rows('SELECT keeps_story FROM items WHERE id = ?', parent)).toEqual([{ keeps_story: 1 }]);
    });
  });
});
