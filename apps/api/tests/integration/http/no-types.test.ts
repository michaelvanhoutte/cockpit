import { beforeEach, describe, expect, inject, it } from 'vitest';
import { applyD1Migrations, env } from 'cloudflare:test';
import { ACCOUNT_WIDE } from '@cockpit/shared';
import { TASK_TYPE_ID, WORKSPACE_ID, asUser, inTheStore, seedRegister, startFromEmpty } from '../seed.js';

/**
 * Integration level, through the real Worker (`asUser`): whether an address
 * answers is a fact about the router, and whether a read says anything about
 * Type over a store that still holds Type rows is a fact about a real store
 * ("Remove Types from Settings, the commands and the wire", issue 1069).
 *
 * `404`, not the `410` the retired learning commands answer: nothing is
 * pointed at a replacement, and a tab from before the deploy failing its reads
 * is accepted.
 */

const AT = '2026-10-14T10:00:00.000Z';
const FIRST_ITEM = '018f0000-0000-7000-8000-000000000101';
const SECOND_ITEM = '018f0000-0000-7000-8000-000000000102';

const post = (path: string, body: object) =>
  asUser(`http://cockpit.test${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

beforeEach(async () => {
  await applyD1Migrations(env.DB, inject('migrations'));
  await startFromEmpty();
  await seedRegister();
});

describe('Management windows', () => {
  describe('nothing can change a Type any more', () => {
    it.each([
      { situation: 'making a Type', name: 'create_item_type', extra: { name: 'Question' } },
      { situation: 'renaming a Type', name: 'rename_item_type', extra: { name: 'Question' } },
      { situation: 'recolouring a Type', name: 'set_item_type_color', extra: { color: '#000000' } },
      { situation: 'deleting a Type', name: 'delete_item_type', extra: {} },
      { situation: 'reordering the Types', name: 'reorder_item_types', extra: { typeIds: [TASK_TYPE_ID] } },
      { situation: 'setting an Item’s Type', name: 'set_item_type', extra: { itemId: FIRST_ITEM } },
    ])('refuses $situation as a command nobody knows', async ({ name, extra }) => {
      const response = await post(`/v1/commands/${name}`, {
        commandId: '018f0000-0000-7000-8000-000000000001',
        issuedAt: AT,
        workspaceId: ACCOUNT_WIDE,
        typeId: TASK_TYPE_ID,
        ...extra,
      });

      expect(response.status).toBe(404);
    });

    it('no longer lists the Types', async () => {
      const response = await asUser('http://cockpit.test/v1/item-types');

      expect(response.status).toBe(404);
    });
  });
});

describe('Workspaces', () => {
  describe('opening one says nothing about Type, even over a store that still holds it', () => {
    it('returns Items without a Type, and no Types, where the store holds both', async () => {
      for (const [at, itemId] of [FIRST_ITEM, SECOND_ITEM].entries()) {
        const captured = await post('/v1/commands/capture_item', {
          commandId: `018f0000-0000-7000-8000-00000000030${at}`,
          issuedAt: AT,
          workspaceId: WORKSPACE_ID,
          itemId,
          message: 'Make appointment with Novy',
        });
        expect(captured.status).toBe(200);
      }
      await inTheStore((sql) => {
        sql.exec('UPDATE items SET type_id = ?', TASK_TYPE_ID);
      });
      const [held] = await inTheStore((sql) => sql.exec('SELECT COUNT(*) AS n FROM item_types').toArray());
      expect(Number(held?.n)).toBeGreaterThan(0);

      const snapshot = (await (await asUser(`http://cockpit.test/v1/workspaces/${WORKSPACE_ID}/snapshot`)).json()) as {
        items: object[];
      };

      expect(snapshot).not.toHaveProperty('itemTypes');
      const captured = snapshot.items.filter((item) => [FIRST_ITEM, SECOND_ITEM].includes((item as { id: string }).id));
      expect(captured).toHaveLength(2);
      for (const item of snapshot.items) expect(item).not.toHaveProperty('typeId');
    });

    it('returns an Item whose Type was deleted, unchanged otherwise', async () => {
      await post('/v1/commands/capture_item', {
        commandId: '018f0000-0000-7000-8000-000000000201',
        issuedAt: AT,
        workspaceId: WORKSPACE_ID,
        itemId: FIRST_ITEM,
        message: 'Make appointment with Novy',
      });
      await inTheStore((sql) => {
        sql.exec('UPDATE items SET type_id = ?', TASK_TYPE_ID);
        sql.exec('UPDATE item_types SET deleted_at = ? WHERE id = ?', AT, TASK_TYPE_ID);
      });

      const snapshot = (await (await asUser(`http://cockpit.test/v1/workspaces/${WORKSPACE_ID}/snapshot`)).json()) as {
        items: { id: string; capturedMessage: string | null }[];
      };

      const item = snapshot.items.find((candidate) => candidate.id === FIRST_ITEM);
      expect(item).toMatchObject({ id: FIRST_ITEM, capturedMessage: 'Make appointment with Novy' });
      expect(item).not.toHaveProperty('typeId');
    });
  });
});
