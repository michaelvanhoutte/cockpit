import { beforeEach, describe, expect, inject, it } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import type { Item } from '@cockpit/shared';
import { TASK_TYPE_ID, WORKSPACE_ID, asUser, seedRegister, startFromEmpty } from '../seed.js';

/**
 * Integration level, through the real Worker: that a browser cannot say where
 * a capture came from is a property of the route, not of any function under it.
 */
beforeEach(async () => {
  await applyD1Migrations(env.DB, inject('migrations'));
  await startFromEmpty();
  await seedRegister();
});

describe('Capture', () => {
  describe('only an app connection can say an Item came from an app', () => {
    it('drops the source a browser names, and the Item is Own', async () => {
      const itemId = '018f0000-0000-7000-8000-000000000001';
      const response = await asUser('http://cockpit.test/v1/commands/capture_item', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          commandId: '018f0000-0000-7000-8000-000000000002',
          issuedAt: '2026-09-30T10:00:00.000Z',
          workspaceId: WORKSPACE_ID,
          itemId,
          message: 'Ring the plumber',
          typeId: TASK_TYPE_ID,
          capturedFrom: { source: 'mcp', sourceId: 'claude-1', sender: 'Claude' },
        }),
      });
      expect(response.status).toBe(200);

      const snapshot = await asUser(`http://cockpit.test/v1/workspaces/${WORKSPACE_ID}/snapshot`);
      const held = ((await snapshot.json()) as { items: Item[] }).items.find(
        (item) => item.id === itemId,
      )!;
      expect([held.source, held.sender]).toEqual(['internal', null]);
    });
  });
});
