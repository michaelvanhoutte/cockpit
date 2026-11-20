import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { ACCOUNT_NAME, DASHBOARD_ID, WORKSPACE_ID, inStoreAsItIs } from '../seed.js';
import { handleQueue } from '../../../src/jobs/index.js';
import type { EnrichmentJob } from '../../../src/jobs/enrichment.js';
import { aModelThatReads, batchOf, captureANote, nextId, postChange, writing } from './note-cleanup.support.js';
import { connected, mcp } from './connected-apps.support.js';

/**
 * L2: Claude keeping a parent's story up to date ("Brainstorming: a parent's
 * description goes stale as children join or leave", issue 1827) through the
 * real Worker, the real consumer and the real store, with the model faked at the
 * network boundary and the queue held at its binding, drained by hand. Whether
 * the real model writes a story that holds is the contract tier's
 * (tests/contract/write-a-story.v1.test.ts); the decision on what to do with
 * what it wrote is apps/api/tests/unit/domain/story.test.ts.
 */

aModelThatReads();

let held: EnrichmentJob[] = [];
let realQueue: typeof env.ENRICHMENT;

beforeEach(() => {
  held = [];
  realQueue = env.ENRICHMENT;
  env.ENRICHMENT = {
    send: async (body: EnrichmentJob) => {
      held.push(body);
    },
    sendBatch: async () => {
      throw new Error('nothing here sends a batch');
    },
  } as unknown as typeof env.ENRICHMENT;
});

afterEach(() => {
  env.ENRICHMENT = realQueue;
});

const envelope = () => ({ commandId: nextId(), issuedAt: '2026-11-19T10:00:00.000Z', workspaceId: WORKSPACE_ID });

/** The rewrites asked for so far, whoever's. */
const rewrites = () => held.filter((job) => job.kind === 'rewrite-story');

/** Waits for the rewrites a change queues after it has answered. */
async function untilRewrites(count: number): Promise<void> {
  await vi.waitFor(() => expect(rewrites()).toHaveLength(count), { timeout: 15_000, interval: 25 });
}

/** Lets what a change queues after it has answered settle, for a case that expects nothing more. */
async function settled(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 150));
}

/** Delivers every rewrite held, in the order asked, through the real consumer. */
async function delivered(): Promise<void> {
  const asked = rewrites();
  held = held.filter((job) => job.kind !== 'rewrite-story');
  for (const job of asked) await handleQueue(batchOf(job), env);
}

async function aNote(message = 'A note about the crossing'): Promise<string> {
  const itemId = nextId();
  await captureANote({ itemId, message });
  return itemId;
}

/** An Item that holds Items, with its story kept up to date unless said otherwise, and its description Claude's or yours. */
async function aParent({ keeps = true, yours = false }: { keeps?: boolean; yours?: boolean } = {}): Promise<string> {
  const parentId = await aNote('Chapter 3');
  if (keeps) expect((await postChange('set_keeps_story', { ...envelope(), itemId: parentId, keepsStory: true })).status).toBe(200);
  if (yours) {
    expect((await postChange('set_description', { ...envelope(), itemId: parentId, description: 'My own words about chapter 3' })).status).toBe(200);
  }
  held = held.filter((job) => job.kind !== 'rewrite-story');
  return parentId;
}

async function addChildren(parentId: string, childIds: string[]) {
  const response = await postChange('add_children', { ...envelope(), parentId, childIds });
  expect(response.status).toBe(200);
}

async function storyOf(itemId: string) {
  const rows = await inStoreAsItIs(ACCOUNT_NAME, (sql) =>
    sql
      .exec<{ description: string | null; texts_settled_at: string | null; story_proposal: string | null; keeps_story: number }>(
        'SELECT description, texts_settled_at, story_proposal, keeps_story FROM items WHERE id = ? AND tenant_id = ?',
        itemId,
        ACCOUNT_NAME,
      )
      .toArray(),
  );
  return rows[0]!;
}

describe('Triage', () => {
  describe('a child joining or leaving queues one rewrite per parent, only where Keep its story up to date is on', () => {
    it('queues one for five children added within the window, and writes one story', async () => {
      const parentId = await aParent();
      const children = await Promise.all([1, 2, 3, 4, 5].map((at) => aNote(`Scene ${at}`)));
      for (const child of children) await addChildren(parentId, [child]);
      await untilRewrites(5);

      await delivered();

      // Each ask took the place of the one before: only the last runs the model.
      expect(writing.asked).toHaveLength(1);
      expect(writing.asked[0]!.item).toContain('Scene 5');
      expect((await storyOf(parentId)).description).toBe('A story of what it holds.');
    });

    it('queues none for a parent that does not keep its story up to date', async () => {
      const parentId = await aParent({ keeps: false });

      await addChildren(parentId, [await aNote()]);
      await settled();

      expect(rewrites()).toEqual([]);
    });

    it('queues one when a child leaves', async () => {
      const parentId = await aParent();
      const child = await aNote();
      await addChildren(parentId, [child]);
      await untilRewrites(1);
      held = [];

      expect((await postChange('remove_child', { ...envelope(), parentId, childId: child })).status).toBe(200);

      await untilRewrites(1);
      expect(rewrites()[0]).toMatchObject({ kind: 'rewrite-story', itemId: parentId });
    });

    it('queues none when an Item is filed on, moved between or taken off Panels, a parent that keeps its story among them', async () => {
      const [first, second] = [nextId(), nextId()];
      for (const [panelId, name] of [[first, 'First'], [second, 'Second']] as const) {
        expect((await postChange('add_panel', { ...envelope(), dashboardId: DASHBOARD_ID, panelId, name, kind: 'items' })).status).toBe(200);
      }
      const parentId = await aParent();
      await addChildren(parentId, [await aNote()]);
      await untilRewrites(1);
      held = [];

      for (const itemId of [await aNote(), parentId]) {
        expect((await postChange('add_item_to_panel', { ...envelope(), itemId, panelId: first, order: [itemId] })).status).toBe(200);
        expect((await postChange('move_item_to_panel', { ...envelope(), itemId, panelId: second, order: [itemId] })).status).toBe(200);
        expect((await postChange('remove_item_from_panel', { ...envelope(), itemId, panelId: second })).status).toBe(200);
      }
      await settled();

      expect(rewrites()).toEqual([]);
    });

    it('refuses Keep its story up to date and Rewrite from its children on a Panel, which tells no story', async () => {
      const panelId = nextId();
      expect((await postChange('add_panel', { ...envelope(), dashboardId: DASHBOARD_ID, panelId, name: 'Shelf', kind: 'items' })).status).toBe(200);
      const note = await aNote();
      expect((await postChange('add_item_to_panel', { ...envelope(), itemId: note, panelId, order: [note] })).status).toBe(200);

      expect((await postChange('set_keeps_story', { ...envelope(), itemId: panelId, keepsStory: true })).status).toBe(404);
      expect((await postChange('rewrite_story', { ...envelope(), itemId: panelId })).status).toBe(404);
      await settled();
      expect(rewrites()).toEqual([]);
    });

    it('queues one for the Item a new parent from Combine goes inside, beside the first Item picked', async () => {
      const holder = await aParent();
      const [first, second] = [await aNote('Storm scene'), await aNote('Ferry scene')];
      await addChildren(holder, [first, second]);
      await untilRewrites(1);
      held = [];
      const parentId = nextId();

      expect((await postChange('combine_under_new_parent', { ...envelope(), parentId, title: 'Combined', description: 'Storm and ferry.', childIds: [first, second], panelId: null, dashboardId: null })).status).toBe(200);

      await untilRewrites(2);
      expect(rewrites()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ itemId: parentId, anyway: true }),
          expect.objectContaining({ itemId: holder, anyway: false }),
        ]),
      );
    });

    it('asks for the story of what Combine makes, and of what Rewrite from its children names, whatever the setting', async () => {
      const [first, second] = [await aNote('One'), await aNote('Two')];
      const parentId = nextId();

      expect((await postChange('combine_under_new_parent', { ...envelope(), parentId, title: 'Combined', description: 'This brings together One and Two.', childIds: [first, second], panelId: null, dashboardId: null })).status).toBe(200);
      await untilRewrites(1);
      expect(rewrites()[0]).toMatchObject({ itemId: parentId, anyway: true });
      held = [];

      const loose = await aParent({ keeps: false });
      await addChildren(loose, [await aNote()]);
      expect((await postChange('rewrite_story', { ...envelope(), itemId: loose })).status).toBe(200);
      await untilRewrites(1);
      expect(rewrites()[0]).toMatchObject({ itemId: loose, anyway: true });
    });

    it('queues one when a child is dismissed, and one when it is brought back', async () => {
      const parentId = await aParent();
      const child = await aNote();
      await addChildren(parentId, [child]);
      await untilRewrites(1);
      held = [];

      expect((await postChange('set_dismissed', { ...envelope(), itemId: child, dismissed: true })).status).toBe(200);
      await untilRewrites(1);
      expect(rewrites()[0]).toMatchObject({ itemId: parentId });
      held = [];
      expect((await postChange('set_dismissed', { ...envelope(), itemId: child, dismissed: false })).status).toBe(200);
      await untilRewrites(1);
      expect(rewrites()[0]).toMatchObject({ itemId: parentId });
    });

    it('queues one when a connected app deletes a child over MCP', async () => {
      const parentId = await aParent();
      const child = await aNote();
      await addChildren(parentId, [child]);
      await untilRewrites(1);
      held = [];
      const { token } = await connected();

      expect((await mcp(token, 'tools/call', { name: 'delete_item', arguments: { id: child } })).status).toBe(200);

      await untilRewrites(1);
      expect(rewrites()[0]).toMatchObject({ itemId: parentId });
    });

    it('refuses to write a story for an Item that holds nothing, and queues nothing', async () => {
      const leaf = await aNote('A note with nothing under it');

      const refused = await postChange('rewrite_story', { ...envelope(), itemId: leaf });

      expect(refused.status).toBe(400);
      await settled();
      expect(rewrites()).toEqual([]);
    });

    it('queues one when Undo of a Merge puts originals back into a parent that keeps its story, and none for a repeat add', async () => {
      const parentId = await aParent();
      const [a, b] = [await aNote('Alpha'), await aNote('Bravo')];
      await addChildren(parentId, [a, b]);
      await untilRewrites(1);
      held = [];
      await addChildren(parentId, [a]);
      await settled();
      expect(rewrites()).toEqual([]);
      const merged = nextId();
      expect((await postChange('merge_items', { ...envelope(), itemId: merged, originalIds: [a, b], title: 'T', description: 'D' })).status).toBe(200);
      await untilRewrites(2);
      held = [];

      expect((await postChange('unmerge_items', { ...envelope(), itemId: merged, originalIds: [a, b] })).status).toBe(200);

      await untilRewrites(1);
      expect(rewrites()[0]).toMatchObject({ itemId: parentId });
    });

    it('does not rewrite on a run turned off while it waited, unless it was asked for by name', async () => {
      const parentId = await aParent();
      await addChildren(parentId, [await aNote()]);
      await untilRewrites(1);
      expect((await postChange('set_keeps_story', { ...envelope(), itemId: parentId, keepsStory: false })).status).toBe(200);

      await delivered();

      expect(writing.asked).toEqual([]);
    });
  });

  describe('a parent that holds nothing keeps its description when its last child leaves', () => {
    it('writes nothing for the run a leaving child queued', async () => {
      const parentId = await aParent();
      const child = await aNote();
      await addChildren(parentId, [child]);
      await untilRewrites(1);
      await delivered();
      writing.asked.length = 0;
      expect((await postChange('remove_child', { ...envelope(), parentId, childId: child })).status).toBe(200);
      await untilRewrites(1);

      await delivered();

      expect(writing.asked).toEqual([]);
      expect(await storyOf(parentId)).toMatchObject({ description: 'A story of what it holds.' });
    });
  });

  describe('a rewritten description is replaced while it is Claude\'s, and a Review waits once it is yours', () => {
    it('replaces a description nobody has edited, without a Review', async () => {
      const parentId = await aParent();
      await addChildren(parentId, [await aNote('Storm scene')]);
      await untilRewrites(1);

      await delivered();

      expect(await storyOf(parentId)).toMatchObject({ description: 'A story of what it holds.', story_proposal: null, texts_settled_at: null });
    });

    it('keeps a description you edited and holds the new version for a Review', async () => {
      const parentId = await aParent({ yours: true });
      await addChildren(parentId, [await aNote('Storm scene')]);
      await untilRewrites(1);

      await delivered();

      expect(await storyOf(parentId)).toMatchObject({
        description: 'My own words about chapter 3',
        story_proposal: 'A story of what it holds.',
      });
    });

    it('Use it makes it the description, still yours, and Keep mine drops it', async () => {
      const [used, kept] = [await aParent({ yours: true }), await aParent({ yours: true })];
      for (const parentId of [used, kept]) await addChildren(parentId, [await aNote('Storm scene')]);
      await untilRewrites(2);
      await delivered();

      expect((await postChange('use_story', { ...envelope(), itemId: used, story: 'A story of what it holds.' })).status).toBe(200);
      expect((await postChange('keep_my_story', { ...envelope(), itemId: kept, story: 'A story of what it holds.' })).status).toBe(200);

      expect(await storyOf(used)).toMatchObject({ description: 'A story of what it holds.', story_proposal: null });
      expect((await storyOf(used)).texts_settled_at).not.toBeNull();
      expect(await storyOf(kept)).toMatchObject({ description: 'My own words about chapter 3', story_proposal: null });
    });

    it('replaces the stitched description Combine wrote while it is still Claude\'s', async () => {
      const [first, second] = [await aNote('One'), await aNote('Two')];
      const parentId = nextId();
      await postChange('combine_under_new_parent', { ...envelope(), parentId, title: 'Combined', description: 'This brings together One and Two.', childIds: [first, second], panelId: null, dashboardId: null });
      await untilRewrites(1);

      await delivered();

      expect(await storyOf(parentId)).toMatchObject({ description: 'A story of what it holds.', keeps_story: 1 });
    });
  });

  describe('what a story is written from, and what follows it', () => {
    it('writes a Merge\'s first story from what the originals said and from the Items they held', async () => {
      const [a, b, held3] = [await aNote('Book flights to Lisbon'), await aNote('Hotel in Alfama'), await aNote('Renew passport')];
      await addChildren(a, [held3]);
      const merged = nextId();
      expect((await postChange('merge_items', { ...envelope(), itemId: merged, originalIds: [a, b], title: 'Lisbon', description: 'Stitched' })).status).toBe(200);
      await vi.waitFor(() => expect(rewrites().some((job) => job.kind === 'rewrite-story' && job.itemId === merged)).toBe(true), { timeout: 15_000 });
      held = held.filter((job) => job.kind === 'rewrite-story' && job.itemId === merged);

      await delivered();

      expect(writing.asked).toHaveLength(1);
      for (const words of ['Book flights to Lisbon', 'Hotel in Alfama', 'Renew passport']) expect(writing.asked[0]!.item).toContain(words);
    });

    it('writes nothing for a story asked for by name once nothing is held, rather than calling it empty', async () => {
      const parentId = await aParent({ keeps: false });
      const child = await aNote();
      await addChildren(parentId, [child]);
      expect((await postChange('rewrite_story', { ...envelope(), itemId: parentId })).status).toBe(200);
      await untilRewrites(1);
      expect((await postChange('remove_child', { ...envelope(), parentId, childId: child })).status).toBe(200);
      const before = await storyOf(parentId);

      await delivered();

      expect(writing.asked).toEqual([]);
      expect(await storyOf(parentId)).toEqual(before);
    });

    it('asks again what to do with an Item whose description a story replaced, and not where it waits for a Review', async () => {
      const [replaced, reviewed] = [await aParent(), await aParent({ yours: true })];
      for (const parentId of [replaced, reviewed]) await addChildren(parentId, [await aNote('Storm scene')]);
      await untilRewrites(2);
      held = held.filter((job) => job.kind === 'rewrite-story');

      await delivered();

      const proposals = () => held.filter((job) => job.kind === 'propose-for-claude').map((job) => (job as { itemId: string }).itemId);
      await vi.waitFor(() => expect(proposals()).toContain(replaced), { timeout: 15_000 });
      expect(proposals()).not.toContain(reviewed);
    });
  });

  describe('a failed call is tried again by the queue and changes nothing meanwhile', () => {
    it('leaves the description as it was and asks for the message again, then writes on the next delivery', async () => {
      const parentId = await aParent();
      await addChildren(parentId, [await aNote('Storm scene')]);
      await untilRewrites(1);
      const job = rewrites()[0]!;
      const before = await storyOf(parentId);
      writing.fails = true;
      let retried = false;
      let acked = false;
      const failing = batchOf(job);
      failing.messages[0]!.retry = () => {
        retried = true;
      };
      failing.messages[0]!.ack = () => {
        acked = true;
      };

      await handleQueue(failing, env);

      expect({ retried, acked }).toEqual({ retried: true, acked: false });
      expect(await storyOf(parentId)).toEqual(before);

      writing.fails = false;
      await handleQueue(batchOf(job), env);
      expect((await storyOf(parentId)).description).toBe('A story of what it holds.');
    });
  });
});
