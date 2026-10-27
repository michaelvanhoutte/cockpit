import { afterEach, beforeEach, describe, expect, inject, it, vi } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import type { CommandName, CommandPayload, FinishedItems, WorkspaceSnapshot } from '@cockpit/shared';
import { DASHBOARD_ID, WORKSPACE_ID, asUser, seedRegister, startFromEmpty } from '../seed.js';

/**
 * Integration level, through the real Worker: which Items opening a Workspace
 * brings, and what a move on a Panel is checked against once the finished ones
 * older than a day are left to *All items* ("Open a Workspace without its
 * finished Items", issue 1435). Both are queries over the store's own rows,
 * against its own clock, so neither exists below a real store. Which orders the
 * check refuses, given what it is handed, is
 * apps/api/tests/unit/domain/filings.test.ts; the finished Items' own read is
 * finished-items.test.ts.
 *
 * The clock is the store's: fixed for every case, and an Item is finished by a
 * change issued that many hours before it, as a device's own clock stamps one.
 */

const HOUR = 60 * 60 * 1000;

/** The store's clock for every case: the real time, fixed, so the sign-in the requests carry is still good. */
const NOW = Date.now(); // clock-ok: fixed once as the store's clock, since a sign-in is checked against it

const hoursAgo = (hours: number) => new Date(NOW - hours * HOUR).toISOString();

let seq = 0;
function nextId(): string {
  seq += 1;
  return `018f0000-0000-7000-8000-${String(seq).padStart(12, '0')}`;
}

function post<N extends CommandName>(
  name: N,
  payload: Omit<CommandPayload<N>, 'commandId' | 'issuedAt'>,
  // Before any Item here is finished, so no change made after it is older than the one it follows.
  issuedAt = hoursAgo(24 * 20),
) {
  return asUser(`http://cockpit.test/v1/commands/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ commandId: nextId(), issuedAt, ...payload }),
  });
}

async function anItem(message: string): Promise<string> {
  const itemId = nextId();
  expect((await post('capture_item', { workspaceId: WORKSPACE_ID, itemId, message }, hoursAgo(24 * 30))).status).toBe(200);
  return itemId;
}

async function finish(itemId: string, hours: number): Promise<void> {
  expect((await post('set_done', { workspaceId: WORKSPACE_ID, itemId, done: true }, hoursAgo(hours))).status).toBe(200);
}

async function aFinishedItem(message: string, hours: number): Promise<string> {
  const itemId = await anItem(message);
  await finish(itemId, hours);
  return itemId;
}

async function aPanel(): Promise<string> {
  const panelId = nextId();
  expect((await post('add_panel', { workspaceId: WORKSPACE_ID, dashboardId: DASHBOARD_ID, panelId, name: `Calls ${seq}`, kind: 'items' })).status).toBe(200);
  return panelId;
}

/** Files each Item on the Panel in turn, below the ones before it. */
async function fileInOrder(panelId: string, itemIds: string[]): Promise<void> {
  for (let at = 0; at < itemIds.length; at += 1) {
    const order = itemIds.slice(0, at + 1);
    expect((await post('add_item_to_panel', { workspaceId: WORKSPACE_ID, itemId: itemIds[at]!, panelId, order })).status).toBe(200);
  }
}

function move(itemId: string, panelId: string, order: string[]) {
  return post('move_item_to_panel', { workspaceId: WORKSPACE_ID, itemId, panelId, order }, hoursAgo(0));
}

async function opened(): Promise<WorkspaceSnapshot> {
  const response = await asUser(`http://cockpit.test/v1/workspaces/${WORKSPACE_ID}/snapshot`);
  expect(response.status).toBe(200);
  return (await response.json()) as WorkspaceSnapshot;
}

async function finishedOf(): Promise<FinishedItems> {
  const response = await asUser(`http://cockpit.test/v1/workspaces/${WORKSPACE_ID}/finished-items`);
  expect(response.status).toBe(200);
  return (await response.json()) as FinishedItems;
}

const brings = async (itemId: string) => (await opened()).items.some((item) => item.id === itemId);

/** The Items on one Panel, in the order the store answers them. */
const onThePanel = (read: { filings: WorkspaceSnapshot['filings'] }, panelId: string) =>
  read.filings.filter((filing) => filing.panelId === panelId).map((filing) => filing.itemId);

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'], now: NOW });
  await applyD1Migrations(env.DB, inject('migrations'));
  await startFromEmpty();
  await seedRegister();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Dashboards', () => {
  describe('opening a Workspace brings its open Items and the last day’s finished ones, and leaves the rest to All items', () => {
    it.each([
      { situation: 'an open Item', hours: null, brought: true },
      { situation: 'one finished 23 hours ago', hours: 23, brought: true },
      { situation: 'one finished exactly 24 hours ago', hours: 24, brought: false },
      { situation: 'one finished 25 hours ago', hours: 25, brought: false },
    ])('$situation', async ({ hours, brought }) => {
      const itemId = hours === null ? await anItem('Call the plumber') : await aFinishedItem('Call the plumber', hours);

      expect(await brings(itemId)).toBe(brought);
    });

    it('brings none of more finished Items than fit on a screen, all finished before the last day', async () => {
      const finished = new Set<string>();
      for (let n = 0; n < 60; n += 1) finished.add(await aFinishedItem(`Finished ${n}`, 30));

      const read = await opened();

      expect(read.items.filter((item) => finished.has(item.id))).toEqual([]);
      expect((await finishedOf()).items).toHaveLength(60);
    });
  });

  describe('an Item left out leaves with where it is filed, its files and its links', () => {
    it('brings none of a left-out Item’s filings, files or links, and a recently finished one’s all', async () => {
      const panelId = await aPanel();
      const leftOut = await anItem('Paid the invoice');
      const recent = await anItem('Sent the quote');
      await fileInOrder(panelId, [leftOut, recent]);
      for (const itemId of [leftOut, recent]) {
        const uploaded = await asUser(`http://cockpit.test/v1/items/${itemId}/attachments`, {
          method: 'POST',
          headers: {
            'content-type': 'image/png',
            'x-attachment-id': nextId(),
            'x-command-id': nextId(),
            'x-issued-at': hoursAgo(24 * 20),
            'x-workspace-id': WORKSPACE_ID,
            'x-filename': 'receipt.png',
          },
          body: new Uint8Array([1, 2, 3]),
        });
        expect(uploaded.status).toBe(201);
        expect(
          (await post('associate', { workspaceId: WORKSPACE_ID, itemId, associationId: nextId(), kind: 'person', label: 'Anna' })).status,
        ).toBe(200);
      }
      await finish(leftOut, 30);
      await finish(recent, 2);

      const read = await opened();
      const whose = (rows: { itemId: string }[]) => [...new Set(rows.map((row) => row.itemId))].filter((id) => id === leftOut || id === recent);

      expect(whose(read.filings)).toEqual([recent]);
      expect(whose(read.attachments)).toEqual([recent]);
      expect(whose(read.associations)).toEqual([recent]);
    });
  });
});

describe('Workspace management', () => {
  describe('opening a Workspace says how many finished Items it left out', () => {
    it.each([
      { situation: '3 open and 2 finished before the last day', open: 3, finishedHoursAgo: [30, 200], leftOut: 2 },
      { situation: 'one finished in the last day, which it brings', open: 1, finishedHoursAgo: [3], leftOut: 0 },
      { situation: 'none finished', open: 2, finishedHoursAgo: [], leftOut: 0 },
    ])('$situation', async ({ open, finishedHoursAgo, leftOut }) => {
      for (let n = 0; n < open; n += 1) await anItem(`Open ${n}`);
      for (const hours of finishedHoursAgo) await aFinishedItem(`Finished ${hours}`, hours);

      expect((await opened()).finishedItemsLeftOut).toBe(leftOut);
    });

    it('counts no dismissed Item, which no list of the Workspace holds either', async () => {
      const dismissed = await aFinishedItem('Dismissed after finishing', 30);
      expect((await post('set_dismissed', { workspaceId: WORKSPACE_ID, itemId: dismissed, dismissed: true }, hoursAgo(1))).status).toBe(200);

      expect((await opened()).finishedItemsLeftOut).toBe(0);
    });
  });
});

describe('Panels', () => {
  describe('a move is checked against a Panel’s open and recently finished Items only', () => {
    it.each([
      { situation: 'an order leaving out an Item finished last week', finishedHoursAgo: 24 * 7, names: false, accepted: true },
      { situation: 'an order still naming it, as a previous app sends', finishedHoursAgo: 24 * 7, names: true, accepted: true },
      { situation: 'an order leaving out an open Item', finishedHoursAgo: null, names: false, accepted: false },
      { situation: 'an order leaving out an Item finished an hour ago', finishedHoursAgo: 1, names: false, accepted: false },
    ])('$situation', async ({ finishedHoursAgo, names, accepted }) => {
      const panelId = await aPanel();
      const kept = await anItem('Renew the domain');
      const other = await anItem('Pay the invoice');
      await fileInOrder(panelId, [kept, other]);
      if (finishedHoursAgo !== null) await finish(other, finishedHoursAgo);
      const arriving = await anItem('Reply to Bart');

      const answer = await move(arriving, panelId, names ? [arriving, kept, other] : [arriving, kept]);

      expect(answer.status).toBe(accepted ? 200 : 409);
    });

    it('keeps a left-out Item filed where it was, so All items still says where it is', async () => {
      const panelId = await aPanel();
      const kept = await anItem('Renew the domain');
      const finished = await anItem('Pay the invoice');
      await fileInOrder(panelId, [kept, finished]);
      await finish(finished, 24 * 7);
      const arriving = await anItem('Reply to Bart');

      expect((await move(arriving, panelId, [arriving, kept])).status).toBe(200);

      expect(onThePanel(await opened(), panelId)).toEqual([arriving, kept]);
      expect((await finishedOf()).filings).toEqual([{ itemId: finished, panelId, position: 1 }]);
    });
  });

  describe('an Item reopened after its day takes back its place, the same on every device', () => {
    it('breaks a tie with the Item it shares a place with in one order, read the same twice', async () => {
      const panelId = await aPanel();
      // Made first, so its id comes before the Item it will tie with.
      const reopened = await anItem('Renew the domain');
      const tying = await anItem('Pay the invoice');
      const last = await anItem('Book the venue');
      await fileInOrder(panelId, [tying, reopened, last]);
      await finish(reopened, 24 * 7);
      const arriving = await anItem('Reply to Bart');
      // Written without it, so it keeps place 1, which `tying` now holds too.
      expect((await move(arriving, panelId, [arriving, tying, last])).status).toBe(200);

      expect(
        (await post('set_done', { workspaceId: WORKSPACE_ID, itemId: reopened, done: false }, hoursAgo(0))).status,
      ).toBe(200);

      const onOneDevice = onThePanel(await opened(), panelId);
      const onAnother = onThePanel(await opened(), panelId);
      expect(onOneDevice).toEqual([arriving, reopened, tying, last]);
      expect(onAnother).toEqual(onOneDevice);
    });
  });
});
