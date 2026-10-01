import { beforeEach, describe, expect, inject, it } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import type { Item } from '@cockpit/shared';
import { TASK_TYPE_ID, WORKSPACE_ID, asUser, seedRegister, startFromEmpty } from '../seed.js';

/**
 * Integration level, through the real Worker: the handler is what writes the
 * priority and due date a capture arrives with, and the route's schema is what
 * refuses one that is not a level or not a calendar day.
 */
beforeEach(async () => {
  await applyD1Migrations(env.DB, inject('migrations'));
  await startFromEmpty();
  await seedRegister();
});

const ITEM_ID = '018f0000-0000-7000-8000-000000000011';

function capture(extra: Record<string, unknown>) {
  return asUser('http://cockpit.test/v1/commands/capture_item', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      commandId: '018f0000-0000-7000-8000-000000000012',
      issuedAt: '2026-09-30T10:00:00.000Z',
      workspaceId: WORKSPACE_ID,
      itemId: ITEM_ID,
      message: 'Send the invoice',
      typeId: TASK_TYPE_ID,
      ...extra,
    }),
  });
}

async function theItem(): Promise<Item | undefined> {
  const snapshot = await asUser(`http://cockpit.test/v1/workspaces/${WORKSPACE_ID}/snapshot`);
  return ((await snapshot.json()) as { items: Item[] }).items.find((item) => item.id === ITEM_ID);
}

describe('Capture', () => {
  describe('makes its Item with the priority and due date the form had, or with none', () => {
    it.each([
      ['neither sent', {}, null, null],
      ['priority sent', { priority: 'high' }, 'high', null],
      ['due date sent', { dueDate: '2026-10-09' }, null, '2026-10-09'],
      ['both sent', { priority: 'low', dueDate: '2026-10-09' }, 'low', '2026-10-09'],
    ])('%s', async (_situation, sent, priority, dueDate) => {
      const response = await capture(sent);
      expect(response.status).toBe(200);

      const item = await theItem();
      expect([item?.priority, item?.dueDate]).toEqual([priority, dueDate]);
    });

    it('starts a due date colouring from the capture itself, as setting one later does', async () => {
      await capture({ dueDate: '2026-10-09' });

      expect((await theItem())?.dueDateSetAt).toBe('2026-09-30T10:00:00.000Z');
    });
  });

  describe('is refused with a priority that is not a level, or a due date that is not a calendar date', () => {
    it.each([
      ['a priority that is not a level', { priority: 'urgent' }],
      ['a due date that is not a date', { dueDate: 'next friday' }],
    ])('%s', async (_situation, sent) => {
      const response = await capture(sent);

      expect(response.status).toBe(400);
      expect(await theItem()).toBeUndefined();
    });
  });
});
