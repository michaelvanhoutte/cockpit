import { afterEach, beforeEach, describe, expect, inject, it } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { workspaceSnapshotSchema } from '@cockpit/shared';
import type { Item } from '@cockpit/shared';
import type { Connector } from '@cockpit/connector-sdk';
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
   * ("Read a connector id as an Item's source", issue 925), Gmail's included
   * ("Take source names out of the shared contract", issue 927). Nothing
   * writes `outlook`, and nothing can name a connector on an Item captured
   * inside Cockpit, so the store is arranged directly: the one case where the
   * interface cannot reach the behaviour.
   */
  describe('an Item whose connector the store names is served under that connector', () => {
    it.each([
      { situation: 'Gmail, under its own id', connector: 'gmail', served: 'gmail' },
      { situation: 'a connector nothing in Cockpit names', connector: 'outlook', served: 'outlook' },
    ])('$situation', async ({ connector, served }) => {
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
      expect(held.source).toBe(served);
    });
  });
});

/** A connector the registry holds in this test alone, so its name can only have come from its manifest. */
const OUTLOOK: Connector = {
  manifest: {
    id: 'outlook',
    displayName: 'Outlook',
    cardText: 'A mailbox.',
    source: 'notion',
    supportsPush: false,
    auth: { kind: 'none' },
  },
  async sync() {},
};

const settings = env as unknown as Record<string, string | undefined>;

/**
 * "Take source names out of the shared contract" (issue 927): what a source is
 * called comes with the Workspace, so the app draws it from the copy it keeps
 * with no request of its own. Integration because the names are the
 * environment's registry, read on the way out of the real route.
 */
describe('Connector management', () => {
  describe('a source is called what its connector calls itself, configured here or not, and a source nothing names by its id', () => {
    afterEach(() => {
      delete env.TEST_CONNECTORS;
    });

    it.each([
      { situation: 'Teams, by its manifest', bot: true, id: 'teams', called: 'Microsoft Teams' },
      { situation: 'a connector registered here alone, by its manifest', bot: true, id: 'outlook', called: 'Outlook' },
      { situation: 'Gmail, by the name the core still gives it', bot: true, id: 'gmail', called: 'Gmail' },
      { situation: 'Claude Code, by the name the core still gives it', bot: true, id: 'claude-code', called: 'Claude Code' },
      { situation: 'Teams where its bot is not configured, by its manifest still', bot: false, id: 'teams', called: 'Microsoft Teams' },
      { situation: 'an app connected to Cockpit: never named here', bot: true, id: 'mcp', called: undefined },
    ])('$situation', async ({ bot, id, called }) => {
      env.TEST_CONNECTORS = [OUTLOOK];
      const kept = settings.MS_BOT_APP_ID;
      if (!bot) delete settings.MS_BOT_APP_ID;
      try {
        const snapshot = await asUser(`http://cockpit.test/v1/workspaces/${WORKSPACE_ID}/snapshot`);
        expect(snapshot.status).toBe(200);
        const { sourceNames } = workspaceSnapshotSchema.parse(await snapshot.json());
        expect(sourceNames?.[id]).toBe(called);
      } finally {
        settings.MS_BOT_APP_ID = kept;
      }
    });
  });
});
