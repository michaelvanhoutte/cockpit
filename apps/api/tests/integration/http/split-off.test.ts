import { beforeEach, describe, expect, inject, it } from 'vitest';
import { applyD1Migrations, env } from 'cloudflare:test';
import type { Item } from '@cockpit/shared';
import { WORKSPACE_ID, asUser, seedRegister, startFromEmpty } from '../seed.js';

/**
 * Integration level, through the real Worker (`asUser`): which Item another was
 * split off from is a column in the account's own store, read back with the
 * Workspace, and whether a link is kept depends on what that store holds. What
 * the new Item is called and what is left in the original are the form's, and
 * proved in apps/web.
 */

let seq = 0;
function nextId(): string {
  seq += 1;
  return `018f0000-0000-7000-8000-${String(seq).padStart(12, '0')}`;
}

const AT = '2026-10-01T10:00:00.000Z';

async function send(command: string, body: Record<string, unknown>) {
  return asUser(`http://cockpit.test/v1/commands/${command}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ commandId: nextId(), issuedAt: AT, ...body }),
  });
}

async function capture(workspaceId: string, extra: Record<string, unknown> = {}) {
  const itemId = nextId();
  const response = await send('capture_item', { workspaceId, itemId, message: 'Plan the party', ...extra });
  expect(response.status).toBe(200);
  return itemId;
}

async function itemsOf(workspaceId: string): Promise<Item[]> {
  const response = await asUser(`http://cockpit.test/v1/workspaces/${workspaceId}/snapshot`);
  return ((await response.json()) as { items: Item[] }).items;
}

beforeEach(async () => {
  await applyD1Migrations(env.DB, inject('migrations'));
  await startFromEmpty();
  await seedRegister();
});

describe('Item editing', () => {
  describe('an item split off another names it, and keeps the words it was given', () => {
    it('is read back with the item it came from, its texts settled', async () => {
      const original = await capture(WORKSPACE_ID);
      const split = await capture(WORKSPACE_ID, {
        title: 'Order the cake',
        message: 'Order the **cake** today',
        splitFromItemId: original,
      });

      const held = (await itemsOf(WORKSPACE_ID)).find((item) => item.id === split);
      expect(held).toMatchObject({
        splitFromItemId: original,
        title: 'Order the cake',
        description: 'Order the **cake** today',
        textsSettledAt: AT,
      });
      expect((await itemsOf(WORKSPACE_ID)).find((item) => item.id === original)?.splitFromItemId).toBeNull();
    });

    it.each([
      { situation: 'an item that does not exist', from: async () => nextId() },
      {
        situation: 'an item of another Workspace',
        from: async () => {
          const workspaceId = nextId();
          expect((await send('create_workspace', { workspaceId, panelId: nextId(), name: 'Elsewhere' })).status).toBe(200);
          return capture(workspaceId);
        },
      },
    ])('is still made, without the link, when it names $situation', async ({ from }) => {
      const split = await capture(WORKSPACE_ID, { title: 'Order the cake', splitFromItemId: await from() });

      const held = (await itemsOf(WORKSPACE_ID)).find((item) => item.id === split);
      expect(held?.splitFromItemId).toBeNull();
      expect(held?.title).toBe('Order the cake');
    });
  });
});
