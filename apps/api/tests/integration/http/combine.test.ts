import { beforeEach, describe, expect, inject, it } from 'vitest';
import { applyD1Migrations, env } from 'cloudflare:test';
import { ACCOUNT_WIDE, filingsThatFile, itemsInTheInbox, type WorkspaceSnapshot } from '@cockpit/shared';
import { ACCOUNT_NAME, DASHBOARD_ID, WORKSPACE_ID, alsoWorkspaces, asUser, inTheStore, seedRegister, startFromEmpty, storeNamed, withoutTheGuide } from '../seed.js';

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

async function snapshot(workspaceId = WORKSPACE_ID): Promise<WorkspaceSnapshot> {
  const res = await asUser(`http://cockpit.test/v1/workspaces/${workspaceId}/snapshot`);
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

    /**
     * Where an original was filed is read from the Panels' filings ("Brainstorming: a Panel is an Item nobody can
     * open", issue 1846): written here as a filing alone, or alone under the Panel, as only one release reads each.
     */
    it.each([
      { situation: 'filed on it, never recorded under it', table: 'panel_items (tenant_id, panel_id, item_id', filed: true },
      { situation: 'recorded under it, never filed on it', table: 'item_children (tenant_id, parent_id, child_id', filed: false },
    ])('files the new Item where an original is filed, read from the filings alone: an original $situation', async ({ table, filed }) => {
      const [a, b] = [await aNote('Storm over the ferry'), await aNote('Captain asleep')];
      const people = await aPanel('People');
      await inTheStore((sql) =>
        sql.exec(`INSERT INTO ${table}, position, created_at) VALUES (?, ?, ?, 0, ?)`, ACCOUNT_NAME, people, a, '2026-11-19T09:00:00.000Z'),
      );
      const merged = nextId();

      expect((await send('merge_items', { itemId: merged, originalIds: [a, b], title: 'The crossing', description: 'Both' })).status).toBe(200);

      expect((await snapshot()).filings.some((filing) => filing.itemId === merged && filing.panelId === people)).toBe(filed);
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
    it('files the new parent on the Panel the first was on, as a row there and inside nothing, keeping its story up to date', async () => {
      const [a, b, c, chapter] = [await aNote('Alpha'), await aNote('Bravo'), await aNote('Charlie'), await aNote('Chapter 2')];
      const people = await aPanel('People');
      await file(a, people);
      expect((await send('add_children', { parentId: chapter, childIds: [a] })).status).toBe(200);
      const parent = nextId();

      expect((await send('combine_under_new_parent', { parentId: parent, title: 'Chapter 3', description: 'About three', childIds: [a, b, c], panelId: people, dashboardId: null })).status).toBe(200);

      const read = await snapshot();
      expect(read.filings).toContainEqual(expect.objectContaining({ panelId: people, itemId: parent }));
      expect(read.filings).toContainEqual(expect.objectContaining({ panelId: people, itemId: a }));
      expect(read.children).toEqual(expect.arrayContaining([expect.objectContaining({ parentId: parent, childId: b })]));
      expect(read.items.find((item) => item.id === parent)).toMatchObject({ title: 'Chapter 3', childrenCount: 3, childrenDone: 0 });
      // The row under the Panel's own Item is the filing, kept for the release before.
      expect(await rows('SELECT parent_id FROM item_children WHERE child_id = ? AND deleted_at IS NULL AND parent_id NOT IN (SELECT item_id FROM panels)', parent)).toEqual([]);
      expect(await rows('SELECT keeps_story FROM items WHERE id = ?', parent)).toEqual([{ keeps_story: 1 }]);
    });

    /**
     * "Brainstorming: a Panel is an Item nobody can open" (issue 1846): a tab of the release before names the
     * Dashboard it had open, which made a new Panel then; neither makes one now.
     */
    it.each([
      { situation: 'as the dialog sends it', dashboardId: null },
      { situation: 'as a tab of the release before sends it, naming the open Dashboard', dashboardId: DASHBOARD_ID },
    ])('leaves the new parent in the Inbox holding Items from the Inbox, $situation', async ({ dashboardId }) => {
      const [a, b] = [await aNote('Alpha'), await aNote('Bravo')];
      const parent = nextId();

      expect((await send('combine_under_new_parent', { parentId: parent, title: 'Chapter 3', description: null, childIds: [a, b], panelId: null, dashboardId })).status).toBe(200);

      const read = await snapshot();
      expect(read.panels.some((panel) => panel.id === parent)).toBe(false);
      expect(read.filings.filter((filing) => [parent, a, b].includes(filing.itemId))).toEqual([]);
      expect((read.children ?? []).filter((row) => row.parentId === parent).map((row) => row.childId)).toEqual([a, b]);
      const inbox = itemsInTheInbox(read.items, filingsThatFile(read.filings, read.panels), read.children ?? []).map((item) => item.id);
      expect(inbox.filter((id) => [parent, a, b].includes(id))).toEqual([parent]);
      const unfiled = await storeNamed(ACCOUNT_NAME).unfiledItemsInWorkspace(ACCOUNT_NAME, WORKSPACE_ID);
      expect(unfiled.status === 'ok' && unfiled.value.map((item) => item.id).filter((id) => [parent, a, b].includes(id))).toEqual([parent]);
      expect(await rows('SELECT keeps_story FROM items WHERE id = ?', parent)).toEqual([{ keeps_story: 1 }]);
    });

    it('puts the new parent inside the Item the first is inside, beside it, counted there', async () => {
      const [novel, chapter, storm, ferry] = [await aPanel('Novel'), await aNote('Chapter 3'), await aNote('Storm scene'), await aNote('Ferry scene')];
      await file(chapter, novel);
      expect((await send('add_children', { parentId: chapter, childIds: [storm, ferry] })).status).toBe(200);
      expect((await send('set_done', { itemId: ferry, done: true })).status).toBe(200);
      const parent = nextId();

      expect((await send('combine_under_new_parent', { parentId: parent, title: 'Combined: Storm scene +1', description: null, childIds: [storm, ferry], panelId: null, dashboardId: null })).status).toBe(200);

      const holding = (parentId: string) =>
        rows<{ child_id: string }>('SELECT child_id FROM item_children WHERE parent_id = ? AND deleted_at IS NULL ORDER BY position', parentId).then((found) =>
          found.map((row) => row.child_id),
        );
      expect(await holding(chapter)).toEqual([storm, ferry, parent]);
      expect(await holding(parent)).toEqual([storm, ferry]);
      const read = await snapshot();
      expect(read.items.find((item) => item.id === chapter)).toMatchObject({ childrenCount: 3, childrenDone: 1 });
      expect(read.filings.filter((filing) => filing.itemId === parent)).toEqual([]);
      const inbox = itemsInTheInbox(read.items, filingsThatFile(read.filings, read.panels), read.children ?? []).map((item) => item.id);
      expect(inbox).not.toContain(parent);
      expect(await rows('SELECT keeps_story FROM items WHERE id = ?', parent)).toEqual([{ keeps_story: 1 }]);
    });

    it('takes the Item the first was put inside first, when it is inside several', async () => {
      // Made the other way round, so an id never stands in for which came first.
      const [later, earlier, a, b] = [await aNote('Later'), await aNote('Earlier'), await aNote('Alpha'), await aNote('Bravo')];
      expect((await send('add_children', { parentId: earlier, childIds: [a] })).status).toBe(200);
      expect((await send('add_children', { parentId: later, childIds: [a, b], issuedAt: '2026-11-19T10:05:00.000Z' })).status).toBe(200);
      const parent = nextId();

      expect((await send('combine_under_new_parent', { parentId: parent, title: 'P', description: null, childIds: [a, b], panelId: null, dashboardId: null })).status).toBe(200);

      expect(await rows('SELECT parent_id FROM item_children WHERE child_id = ? AND deleted_at IS NULL', parent)).toEqual([{ parent_id: earlier }]);
    });

    /** Each would leave a new parent in an Item no list draws, or inside itself, so it stays in the Inbox. */
    it.each([
      {
        situation: 'its parent is dismissed',
        arrange: async (holder: string) => void expect((await send('set_dismissed', { itemId: holder, dismissed: true })).status).toBe(200),
        picked: (first: string, second: string) => [first, second],
      },
      {
        situation: 'its parent is combined too',
        arrange: async () => undefined,
        picked: (first: string, _second: string, holder: string) => [first, holder],
      },
      {
        situation: 'its parent sits inside one combined',
        arrange: async (holder: string, second: string) => void expect((await send('add_children', { parentId: second, childIds: [holder] })).status).toBe(200),
        picked: (first: string, second: string) => [first, second],
      },
      {
        situation: 'its parent is finished',
        arrange: async (holder: string) => void expect((await send('set_done', { itemId: holder, done: true })).status).toBe(200),
        picked: (first: string, second: string) => [first, second],
      },
    ])('leaves the new parent in the Inbox when the first Item’s $situation', async ({ arrange, picked }) => {
      const [holder, first, second] = [await aNote('Chapter 3'), await aNote('Storm scene'), await aNote('Ferry scene')];
      expect((await send('add_children', { parentId: holder, childIds: [first] })).status).toBe(200);
      await arrange(holder, second);
      const parent = nextId();

      expect((await send('combine_under_new_parent', { parentId: parent, title: 'P', description: null, childIds: picked(first, second, holder), panelId: null, dashboardId: null })).status).toBe(200);

      expect(await rows('SELECT parent_id FROM item_children WHERE child_id = ? AND deleted_at IS NULL', parent)).toEqual([]);
      const read = await snapshot();
      expect(itemsInTheInbox(read.items, filingsThatFile(read.filings, read.panels), read.children ?? []).map((item) => item.id)).toContain(parent);
    });

    it('never puts the new parent inside a Panel’s own Item, from a tab that had not yet seen the first filed', async () => {
      const [people, a, b] = [await aPanel('People'), await aNote('Alpha'), await aNote('Bravo')];
      await file(a, people);
      const parent = nextId();

      expect((await send('combine_under_new_parent', { parentId: parent, title: 'P', description: null, childIds: [a, b], panelId: null, dashboardId: null })).status).toBe(200);

      expect(await rows('SELECT parent_id FROM item_children WHERE child_id = ? AND deleted_at IS NULL', parent)).toEqual([]);
      expect(await rows('SELECT panel_id FROM panel_items WHERE item_id = ?', parent)).toEqual([]);
    });
  });

  describe('Merges undone in turn keep every file on the trail', () => {
    it('gives each file back to the Item it came from when a Merge of a Merge is undone twice', async () => {
      const [a, b, c] = [await aNote('Alpha'), await aNote('Bravo'), await aNote('Charlie')];
      await attach(a, 'from-a.png');
      await attach(c, 'from-c.png');
      const [first, second] = [nextId(), nextId()];
      await send('merge_items', { itemId: first, originalIds: [a, b], title: 'First', description: 'D' });
      await send('merge_items', { itemId: second, originalIds: [first, c], title: 'Second', description: 'D' });

      await send('unmerge_items', { itemId: second, originalIds: [first, c] });
      expect((await snapshot()).attachments.filter((file) => file.itemId === first).map((file) => file.filename)).toEqual(['from-a.png']);
      await send('unmerge_items', { itemId: first, originalIds: [a, b] });

      const read = await snapshot();
      expect(read.attachments.filter((file) => file.itemId === a).map((file) => file.filename)).toEqual(['from-a.png']);
      expect(read.attachments.filter((file) => file.itemId === c).map((file) => file.filename)).toEqual(['from-c.png']);
      expect(await rows('SELECT id FROM attachments WHERE moved_from_item_id IS NOT NULL')).toEqual([]);
    });
  });

  describe('a Merge carries what the originals held and keeps the run Undo brings back', () => {
    it('hands the originals’ children to the new Item, and gives them back on Undo', async () => {
      const [a, b, child] = [await aNote('Alpha'), await aNote('Bravo'), await aNote('Child')];
      expect((await send('add_children', { parentId: a, childIds: [child] })).status).toBe(200);
      const merged = nextId();

      await send('merge_items', { itemId: merged, originalIds: [a, b], title: 'T', description: 'D' });

      const during = await snapshot();
      expect(during.children).toContainEqual(expect.objectContaining({ parentId: merged, childId: child }));
      expect(during.items.find((item) => item.id === merged)).toMatchObject({ childrenCount: 1 });
      const inbox = itemsInTheInbox(during.items, filingsThatFile(during.filings, during.panels), during.children ?? []);
      expect(inbox.map((item) => item.id)).not.toContain(child);

      await send('unmerge_items', { itemId: merged, originalIds: [a, b] });

      const after = await snapshot();
      expect(after.children).toContainEqual(expect.objectContaining({ parentId: a, childId: child }));
      expect(after.items.find((item) => item.id === a)).toMatchObject({ childrenCount: 1 });
    });

    it('ends an original’s open run and brings it back with Undo', async () => {
      const [a, b] = [await aNote('Alpha'), await aNote('Bravo')];
      await inTheStore((sql) => {
        sql.exec(
          `INSERT INTO agent_runs (id, tenant_id, workspace_id, item_id, agent_id, status, started_at, destination)
           VALUES ('run-on-a', ?, ?, ?, 'claude', 'working', '2026-11-19T09:00:00.000Z', 'code')`,
          ACCOUNT_NAME,
          WORKSPACE_ID,
          a,
        );
      });
      const merged = nextId();
      await send('merge_items', { itemId: merged, originalIds: [a, b], title: 'T', description: 'D' });
      expect(await rows('SELECT ended_at FROM agent_runs WHERE id = ?', 'run-on-a')).toEqual([{ ended_at: '2026-11-19T10:00:00.000Z' }]);

      await send('unmerge_items', { itemId: merged, originalIds: [a, b] });

      expect(await rows('SELECT ended_at FROM agent_runs WHERE id = ?', 'run-on-a')).toEqual([{ ended_at: null }]);
    });

    it('answers a resend of the same Merge under a new command as already applied', async () => {
      const [a, b] = [await aNote('Alpha'), await aNote('Bravo')];
      const merged = nextId();
      await send('merge_items', { itemId: merged, originalIds: [a, b], title: 'T', description: 'D' });

      const again = await send('merge_items', { itemId: merged, originalIds: [a, b], title: 'T', description: 'D' });

      expect(again.status).toBe(200);
      expect(((await again.json()) as { applied: boolean }).applied).toBe(false);
    });

    it('still gives an original its file back after it was brought back on its own', async () => {
      const [a, b] = [await aNote('Alpha'), await aNote('Bravo')];
      await attach(a, 'from-a.png');
      const merged = nextId();
      await send('merge_items', { itemId: merged, originalIds: [a, b], title: 'The crossing', description: 'D' });
      expect((await send('set_dismissed', { itemId: a, dismissed: false })).status).toBe(200);

      await send('unmerge_items', { itemId: merged, originalIds: [a, b] });

      expect((await snapshot()).attachments.filter((file) => file.itemId === a).map((file) => file.filename)).toEqual(['from-a.png']);
    });
  });

  describe('a Merge never puts an Item inside itself', () => {
    const holds = (parentId: string, childId: string) =>
      rows('SELECT 1 AS one FROM item_children WHERE parent_id = ? AND child_id = ? AND deleted_at IS NULL', parentId, childId).then((found) => found.length > 0);

    it('puts the new Item inside what held the Items, and not above it, when one original is an ancestor of another', async () => {
      const [epic, story, task] = [await aNote('Epic'), await aNote('Story'), await aNote('Task')];
      expect((await send('add_children', { parentId: epic, childIds: [story] })).status).toBe(200);
      expect((await send('add_children', { parentId: story, childIds: [task] })).status).toBe(200);
      const merged = nextId();

      expect((await send('merge_items', { itemId: merged, originalIds: [epic, task], title: 'T', description: 'D' })).status).toBe(200);

      expect(await holds(story, merged)).toBe(true);
      expect(await holds(merged, story)).toBe(false);
    });

    it('leaves the new Item inside none of the originals when one held another', async () => {
      const [epic, story] = [await aNote('Epic'), await aNote('Story')];
      expect((await send('add_children', { parentId: epic, childIds: [story] })).status).toBe(200);
      const merged = nextId();

      expect((await send('merge_items', { itemId: merged, originalIds: [epic, story], title: 'T', description: 'D' })).status).toBe(200);

      expect(await holds(epic, merged)).toBe(false);
      expect(await holds(merged, story)).toBe(false);
    });
  });

  describe('an Item an app captured over MCP is merged as a note is', () => {
    it('merges it, as it finishes at no source', async () => {
      const [a, b] = [await aNote('Mine'), await aNote('From Claude')];
      await inTheStore((sql) => {
        sql.exec("UPDATE items SET source_connector = 'mcp' WHERE id = ?", b);
      });

      expect((await send('merge_items', { itemId: nextId(), originalIds: [a, b], title: 'T', description: 'D' })).status).toBe(200);
    });
  });

  describe('Items waiting in every Inbox are settled by a Combine', () => {
    it('merges Items of no Workspace yet and takes them out of every Workspace’s Inbox', async () => {
      await alsoWorkspaces();
      const [a, b] = [nextId(), nextId()];
      for (const [itemId, message] of [[a, 'Alpha'], [b, 'Bravo']] as const) {
        expect((await send('capture_item', { itemId, message, workspaceDecided: false })).status).toBe(200);
      }
      const merged = nextId();

      expect((await send('merge_items', { itemId: merged, originalIds: [a, b], title: 'T', description: 'D' })).status).toBe(200);

      for (const workspaceId of [WORKSPACE_ID, 'ws-atlas']) {
        expect((await snapshot(workspaceId)).items.map((item) => item.id)).not.toEqual(expect.arrayContaining([a]));
      }
      expect(await rows('SELECT id FROM items WHERE id = ? AND workspace_decided = 1', merged)).toHaveLength(1);
      // Logged for every Workspace to hear of, since Items in no Workspace yet are drawn in every Inbox.
      expect(await rows("SELECT workspace_id FROM commands WHERE name = 'merge_items'")).toEqual([{ workspace_id: ACCOUNT_WIDE }]);
    });

    it('settles Items of no Workspace yet into the Workspace of a new parent', async () => {
      const [a, b] = [nextId(), nextId()];
      for (const [itemId, message] of [[a, 'Alpha'], [b, 'Bravo']] as const) {
        expect((await send('capture_item', { itemId, message, workspaceDecided: false })).status).toBe(200);
      }

      const parent = nextId();
      expect((await send('combine_under_new_parent', { parentId: parent, title: 'P', description: null, childIds: [a, b], panelId: null, dashboardId: null })).status).toBe(200);

      expect(await rows('SELECT workspace_decided, workspace_id FROM items WHERE id IN (?, ?)', a, b)).toEqual([
        { workspace_decided: 1, workspace_id: WORKSPACE_ID },
        { workspace_decided: 1, workspace_id: WORKSPACE_ID },
      ]);
      expect(await rows("SELECT workspace_id FROM commands WHERE name = 'combine_under_new_parent'")).toEqual([{ workspace_id: ACCOUNT_WIDE }]);
    });
  });
});
