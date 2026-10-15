import { beforeEach, describe, expect, inject, it } from 'vitest';
import { applyD1Migrations, env } from 'cloudflare:test';
import { DASHBOARD_ID, WORKSPACE_ID, asUser, inTheStore, seedRegister, startFromEmpty } from '../seed.js';

/**
 * Integration level, through the real Worker (`asUser`): a capture filed on
 * Panels is one write in the account's own store, and whether it lands on a
 * Panel, in the Inbox or in the decision history is a fact about that store
 * ("File a note on Panels from Capture, skipping the Inbox", issue 1101).
 */

let seq = 0;
function nextId(): string {
  seq += 1;
  return `018f0000-0000-7000-8000-${String(seq).padStart(12, '0')}`;
}

const AT = '2026-10-01T10:00:00.000Z';

async function send(command: string, body: Record<string, unknown>, commandId = nextId()) {
  return asUser(`http://cockpit.test/v1/commands/${command}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ commandId, issuedAt: AT, ...body }),
  });
}

async function aPanel(name: string, kind: 'items' | 'text' | 'filter' = 'items'): Promise<string> {
  const panelId = nextId();
  expect(
    (await send('add_panel', { workspaceId: WORKSPACE_ID, dashboardId: DASHBOARD_ID, panelId, name, kind })).status,
  ).toBe(200);
  return panelId;
}

/** A Panel of another Workspace, which a capture of this one may not file on. */
async function aPanelElsewhere(): Promise<string> {
  const workspaceId = nextId();
  const panelId = nextId();
  expect((await send('create_workspace', { workspaceId, panelId, name: 'Elsewhere' })).status).toBe(200);
  return panelId;
}

async function capture(extra: Record<string, unknown>, itemId = nextId(), commandId = nextId()) {
  const response = await send(
    'capture_item',
    { workspaceId: WORKSPACE_ID, itemId, message: 'Send the invoice', ...extra },
    commandId,
  );
  expect(response.status).toBe(200);
  return itemId;
}

/** The ids on a Panel, top to bottom, and the ids in the Inbox - both read off the Workspace's snapshot. */
async function whereThingsAre() {
  const response = await asUser(`http://cockpit.test/v1/workspaces/${WORKSPACE_ID}/snapshot`);
  const held = (await response.json()) as {
    items: { id: string }[];
    filings: { panelId: string; itemId: string; position: number }[];
  };
  const filed = new Set(held.filings.map((filing) => filing.itemId));
  return {
    inbox: held.items.filter((item) => !filed.has(item.id)).map((item) => item.id),
    on: (panelId: string) =>
      held.filings
        .filter((filing) => filing.panelId === panelId)
        .sort((a, b) => a.position - b.position)
        .map((filing) => filing.itemId),
  };
}

async function historyFor(itemId: string) {
  return inTheStore((sql) =>
    sql
      .exec<{ proposed_panel_id: string | null; chosen_panel_id: string }>(
        'SELECT proposed_panel_id, chosen_panel_id FROM decision_history WHERE item_id = ?',
        itemId,
      )
      .toArray(),
  );
}

beforeEach(async () => {
  await applyD1Migrations(env.DB, inject('migrations'));
  await startFromEmpty();
  await seedRegister();
  seq = 0;
});

describe('Capture', () => {
  describe('a capture filed on Panels is on them and not in the Inbox', () => {
    it('is on the one Panel it names, at the top, and not in the Inbox', async () => {
      const falcon = await aPanel('Falcon');
      const earlier = await capture({ panelIds: [falcon] });

      const itemId = await capture({ panelIds: [falcon] });

      const now = await whereThingsAre();
      expect(now.on(falcon)).toEqual([itemId, earlier]);
      expect(now.inbox).not.toContain(itemId);
    });

    it('is on every Panel it names, at the top of each', async () => {
      const falcon = await aPanel('Falcon');
      const anna = await aPanel('Anna');
      const earlier = await capture({ panelIds: [anna] });

      const itemId = await capture({ panelIds: [falcon, anna] });

      const now = await whereThingsAre();
      expect(now.on(falcon)).toEqual([itemId]);
      expect(now.on(anna)).toEqual([itemId, earlier]);
    });

    it('is in the Inbox when it names none', async () => {
      const itemId = await capture({});

      expect((await whereThingsAre()).inbox).toContain(itemId);
    });
  });

  describe('a capture is never refused for its filing', () => {
    it('lands on the Panel that is left when another it named was deleted', async () => {
      const falcon = await aPanel('Falcon');
      const gone = await aPanel('Anna');
      expect((await send('delete_panel', { workspaceId: WORKSPACE_ID, panelId: gone })).status).toBe(200);

      const itemId = await capture({ panelIds: [gone, falcon] });

      const now = await whereThingsAre();
      expect(now.on(falcon)).toEqual([itemId]);
      expect(now.on(gone)).toEqual([]);
    });

    it.each([
      { situation: 'its only Panel was deleted', panel: async () => {
        const gone = await aPanel('Anna');
        await send('delete_panel', { workspaceId: WORKSPACE_ID, panelId: gone });
        return gone;
      } },
      { situation: 'it names a Panel of another Workspace', panel: aPanelElsewhere },
      { situation: 'it names a Panel of text', panel: () => aPanel('Notes', 'text') },
      { situation: 'it names a Filter', panel: () => aPanel('Overdue', 'filter') },
      { situation: 'it names a Panel that never existed', panel: async () => nextId() },
    ])('lands in the Inbox when $situation', async ({ panel }) => {
      const named = await panel();

      const itemId = await capture({ panelIds: [named] });

      expect((await whereThingsAre()).inbox).toContain(itemId);
    });
  });

  describe('filing at capture is the person’s decision', () => {
    it('records one decision with no proposal, naming the first Panel, however many it is filed on', async () => {
      const falcon = await aPanel('Falcon');
      const anna = await aPanel('Anna');

      const itemId = await capture({ panelIds: [falcon, anna] });

      expect(await historyFor(itemId)).toEqual([{ proposed_panel_id: null, chosen_panel_id: falcon }]);
    });

    it('records nothing for a capture to the Inbox', async () => {
      const itemId = await capture({});

      expect(await historyFor(itemId)).toEqual([]);
    });
  });

  describe('the same capture sent twice files once', () => {
    it('makes one Item, one filing on each Panel and one decision', async () => {
      const falcon = await aPanel('Falcon');
      const anna = await aPanel('Anna');
      const itemId = nextId();
      const commandId = nextId();

      await capture({ panelIds: [falcon, anna] }, itemId, commandId);
      await capture({ panelIds: [falcon, anna] }, itemId, commandId);

      const now = await whereThingsAre();
      expect([now.on(falcon), now.on(anna)]).toEqual([[itemId], [itemId]]);
      expect(await historyFor(itemId)).toHaveLength(1);
    });

    it('does not file again when the Item was made by an earlier send under another command id', async () => {
      const falcon = await aPanel('Falcon');
      const anna = await aPanel('Anna');
      const itemId = nextId();
      await capture({}, itemId);

      await capture({ panelIds: [falcon, anna] }, itemId);

      const now = await whereThingsAre();
      expect([now.on(falcon), now.on(anna)]).toEqual([[], []]);
    });
  });
});
