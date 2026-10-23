import { beforeEach, describe, expect, inject, it } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { itemStatus, type CommandName, type Filing, type Item } from '@cockpit/shared';
import { DASHBOARD_ID, OTHER_USER_ID, WORKSPACE_ID, asUser, inTheStore, seedRegister, startFromEmpty } from '../seed.js';

/**
 * Integration level, through the real Worker: what *Wait for reply…* and *Wait
 * again…* come to in the account's store, and what every device then reads in
 * the Workspace ("Set an Item Waiting for reply, and wait again after chasing",
 * issue 1463). The status read off the three times is L1 (`item.test.ts`,
 * shared); a replay applied once is with the other changes
 * (`item-changes.test.ts`).
 */

const ZONE = 'Europe/Brussels';
/** Captured over a week before the wait. */
const CAPTURED = '2082-10-12T10:00:00.000Z';
/** A Thursday, the same day in Brussels as on UTC. */
const ISSUED = '2082-10-22T10:00:00.000Z';
const TODAY = '2082-10-22';

let seq = 0;
function nextId(): string {
  seq += 1;
  return `018f0000-0000-7000-8000-${String(seq).padStart(12, '0')}`;
}

function post(name: CommandName, payload: Record<string, unknown>, userId?: string) {
  return asUser(
    `http://cockpit.test/v1/commands/${name}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ commandId: nextId(), workspaceId: WORKSPACE_ID, ...payload }),
    },
    userId,
  );
}

async function anItem(extra: Record<string, unknown> = {}): Promise<string> {
  const itemId = nextId();
  const made = await post('capture_item', { issuedAt: CAPTURED, itemId, message: 'Reply from Jan about the audit trail', ...extra });
  expect(made.status).toBe(200);
  return itemId;
}

const wait = (itemId: string, days: unknown, extra: Record<string, unknown> = {}) =>
  post('wait_for_reply', { issuedAt: ISSUED, itemId, days, timeZone: ZONE, ...extra });

async function snapshot(): Promise<{ items: Item[]; filings: Filing[] }> {
  const response = await asUser(`http://cockpit.test/v1/workspaces/${WORKSPACE_ID}/snapshot`);
  return (await response.json()) as { items: Item[]; filings: Filing[] };
}

const theItem = async (itemId: string) => (await snapshot()).items.find((item) => item.id === itemId);

const storedRow = (itemId: string) =>
  inTheStore((sql) => sql.exec('SELECT waiting_since, due_date, updated_at FROM items WHERE id = ?', itemId).one());

beforeEach(async () => {
  await applyD1Migrations(env.DB, inject('migrations'));
  await startFromEmpty();
  await seedRegister();
});

describe('Triage', () => {
  describe('waiting for a reply makes an Item due a number of days from today, replacing any due date, and keeps the day it first started waiting', () => {
    it.each([
      { situation: 'an Item with no due date, waiting 3 days', due: undefined, days: 3, dueDate: '2082-10-25' },
      { situation: 'an Item due next month, its date replaced', due: '2082-11-20', days: 3, dueDate: '2082-10-25' },
      { situation: 'the shortest wait, a day', due: undefined, days: 1, dueDate: '2082-10-23' },
      { situation: 'the longest wait, a year', due: undefined, days: 365, dueDate: '2083-10-22' },
    ])('$situation', async ({ due, days, dueDate }) => {
      const itemId = await anItem(due ? { dueDate: due } : {});

      const response = await wait(itemId, days);

      expect(response.status).toBe(200);
      expect(await theItem(itemId)).toMatchObject({ waitingSince: ISSUED, dueDate, dueDateSetAt: ISSUED });
      expect(itemStatus((await theItem(itemId))!)).toBe('waiting');
    });

    it('waiting again moves the due date and keeps the day it started waiting', async () => {
      const itemId = await anItem();
      await wait(itemId, 3, { issuedAt: '2082-10-15T10:00:00.000Z' });

      const response = await wait(itemId, 7);

      expect(response.status).toBe(200);
      expect(await theItem(itemId)).toMatchObject({ waitingSince: '2082-10-15T10:00:00.000Z', dueDate: '2082-10-29' });
    });

    it('counts today on the calendar the device is in', async () => {
      const itemId = await anItem();

      // Half past eleven at night in Brussels is already the next day there.
      await wait(itemId, 3, { issuedAt: '2082-10-22T22:30:00.000Z' });

      expect((await theItem(itemId))?.dueDate).toBe('2082-10-26');
    });

    it.each([
      { situation: 'no days', days: 0 },
      { situation: 'more than a year', days: 366 },
      { situation: 'part of a day', days: 2.5 },
      { situation: 'a time zone nobody knows', days: 3, timeZone: 'Mars/Olympus_Mons' },
    ])('refuses $situation and writes nothing', async ({ days, timeZone }) => {
      const itemId = await anItem({ dueDate: '2082-11-20' });
      const before = await storedRow(itemId);

      const response = await wait(itemId, days, timeZone ? { timeZone } : {});

      expect(response.status).toBe(400);
      expect(await storedRow(itemId)).toEqual(before);
    });

    it.each([
      {
        situation: "another account's Item",
        arrange: async (itemId: string) => itemId,
        asWho: OTHER_USER_ID,
      },
      {
        situation: 'a dismissed Item',
        arrange: async (itemId: string) => {
          await post('set_dismissed', { issuedAt: '2082-10-20T10:00:00.000Z', itemId, dismissed: true });
          return itemId;
        },
        asWho: undefined,
      },
      {
        situation: 'an Item finished with',
        arrange: async (itemId: string) => {
          await post('set_done', { issuedAt: '2082-10-20T10:00:00.000Z', itemId, done: true });
          return itemId;
        },
        asWho: undefined,
      },
    ])('refuses $situation and writes nothing', async ({ arrange, asWho }) => {
      const itemId = await arrange(await anItem());
      const before = await storedRow(itemId);

      const response = await post('wait_for_reply', { issuedAt: ISSUED, itemId, days: 3, timeZone: ZONE }, asWho);

      expect(response.status).toBe(404);
      expect(await storedRow(itemId)).toEqual(before);
    });
  });

  describe('Done ends a wait for a reply without forgetting it, and To do and In progress clear it', () => {
    it('undoing Done brings the wait back, waiting since the same day', async () => {
      const itemId = await anItem();
      await wait(itemId, 3);
      await post('set_done', { issuedAt: '2082-10-22T11:00:00.000Z', itemId, done: true });
      await post('set_done', { issuedAt: '2082-10-22T11:01:00.000Z', itemId, done: false });

      const item = await theItem(itemId);
      expect(itemStatus(item!)).toBe('waiting');
      expect(item?.waitingSince).toBe(ISSUED);
    });

    it.each([
      { situation: 'To do', started: false, status: 'to_do', startedAt: null },
      { situation: 'In progress, started now', started: true, status: 'in_progress', startedAt: '2082-10-22T11:00:00.000Z' },
    ])('$situation leaves it not waiting', async ({ started, status, startedAt }) => {
      const itemId = await anItem();
      await wait(itemId, 3);

      await post('set_started', { issuedAt: '2082-10-22T11:00:00.000Z', itemId, started });

      const item = await theItem(itemId);
      expect(item).toMatchObject({ waitingSince: null, startedAt });
      expect(itemStatus(item!)).toBe(status);
    });
  });

  describe('a waiting Item stays where it is', () => {
    // That it is drawn in the Inbox and on its Panels is L1 (`filing.test.ts`, shared): both read the snapshot.
    it('stays on its Panel, where it was, never moved to the top', async () => {
      const panelId = nextId();
      await post('add_panel', { issuedAt: CAPTURED, dashboardId: DASHBOARD_ID, panelId, name: 'Waiting', kind: 'items' });
      const itemId = await anItem();
      const other = await anItem();
      await post('add_item_to_panel', { issuedAt: CAPTURED, itemId: other, panelId, order: [other] });
      await post('add_item_to_panel', { issuedAt: CAPTURED, itemId, panelId, order: [other, itemId] });

      await wait(itemId, 3);

      const onThePanel = (await snapshot()).filings
        .filter((filing) => filing.panelId === panelId)
        .sort((a, b) => a.position - b.position)
        .map((filing) => filing.itemId);
      expect(onThePanel).toEqual([other, itemId]);
    });
  });
});
