import { beforeEach, describe, expect, inject, it } from 'vitest';
import { applyD1Migrations, env } from 'cloudflare:test';
import { MAX_THUMBNAIL_SIZE, type CommandName, type CommandPayload, type WorkspaceSnapshot } from '@cockpit/shared';
import { ACCOUNT_NAME, OTHER_USER_ID, WORKSPACE_ID, asUser, inTheStore, seedRegister, startFromEmpty, withoutTheGuide } from '../seed.js';

/**
 * Integration level, through the real Worker: "Item form: there is no way to
 * mark which image stands for an Item" (issue 1863). Which picture stands for
 * an Item is checked against the account's own attachments, written to R2
 * before the store records it, and cleared in the same transaction that
 * removes the file, so each holds only against a real store and bucket. The
 * button that sends it, and the copy a canvas makes, are the browser's.
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

const NOW = '2026-11-20T10:00:00.000Z';

async function send<N extends CommandName>(name: N, body: Omit<CommandPayload<N>, 'commandId' | 'issuedAt' | 'workspaceId'>, userId?: string, workspaceId = WORKSPACE_ID) {
  return asUser(
    `http://cockpit.test/v1/commands/${name}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ commandId: nextId(), issuedAt: NOW, workspaceId, ...body }),
    },
    userId,
  );
}

async function aNote(): Promise<string> {
  const itemId = nextId();
  expect((await send('capture_item', { itemId, message: 'Anna (main character)' })).status).toBe(200);
  return itemId;
}

/** A file attached to an Item, as the upload route stores it: its id. */
async function attach(itemId: string, contentType: string, filename: string, userId?: string, workspaceId = WORKSPACE_ID): Promise<string> {
  const attachmentId = nextId();
  const res = await asUser(
    `http://cockpit.test/v1/items/${itemId}/attachments`,
    {
      method: 'POST',
      headers: {
        'content-type': contentType,
        'x-attachment-id': attachmentId,
        'x-command-id': nextId(),
        'x-issued-at': NOW,
        'x-workspace-id': workspaceId,
        'x-filename': encodeURIComponent(filename),
      },
      body: new Uint8Array([1, 2, 3, 4]),
    },
    userId,
  );
  expect(res.status).toBe(201);
  return attachmentId;
}

const COPY = new Uint8Array([9, 8, 7, 6, 5]);

/** The device's small copy sent to the thumbnail upload route, which is how a pick is made. */
async function pick(
  itemId: string,
  attachmentId: string,
  { contentType = 'image/webp', body = COPY, commandId = nextId() }: { contentType?: string; body?: Uint8Array; commandId?: string } = {},
) {
  return asUser(`http://cockpit.test/v1/items/${itemId}/attachments/${attachmentId}/thumbnail`, {
    method: 'POST',
    headers: { 'content-type': contentType, 'x-command-id': commandId, 'x-issued-at': NOW, 'x-workspace-id': WORKSPACE_ID },
    body,
  });
}

const thumbnailOf = async (itemId: string) =>
  (await inTheStore((sql) => sql.exec<{ thumbnail_attachment_id: string | null }>('SELECT thumbnail_attachment_id FROM items WHERE id = ?', itemId).one()))
    .thumbnail_attachment_id;

const keyOf = (itemId: string, attachmentId: string) => `${ACCOUNT_NAME}/${itemId}/${attachmentId}`;
const copyOf = (itemId: string, attachmentId: string) => env.ATTACHMENTS.get(`${keyOf(itemId, attachmentId)}.thumbnail`);

async function snapshot(): Promise<WorkspaceSnapshot> {
  const res = await asUser(`http://cockpit.test/v1/workspaces/${WORKSPACE_ID}/snapshot`);
  expect(res.status).toBe(200);
  return (await res.json()) as WorkspaceSnapshot;
}

describe('Item editing', () => {
  describe('an Item’s thumbnail is at most one of its own image attachments, and picking another replaces it', () => {
    it('names the picture, and keeps the small copy beside the original', async () => {
      const itemId = await aNote();
      const portrait = await attach(itemId, 'image/jpeg', 'portrait.jpg');

      const res = await pick(itemId, portrait);

      expect(res.status).toBe(200);
      expect(await thumbnailOf(itemId)).toBe(portrait);
      expect(new Uint8Array(await (await copyOf(itemId, portrait))!.arrayBuffer())).toEqual(COPY);
      expect(await env.ATTACHMENTS.get(keyOf(itemId, portrait))).not.toBeNull();
    });

    it('moves to the second picture when it is picked, and to none on Stop using', async () => {
      const itemId = await aNote();
      const first = await attach(itemId, 'image/jpeg', 'first.jpg');
      const second = await attach(itemId, 'image/png', 'second.png');
      await pick(itemId, first);

      await pick(itemId, second);
      expect(await thumbnailOf(itemId)).toBe(second);

      expect((await send('set_thumbnail', { itemId, attachmentId: null })).status).toBe(200);
      expect(await thumbnailOf(itemId)).toBeNull();
    });

    it('is one value and no error when the same pick is sent twice', async () => {
      const itemId = await aNote();
      const portrait = await attach(itemId, 'image/gif', 'portrait.gif');

      const commandId = nextId();
      const first = await pick(itemId, portrait, { commandId });
      const again = await pick(itemId, portrait);
      const replayed = await pick(itemId, portrait, { commandId });

      expect([first.status, again.status, replayed.status]).toEqual([200, 200, 200]);
      expect(((await replayed.json()) as { applied: boolean }).applied).toBe(false);
      expect(await thumbnailOf(itemId)).toBe(portrait);
    });

    it('refuses a picture posted as JSON, since it would name one with no copy to draw', async () => {
      const itemId = await aNote();
      const portrait = await attach(itemId, 'image/png', 'portrait.png');

      const res = await send('set_thumbnail', { itemId, attachmentId: portrait });

      expect(res.status).toBe(400);
      expect(await thumbnailOf(itemId)).toBeNull();
    });

    it.each([
      { situation: 'a PDF', status: 400 },
      { situation: 'a clip', status: 400 },
    ])('refuses $situation and writes nothing', async ({ situation, status }) => {
      const itemId = await aNote();
      const file = await attach(itemId, situation === 'a PDF' ? 'application/pdf' : 'video/mp4', 'file');

      const res = await pick(itemId, file);

      expect(res.status).toBe(status);
      expect(await thumbnailOf(itemId)).toBeNull();
      expect(await copyOf(itemId, file)).toBeNull();
    });

    it('refuses a picture that is another Item’s, in the words of a missing one, and writes nothing', async () => {
      const itemId = await aNote();
      const other = await aNote();
      const theirs = await attach(other, 'image/png', 'theirs.png');

      const res = await pick(itemId, theirs);
      const missing = await pick(itemId, nextId());

      expect(res.status).toBe(404);
      expect(missing.status).toBe(404);
      expect((await res.json()) as { error: string }).toEqual({ error: `attachment ${theirs} not found` });
      expect(await thumbnailOf(itemId)).toBeNull();
      expect(await thumbnailOf(other)).toBeNull();
      expect(await copyOf(other, theirs)).toBeNull();
    });

    it('refuses another account’s attachment id in the same words as a missing one, and writes nothing', async () => {
      const itemId = await aNote();
      const lists = await asUser('http://cockpit.test/v1/workspaces', {}, OTHER_USER_ID);
      const [adasWorkspace] = ((await lists.json()) as { workspaces: { id: string }[] }).workspaces;
      const adasNote = nextId();
      expect((await send('capture_item', { itemId: adasNote, message: 'Ada’s note' }, OTHER_USER_ID, adasWorkspace!.id)).status).toBe(200);
      const adas = await attach(adasNote, 'image/png', 'ada.png', OTHER_USER_ID, adasWorkspace!.id);

      const res = await pick(itemId, adas);

      expect(res.status).toBe(404);
      expect((await res.json()) as { error: string }).toEqual({ error: `attachment ${adas} not found` });
      expect(await thumbnailOf(itemId)).toBeNull();
      expect(await env.ATTACHMENTS.get(`${ACCOUNT_NAME}/${itemId}/${adas}.thumbnail`)).toBeNull();
    });

    it('refuses a pick for an attachment removed before it landed', async () => {
      const itemId = await aNote();
      const portrait = await attach(itemId, 'image/png', 'portrait.png');
      expect((await send('remove_attachment', { itemId, attachmentId: portrait })).status).toBe(200);

      const res = await pick(itemId, portrait);

      expect(res.status).toBe(404);
      expect(await thumbnailOf(itemId)).toBeNull();
    });

    it('refuses a copy over 64 KB before anything is written to R2', async () => {
      const itemId = await aNote();
      const portrait = await attach(itemId, 'image/png', 'portrait.png');

      const res = await pick(itemId, portrait, { body: new Uint8Array(MAX_THUMBNAIL_SIZE + 1) });

      expect(res.status).toBe(413);
      expect(await copyOf(itemId, portrait)).toBeNull();
      expect(await thumbnailOf(itemId)).toBeNull();
    });

    it.each([
      { situation: 'a GIF', type: 'image/gif' },
      { situation: 'an SVG', type: 'image/svg+xml' },
      { situation: 'a PDF', type: 'application/pdf' },
    ])('refuses a copy that is $situation, not a PNG, JPEG or WebP', async ({ type }) => {
      const itemId = await aNote();
      const portrait = await attach(itemId, 'image/png', 'portrait.png');

      const res = await pick(itemId, portrait, { contentType: type });

      expect(res.status).toBe(400);
      expect(await copyOf(itemId, portrait)).toBeNull();
      expect(await thumbnailOf(itemId)).toBeNull();
    });
  });

  describe('removing the attachment that is the thumbnail clears it, and removing any other leaves it', () => {
    it('clears it when its own picture is removed', async () => {
      const itemId = await aNote();
      const portrait = await attach(itemId, 'image/png', 'portrait.png');
      await pick(itemId, portrait);

      expect((await send('remove_attachment', { itemId, attachmentId: portrait })).status).toBe(200);

      expect(await thumbnailOf(itemId)).toBeNull();
    });

    it('leaves it when another file is removed', async () => {
      const itemId = await aNote();
      const portrait = await attach(itemId, 'image/png', 'portrait.png');
      const scan = await attach(itemId, 'application/pdf', 'scan.pdf');
      await pick(itemId, portrait);

      expect((await send('remove_attachment', { itemId, attachmentId: scan })).status).toBe(200);

      expect(await thumbnailOf(itemId)).toBe(portrait);
    });
  });

  describe('the thumbnail travels with its Item in every read that carries the Item', () => {
    it('is on an open Item in the Workspace read, and null on one without', async () => {
      const [picked, plain] = [await aNote(), await aNote()];
      const portrait = await attach(picked, 'image/png', 'portrait.png');
      await pick(picked, portrait);

      const read = await snapshot();

      expect(read.items.find((item) => item.id === picked)?.thumbnailAttachmentId).toBe(portrait);
      expect(read.items.find((item) => item.id === plain)?.thumbnailAttachmentId).toBeNull();
    });

    it('is on a finished Item in the read of the finished ones', async () => {
      const itemId = await aNote();
      const portrait = await attach(itemId, 'image/png', 'portrait.png');
      await pick(itemId, portrait);
      expect((await send('set_done', { itemId, done: true })).status).toBe(200);

      const res = await asUser(`http://cockpit.test/v1/workspaces/${WORKSPACE_ID}/finished-items`);
      expect(res.status).toBe(200);
      const read = (await res.json()) as WorkspaceSnapshot;

      expect(read.items.find((item) => item.id === itemId)?.thumbnailAttachmentId).toBe(portrait);
    });
  });

  describe('a Merge gives the merged Item no thumbnail, and an unmerge leaves the originals’ as they were', () => {
    it('merges two Items that each had one into an Item with none, and gives each original its own back', async () => {
      const [a, b] = [await aNote(), await aNote()];
      const [fromA, fromB] = [await attach(a, 'image/png', 'a.png'), await attach(b, 'image/jpeg', 'b.jpg')];
      await pick(a, fromA);
      await pick(b, fromB);
      const merged = nextId();

      expect((await send('merge_items', { itemId: merged, originalIds: [a, b], title: 'Anna', description: 'Both' })).status).toBe(200);
      expect(await thumbnailOf(merged)).toBeNull();
      const files = (await snapshot()).attachments.filter((file) => file.itemId === merged);
      expect(files.map((file) => file.id).sort()).toEqual([fromA, fromB].sort());

      expect((await send('unmerge_items', { itemId: merged, originalIds: [a, b] })).status).toBe(200);
      expect([await thumbnailOf(a), await thumbnailOf(b)]).toEqual([fromA, fromB]);
      const back = (await snapshot()).attachments;
      expect(back.find((file) => file.id === fromA)?.itemId).toBe(a);
      expect(back.find((file) => file.id === fromB)?.itemId).toBe(b);
    });
  });

  describe('the thumbnail copy opens only for the signed-in account that owns it, with its stored type', () => {
    it('serves the copy as the type it was stored with, never sniffed', async () => {
      const itemId = await aNote();
      const portrait = await attach(itemId, 'image/png', 'portrait.png');
      await pick(itemId, portrait, { contentType: 'image/jpeg' });

      const res = await asUser(`http://cockpit.test/v1/attachments/${portrait}/thumbnail`);

      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('image/jpeg');
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(COPY);
    });

    it('opens nothing for another account’s attachment, or one with no copy', async () => {
      const itemId = await aNote();
      const picked = await attach(itemId, 'image/png', 'picked.png');
      const unpicked = await attach(itemId, 'image/png', 'unpicked.png');
      await pick(itemId, picked);

      const another = await asUser(`http://cockpit.test/v1/attachments/${picked}/thumbnail`, {}, OTHER_USER_ID);
      const none = await asUser(`http://cockpit.test/v1/attachments/${unpicked}/thumbnail`);

      expect([another.status, none.status]).toEqual([404, 404]);
    });
  });
});
