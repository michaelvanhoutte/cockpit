import { beforeEach, describe, expect, inject, it } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { ACCOUNT_WIDE, MAX_ATTACHMENT_SIZE } from '@cockpit/shared';
import type { CommandName, CommandPayload } from '@cockpit/shared';
import {
  ACCOUNT_NAME,
  OTHER_USER_ID,
  TASK_TYPE_ID,
  WORKSPACE_ID,
  asUser,
  inTheStore,
  seedRegister,
  startFromEmpty,
} from '../seed.js';

/**
 * Integration level: real D1 and a real account store, entered through the
 * real Worker (`SELF.fetch`/`asUser`) - the same reason `item-changes.test.ts`
 * does, and the upload/download routes are plain (non-`.openapi`) routes for
 * exactly the same reasons every other route here is real infrastructure.
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

async function captureAnItem(overrides: Partial<CommandPayload<'capture_item'>> = {}) {
  const itemId = overrides.itemId ?? nextId();
  await postChange('capture_item', {
    commandId: nextId(),
    issuedAt: '2026-09-16T10:00:00.000Z',
    workspaceId: WORKSPACE_ID,
    itemId,
    message: 'A scanned receipt',
    typeId: TASK_TYPE_ID,
    ...overrides,
  });
  return itemId;
}

async function upload(
  itemId: string,
  bytes: Uint8Array,
  {
    contentType = 'image/png',
    filename = 'photo.png',
    attachmentId = nextId(),
    commandId = nextId(),
    workspaceId = WORKSPACE_ID,
    issuedAt = '2026-09-16T10:00:00.000Z',
    userId,
  }: {
    contentType?: string;
    filename?: string;
    attachmentId?: string;
    commandId?: string;
    workspaceId?: string;
    issuedAt?: string;
    userId?: string;
  } = {},
) {
  return asUser(
    `http://cockpit.test/v1/items/${itemId}/attachments`,
    {
      method: 'POST',
      headers: {
        'content-type': contentType,
        'x-attachment-id': attachmentId,
        'x-command-id': commandId,
        'x-issued-at': issuedAt,
        'x-workspace-id': workspaceId,
        'x-filename': encodeURIComponent(filename),
      },
      body: bytes,
    },
    userId,
  );
}

async function loggedWorkspaceFor(name: string) {
  return inTheStore((sql) =>
    sql
      .exec<{ workspace_id: string }>(
        'SELECT workspace_id FROM commands WHERE name = ? ORDER BY received_at DESC LIMIT 1',
        name,
      )
      .toArray(),
  );
}

async function readSnapshot() {
  const res = await asUser(`http://cockpit.test/v1/workspaces/${WORKSPACE_ID}/snapshot`);
  return res.json() as Promise<{
    items: { id: string }[];
    attachments: { id: string; itemId: string; filename: string; size: number; contentType: string }[];
  }>;
}

beforeEach(async () => {
  await applyD1Migrations(env.DB, inject('migrations'));
  await startFromEmpty();
  await seedRegister();
});

describe('Item editing', () => {
  describe('a file within the size cap and an allowed type is attached to an item', () => {
    it('is stored, and shows up on the item - metadata only, never the bytes', async () => {
      const itemId = await captureAnItem();
      const bytes = new Uint8Array([1, 2, 3, 4]);
      const res = await upload(itemId, bytes, { filename: 'receipt.png' });
      expect(res.status).toBe(201);

      const snapshot = await readSnapshot();
      const attachment = snapshot.attachments.find((a) => a.itemId === itemId);
      expect(attachment).toMatchObject({
        itemId,
        filename: 'receipt.png',
        size: bytes.byteLength,
        contentType: 'image/png',
      });
      expect(JSON.stringify(snapshot.attachments)).not.toContain('1,2,3,4');

      const row = await inTheStore((sql) =>
        sql.exec('SELECT * FROM attachments WHERE item_id = ?', itemId).toArray(),
      );
      expect(row).toHaveLength(1);
    });
  });

  describe('a file over the size cap is refused, and nothing is written', () => {
    it('is refused before the upload reads the body', async () => {
      const itemId = await captureAnItem();
      const oversized = new Uint8Array(MAX_ATTACHMENT_SIZE + 1);
      const res = await upload(itemId, oversized);
      expect(res.status).toBe(413);

      const snapshot = await readSnapshot();
      expect(snapshot.attachments.filter((a) => a.itemId === itemId)).toHaveLength(0);
    });
  });

  describe('a file whose type is not on the allowlist is refused, and nothing is written', () => {
    it('is refused', async () => {
      const itemId = await captureAnItem();
      const res = await upload(itemId, new Uint8Array([1]), { contentType: 'application/zip' });
      expect(res.status).toBe(400);

      const snapshot = await readSnapshot();
      expect(snapshot.attachments.filter((a) => a.itemId === itemId)).toHaveLength(0);
    });
  });

  describe('downloading an attachment', () => {
    it('streams it back, with its stored filename and always its stored, allowlisted type', async () => {
      const itemId = await captureAnItem();
      const bytes = new Uint8Array([9, 8, 7, 6]);
      const uploaded = await upload(itemId, bytes, { filename: 'a chart.png' });
      const { attachments } = (await (
        await asUser(`http://cockpit.test/v1/workspaces/${WORKSPACE_ID}/snapshot`)
      ).json()) as { attachments: { id: string; itemId: string }[] };
      const attachmentId = attachments.find((a) => a.itemId === itemId)!.id;
      expect(uploaded.status).toBe(201);

      const res = await asUser(`http://cockpit.test/v1/attachments/${attachmentId}`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('image/png');
      expect(res.headers.get('content-disposition')).toContain('a%20chart.png');
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
    });

    it('is refused to someone signed into a different account', async () => {
      const itemId = await captureAnItem();
      await upload(itemId, new Uint8Array([1]));
      const { attachments } = await readSnapshot();
      const attachmentId = attachments.find((a) => a.itemId === itemId)!.id;

      const res = await asUser(`http://cockpit.test/v1/attachments/${attachmentId}`, {}, OTHER_USER_ID);
      expect(res.status).toBe(404);
    });

    it('is a 404, not a 500, for an id that never existed', async () => {
      const res = await asUser(`http://cockpit.test/v1/attachments/${nextId()}`);
      expect(res.status).toBe(404);
    });

    it('is a 404, not a 500, for an attachment belonging to a deleted item', async () => {
      const itemId = await captureAnItem();
      await upload(itemId, new Uint8Array([1]));
      const { attachments } = await readSnapshot();
      const attachmentId = attachments.find((a) => a.itemId === itemId)!.id;
      // No command tombstones an item today (architecture, "Tombstones, not
      // deletes, for Items" is a schema convention with no live writer yet) -
      // written directly, the one exception the testing skill allows for a
      // rule the real interface cannot reach.
      await inTheStore((sql) =>
        sql.exec('UPDATE items SET deleted_at = ? WHERE id = ?', '2026-09-16T11:00:00.000Z', itemId),
      );

      const res = await asUser(`http://cockpit.test/v1/attachments/${attachmentId}`);
      expect(res.status).toBe(404);
    });
  });

  describe('removing an attachment', () => {
    it('is gone from the item afterwards, and the file itself is left in place', async () => {
      const itemId = await captureAnItem();
      await upload(itemId, new Uint8Array([1, 2]));
      const before = await readSnapshot();
      const attachment = before.attachments.find((a) => a.itemId === itemId)!;

      const res = await postChange('remove_attachment', {
        commandId: nextId(),
        issuedAt: '2026-09-16T12:00:00.000Z',
        workspaceId: WORKSPACE_ID,
        itemId,
        attachmentId: attachment.id,
      });
      expect(res.status).toBe(200);

      const after = await readSnapshot();
      expect(after.attachments.find((a) => a.id === attachment.id)).toBeUndefined();

      const stillDownloadable = await asUser(`http://cockpit.test/v1/attachments/${attachment.id}`);
      // The reference is gone (404), but the object itself was never asked
      // to be deleted - checked directly against R2, since the download
      // route answers 404 for the *reference* either way (env.ts).
      expect(stillDownloadable.status).toBe(404);
      const key = `${ACCOUNT_NAME}/${itemId}/${attachment.id}`;
      expect(await env.ATTACHMENTS.get(key)).not.toBeNull();
    });

    it('removing one already removed leaves nothing to go wrong - no error, no second effect', async () => {
      const itemId = await captureAnItem();
      await upload(itemId, new Uint8Array([1, 2]));
      const { attachments } = await readSnapshot();
      const attachment = attachments.find((a) => a.itemId === itemId)!;

      await postChange('remove_attachment', {
        commandId: nextId(),
        issuedAt: '2026-09-16T12:00:00.000Z',
        workspaceId: WORKSPACE_ID,
        itemId,
        attachmentId: attachment.id,
      });
      // A different commandId naming the same, already-removed attachment -
      // a retried removal rather than a replay of the very same command.
      const again = await postChange('remove_attachment', {
        commandId: nextId(),
        issuedAt: '2026-09-16T12:00:01.000Z',
        workspaceId: WORKSPACE_ID,
        itemId,
        attachmentId: attachment.id,
      });
      expect(again.status).toBe(200);

      const after = await readSnapshot();
      expect(after.attachments.find((a) => a.id === attachment.id)).toBeUndefined();
    });
  });

  describe('an item belonging to no workspace yet is drawn, attachments included, in every Inbox', () => {
    it('logs attaching a file against the account, not the workspace it was captured from', async () => {
      const itemId = await captureAnItem({ workspaceDecided: false });
      await upload(itemId, new Uint8Array([1, 2]));
      expect((await loggedWorkspaceFor('add_attachment'))[0]?.workspace_id).toBe(ACCOUNT_WIDE);
    });

    it('logs removing one against the account too, because every other Inbox loses it', async () => {
      const itemId = await captureAnItem({ workspaceDecided: false });
      await upload(itemId, new Uint8Array([1, 2]));
      const { attachments } = await readSnapshot();
      const attachment = attachments.find((a) => a.itemId === itemId)!;

      await postChange('remove_attachment', {
        commandId: nextId(),
        issuedAt: '2026-09-16T12:00:00.000Z',
        workspaceId: WORKSPACE_ID,
        itemId,
        attachmentId: attachment.id,
      });
      expect((await loggedWorkspaceFor('remove_attachment'))[0]?.workspace_id).toBe(ACCOUNT_WIDE);
    });
  });
});
