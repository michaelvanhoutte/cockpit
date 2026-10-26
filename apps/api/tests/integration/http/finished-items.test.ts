import { beforeEach, describe, expect, inject, it } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import type { CommandName, CommandPayload, FinishedItems } from '@cockpit/shared';
import { WORKSPACE_ID, alsoWorkspaces, asUser, seedRegister, startFromEmpty } from '../seed.js';

/**
 * Integration level, through the real Worker: what a Workspace's finished Items
 * read answers, which *All items* fetches the first time it opens
 * ("Fetch a Workspace's finished Items the first time All items opens", issue
 * 1434). Which of them the table draws and how is the browser's own
 * (`AllItemsBoard.test.tsx`).
 */

const OTHER_WORKSPACE = 'ws-atlas';
const ISSUED = '2026-10-20T10:00:00.000Z';

let seq = 0;
function nextId(): string {
  seq += 1;
  return `018f0000-0000-7000-8000-${String(seq).padStart(12, '0')}`;
}

function post<N extends CommandName>(name: N, payload: Omit<CommandPayload<N>, 'commandId' | 'issuedAt'>) {
  return asUser(`http://cockpit.test/v1/commands/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ commandId: nextId(), issuedAt: ISSUED, ...payload }),
  });
}

async function anItem(workspaceId: string, message: string, extra: { workspaceDecided?: boolean } = {}): Promise<string> {
  const itemId = nextId();
  expect((await post('capture_item', { workspaceId, itemId, message, ...extra })).status).toBe(200);
  return itemId;
}

async function aFinishedItem(workspaceId: string, message: string, extra: { workspaceDecided?: boolean } = {}): Promise<string> {
  const itemId = await anItem(workspaceId, message, extra);
  expect((await post('set_done', { workspaceId, itemId, done: true })).status).toBe(200);
  return itemId;
}

async function aPanel(workspaceId: string, dashboardId: string): Promise<string> {
  const panelId = nextId();
  expect((await post('add_panel', { workspaceId, dashboardId, panelId, name: 'Calls', kind: 'items' })).status).toBe(200);
  return panelId;
}

async function finishedOf(workspaceId = WORKSPACE_ID): Promise<FinishedItems> {
  const response = await asUser(`http://cockpit.test/v1/workspaces/${workspaceId}/finished-items`);
  expect(response.status).toBe(200);
  return (await response.json()) as FinishedItems;
}

const titlesOf = async (workspaceId = WORKSPACE_ID) => (await finishedOf(workspaceId)).items.map((item) => item.title || item.capturedMessage);

beforeEach(async () => {
  await applyD1Migrations(env.DB, inject('migrations'));
  await startFromEmpty();
  await seedRegister();
  await alsoWorkspaces();
});

describe('Dashboards', () => {
  describe('a Workspace’s finished read answers exactly its finished Items that were not dismissed', () => {
    it('lists a finished Item and leaves out an open one, a dismissed finished one, and another Workspace’s', async () => {
      await aFinishedItem(WORKSPACE_ID, 'Paid the invoice');
      await anItem(WORKSPACE_ID, 'Still to do');
      const dismissed = await aFinishedItem(WORKSPACE_ID, 'Dismissed after finishing');
      expect((await post('set_dismissed', { workspaceId: WORKSPACE_ID, itemId: dismissed, dismissed: true })).status).toBe(200);
      await aFinishedItem(OTHER_WORKSPACE, 'Atlas finished');

      expect(await titlesOf()).toEqual(['Paid the invoice']);
      expect(await titlesOf(OTHER_WORKSPACE)).toEqual(['Atlas finished']);
    });

    it('lists an Item not yet settled in a Workspace in every Workspace’s read, as All items lists it today', async () => {
      await aFinishedItem(WORKSPACE_ID, 'Belongs nowhere yet', { workspaceDecided: false });

      expect(await titlesOf()).toEqual(['Belongs nowhere yet']);
      expect(await titlesOf(OTHER_WORKSPACE)).toEqual(['Belongs nowhere yet']);
    });

    it('answers every one of more finished Items than All items draws at once', async () => {
      for (let n = 0; n < 60; n += 1) await aFinishedItem(WORKSPACE_ID, `Finished ${n}`);

      expect((await finishedOf()).items).toHaveLength(60);
    });

    it('refuses a Workspace that is not there rather than answering nothing finished', async () => {
      const response = await asUser('http://cockpit.test/v1/workspaces/ws-nothing/finished-items');

      expect(response.status).toBe(404);
    });
  });

  describe('a finished Item comes with where it is filed and what is attached to it', () => {
    it('answers the filings and the files of the finished Items it lists, and not those of an open one', async () => {
      const panelId = await aPanel(WORKSPACE_ID, `${WORKSPACE_ID}-dashboard-1`);
      const finished = await anItem(WORKSPACE_ID, 'Filed, then finished');
      const open = await anItem(WORKSPACE_ID, 'Filed and open');
      for (const order of [[finished], [finished, open]]) {
        const itemId = order.at(-1)!;
        expect((await post('add_item_to_panel', { workspaceId: WORKSPACE_ID, itemId, panelId, order })).status).toBe(200);
      }
      for (const itemId of [finished, open]) {
        const filename = itemId === finished ? 'receipt.png' : 'notes.png';
        const uploaded = await asUser(`http://cockpit.test/v1/items/${itemId}/attachments`, {
          method: 'POST',
          headers: {
            'content-type': 'image/png',
            'x-attachment-id': nextId(),
            'x-command-id': nextId(),
            'x-issued-at': ISSUED,
            'x-workspace-id': WORKSPACE_ID,
            'x-filename': filename,
          },
          body: new Uint8Array([1, 2, 3]),
        });
        expect(uploaded.status).toBe(201);
      }
      expect((await post('set_done', { workspaceId: WORKSPACE_ID, itemId: finished, done: true })).status).toBe(200);

      const read = await finishedOf();

      expect(read.filings).toEqual([{ itemId: finished, panelId, position: expect.any(Number) }]);
      expect(read.attachments.map((file) => [file.itemId, file.filename])).toEqual([[finished, 'receipt.png']]);
    });
  });
});
