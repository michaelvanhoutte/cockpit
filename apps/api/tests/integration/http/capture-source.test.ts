import { beforeEach, describe, expect, inject, it } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { workspaceSnapshotSchema } from '@cockpit/shared';
import type { Item } from '@cockpit/shared';
import {
  TASK_TYPE_ID,
  WORKSPACE_ID,
  asUser,
  inTheStore,
  seedRegister,
  startFromEmpty,
} from '../seed.js';

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

  /**
   * The wire's source is the connector id the store names, whatever it is
   * (issue 925). Nothing writes `gmail` or `outlook` yet, so the store is
   * arranged directly: the one case where the interface cannot reach the
   * behaviour.
   */
  describe('an Item whose connector the store names is served under that connector', () => {
    it.each([
      { situation: 'Gmail', connector: 'gmail' },
      { situation: 'a connector nothing in Cockpit names', connector: 'outlook' },
    ])('$situation', async ({ connector }) => {
      const itemId = '018f0000-0000-7000-8000-000000000011';
      const captured = await asUser('http://cockpit.test/v1/commands/capture_item', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          commandId: '018f0000-0000-7000-8000-000000000012',
          issuedAt: '2026-09-30T10:00:00.000Z',
          workspaceId: WORKSPACE_ID,
          itemId,
          message: 'Reply to Anna',
          typeId: TASK_TYPE_ID,
        }),
      });
      expect(captured.status).toBe(200);
      await inTheStore((sql) => {
        sql.exec('UPDATE items SET source_connector = ? WHERE id = ?', connector, itemId);
      });

      const snapshot = await asUser(`http://cockpit.test/v1/workspaces/${WORKSPACE_ID}/snapshot`);
      expect(snapshot.status).toBe(200);
      // Parsed the way the web client parses it, so a source the contract refuses fails here.
      const held = workspaceSnapshotSchema.parse(await snapshot.json()).items.find((item) => item.id === itemId)!;
      expect(held.source).toBe(connector);
    });
  });
});
