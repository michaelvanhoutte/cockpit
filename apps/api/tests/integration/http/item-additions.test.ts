import { afterEach, beforeEach, describe, expect, inject, it } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import type { Addition, CommandName, CommandPayload, Item } from '@cockpit/shared';
import { ACCOUNT_NAME, WORKSPACE_ID, asUser, inStoreAsItIs, seedRegister, startFromEmpty } from '../seed.js';
import type { EnrichmentJob } from '../../../src/jobs/enrichment.js';

/**
 * Integration level, through the real Worker: a note added to an Item ("Capture
 * append: add to the Item you just captured with an Add to this button", issue
 * 1640) is a row in the account's own store beside the Item, so what it keeps,
 * what it refuses and that a resend writes it once only hold against that
 * store, entered by the route a tab sends it to and read back through the
 * Workspace's snapshot. When the tab sends it is
 * apps/web/tests/unit/captureOutboxSender.test.tsx; that its files reach the
 * Item is the upload route's own (attachments.test.ts), which an addition's
 * files go through unchanged.
 */

let seq = 0;
function nextId(): string {
  seq += 1;
  return `018f0000-0000-7000-8000-${String(seq).padStart(12, '0')}`;
}

async function postChange<N extends CommandName>(name: N, payload: CommandPayload<N>) {
  return asUser(`http://cockpit.test/v1/commands/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

const CAPTURED_AT = '2026-10-30T14:00:00.000Z';

async function captureANote(message = 'Ring the plumber'): Promise<string> {
  const itemId = nextId();
  const response = await postChange('capture_item', {
    commandId: nextId(),
    issuedAt: CAPTURED_AT,
    workspaceId: WORKSPACE_ID,
    itemId,
    message,
  });
  expect(response.status).toBe(200);
  return itemId;
}

function anAddition(
  itemId: string,
  over: Partial<CommandPayload<'append_to_item'>> = {},
): CommandPayload<'append_to_item'> {
  return {
    commandId: nextId(),
    issuedAt: '2026-10-30T14:32:00.000Z',
    workspaceId: WORKSPACE_ID,
    itemId,
    additionId: nextId(),
    message: 'about the boiler',
    ...over,
  };
}

async function theWorkspace(): Promise<{ items: Item[]; additions: Addition[] }> {
  const response = await asUser(`http://cockpit.test/v1/workspaces/${WORKSPACE_ID}/snapshot`);
  expect(response.status).toBe(200);
  return (await response.json()) as { items: Item[]; additions: Addition[] };
}

async function theItem(itemId: string): Promise<Item> {
  return (await theWorkspace()).items.find((item) => item.id === itemId)!;
}

async function addedTo(itemId: string): Promise<string[]> {
  return (await theWorkspace()).additions.filter((one) => one.itemId === itemId).map((one) => one.message);
}

async function additionRows(): Promise<number> {
  return inStoreAsItIs(ACCOUNT_NAME, (sql) => sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM item_additions').one().n);
}

/** What the Worker queued, held rather than delivered: a reading of an Item's meaning is the job counted here. */
let held: EnrichmentJob[] = [];
let realQueue: typeof env.ENRICHMENT;
let realReader: unknown;
const meaningReadsOf = (itemId: string) =>
  held.filter((job) => job.kind === 'read-what-a-note-means' && job.itemId === itemId);

beforeEach(async () => {
  await applyD1Migrations(env.DB, inject('migrations'));
  await startFromEmpty();
  await seedRegister();
  held = [];
  // Something that reads meaning, so a reading is queued at all; the jobs are held, never run.
  realReader = (env as unknown as { AI: unknown }).AI;
  (env as unknown as { AI: unknown }).AI = { run: async () => ({ data: [[1, 0]] }) };
  realQueue = env.ENRICHMENT;
  env.ENRICHMENT = {
    send: async (body: EnrichmentJob) => void held.push(body),
    sendBatch: async () => {
      throw new Error('nothing here sends a batch');
    },
  } as unknown as typeof env.ENRICHMENT;
});

afterEach(() => {
  env.ENRICHMENT = realQueue;
  (env as unknown as { AI: unknown }).AI = realReader;
});

describe('Capture', () => {
  describe('a note added to an Item is kept beside the captured message, which never changes', () => {
    it('lists the addition after the captured message, which reads as first written', async () => {
      const itemId = await captureANote('Ring the plumber');

      const response = await postChange('append_to_item', anAddition(itemId));

      expect(response.status).toBe(200);
      const { items, additions } = await theWorkspace();
      const item = items.find((one) => one.id === itemId)!;
      expect(item.capturedMessage).toBe('Ring the plumber');
      expect(additions).toEqual([
        expect.objectContaining({ itemId, message: 'about the boiler', createdAt: '2026-10-30T14:32:00.000Z' }),
      ]);
    });

    it('lists two additions oldest first, whichever arrived first', async () => {
      const itemId = await captureANote();

      await postChange('append_to_item', anAddition(itemId, { message: 'and the tap', issuedAt: '2026-10-30T14:40:00.000Z' }));
      await postChange('append_to_item', anAddition(itemId, { message: 'about the boiler', issuedAt: '2026-10-30T14:32:00.000Z' }));

      expect(await addedTo(itemId)).toEqual(['about the boiler', 'and the tap']);
    });

    it.each([
      { situation: 'a priority picked for it', picked: { priority: 'high' as const }, priority: 'high', dueDate: null },
      { situation: 'a due date picked for it', picked: { dueDate: '2026-11-06' }, priority: null, dueDate: '2026-11-06' },
      { situation: 'nothing picked', picked: {}, priority: null, dueDate: null },
      { situation: '"urgent" in its words and nothing picked', picked: { message: 'this is urgent, by Friday' }, priority: null, dueDate: null },
    ])('changes the priority and due date only for $situation', async ({ picked, priority, dueDate }) => {
      const itemId = await captureANote();

      await postChange('append_to_item', anAddition(itemId, picked));

      const item = await theItem(itemId);
      expect([item.priority, item.dueDate]).toEqual([priority, dueDate]);
    });

    it.each([
      { situation: 'texts never edited', edit: null },
      { situation: 'texts edited by hand', edit: 'Plumber: boiler and tap' },
    ])('leaves the title and description as they were, $situation', async ({ edit }) => {
      const itemId = await captureANote('Ring the plumber');
      if (edit) {
        await postChange('set_title', { commandId: nextId(), issuedAt: '2026-10-30T14:10:00.000Z', workspaceId: WORKSPACE_ID, itemId, title: edit });
      }
      const before = await theItem(itemId);

      await postChange('append_to_item', anAddition(itemId));

      const after = await theItem(itemId);
      expect([after.title, after.description]).toEqual([before.title, before.description]);
      expect(after.updatedAt).toBe('2026-10-30T14:32:00.000Z');
    });

    it('lists all of fifty additions in the one read, newest last', async () => {
      const itemId = await captureANote();
      for (let at = 0; at < 50; at++) {
        const minute = String(at).padStart(2, '0');
        await postChange('append_to_item', anAddition(itemId, { message: `note ${at + 1}`, issuedAt: `2026-10-30T15:${minute}:00.000Z` }));
      }

      const added = await addedTo(itemId);

      expect(added).toHaveLength(50);
      expect(added.at(-1)).toBe('note 50');
    });
  });

  describe('a note is added only to an Item that is there and not dismissed', () => {
    it.each([
      {
        situation: 'a dismissed Item',
        arrange: async () => {
          const itemId = await captureANote();
          await postChange('set_dismissed', { commandId: nextId(), issuedAt: '2026-10-30T14:10:00.000Z', workspaceId: WORKSPACE_ID, itemId, dismissed: true });
          return itemId;
        },
      },
      { situation: 'an Item that was never there', arrange: async () => nextId() },
    ])('refuses one for $situation, and keeps nothing', async ({ arrange }) => {
      const itemId = await arrange();

      const response = await postChange('append_to_item', anAddition(itemId));

      expect(response.status).toBe(404);
      expect(((await response.json()) as { error: string }).error).toBe(
        'The item this was added to is gone or dismissed, so it was not added.',
      );
      expect(await additionRows()).toBe(0);
    });

    it('takes one for an Item marked done, which is not dismissed', async () => {
      const itemId = await captureANote();
      await postChange('set_done', { commandId: nextId(), issuedAt: '2026-10-30T14:10:00.000Z', workspaceId: WORKSPACE_ID, itemId, done: true });

      const response = await postChange('append_to_item', anAddition(itemId));

      expect(response.status).toBe(200);
      expect(await additionRows()).toBe(1);
    });
  });

  describe('a note added and sent again is kept once', () => {
    it('keeps one row for the same addition sent twice, says the second was already there, and reads it once', async () => {
      const itemId = await captureANote();
      held = [];
      const once = anAddition(itemId);

      const first = await postChange('append_to_item', once);
      const second = await postChange('append_to_item', once);

      expect(await first.json()).toMatchObject({ applied: true });
      expect(await second.json()).toMatchObject({ applied: false });
      expect(await additionRows()).toBe(1);
      expect(meaningReadsOf(itemId)).toHaveLength(1);
    });

    it('keeps one row for the same addition sent again by another tab under a command of its own', async () => {
      const itemId = await captureANote();
      const once = anAddition(itemId);

      await postChange('append_to_item', once);
      const again = await postChange('append_to_item', { ...once, commandId: nextId() });

      expect(again.status).toBe(200);
      expect(await addedTo(itemId)).toEqual(['about the boiler']);
    });

    it('keeps both of two tabs adding to the same Item at once, in the order they were written', async () => {
      const itemId = await captureANote();

      await Promise.all([
        postChange('append_to_item', anAddition(itemId, { message: 'from the phone', issuedAt: '2026-10-30T14:33:00.000Z' })),
        postChange('append_to_item', anAddition(itemId, { message: 'from the desk', issuedAt: '2026-10-30T14:32:00.000Z' })),
      ]);

      expect(await addedTo(itemId)).toEqual(['from the desk', 'from the phone']);
    });
  });
});
