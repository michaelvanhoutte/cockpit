import { beforeEach, describe, expect, inject, it } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import type { CommandPayload, Item, Series } from '@cockpit/shared';
import { WORKSPACE_ID, alsoWorkspaces, asUser, inTheStore, seedRegister, startFromEmpty } from '../seed.js';

/**
 * Integration level, through the real Worker: what a repeat set on an Item
 * comes to in the account's store, and what every device then reads in the
 * Workspace's snapshot ("Set an Item to repeat from its form, and see the rule
 * on its row", issue 1406). The rules for *saying* a repeat are L1
 * (`series.test.ts`, shared).
 */

const OTHER_WORKSPACE = 'ws-atlas';
/** A Thursday, on the Brussels calendar as on UTC. */
const ISSUED = '2026-10-22T10:00:00.000Z';
const LATER = '2026-10-22T10:05:00.000Z';
const WEEKLY = { frequency: 'weekly', nextOn: '2026-11-02', dueAfterDays: 5, timeZone: 'Europe/Brussels' } as const;

let seq = 0;
function nextId(): string {
  seq += 1;
  return `018f0000-0000-7000-8000-${String(seq).padStart(12, '0')}`;
}

function post(name: string, payload: unknown) {
  return asUser(`http://cockpit.test/v1/commands/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

async function anItem(workspaceId = WORKSPACE_ID, extra: Partial<CommandPayload<'capture_item'>> = {}): Promise<string> {
  const itemId = nextId();
  const made = await post('capture_item', {
    commandId: nextId(),
    issuedAt: '2026-10-20T10:00:00.000Z',
    workspaceId,
    itemId,
    message: 'Weekly review',
    ...extra,
  });
  expect(made.status).toBe(200);
  return itemId;
}

type Repeat = CommandPayload<'set_repeat'>['repeat'];

function setRepeat(
  itemId: string,
  repeat: Repeat,
  extra: Partial<CommandPayload<'set_repeat'>> = {},
  workspaceId = WORKSPACE_ID,
) {
  return post('set_repeat', {
    commandId: nextId(),
    issuedAt: ISSUED,
    workspaceId,
    itemId,
    seriesId: nextId(),
    repeat,
    ...extra,
  });
}

async function snapshotOf(workspaceId = WORKSPACE_ID): Promise<{ items: Item[]; series: Series[] }> {
  const response = await asUser(`http://cockpit.test/v1/workspaces/${workspaceId}/snapshot`);
  return (await response.json()) as { items: Item[]; series: Series[] };
}

async function theItem(itemId: string, workspaceId = WORKSPACE_ID): Promise<Item> {
  return (await snapshotOf(workspaceId)).items.find((item) => item.id === itemId)!;
}

const seriesRows = () => inTheStore((sql) => sql.exec('SELECT * FROM series').toArray());

beforeEach(async () => {
  await applyD1Migrations(env.DB, inject('migrations'));
  await startFromEmpty();
  await seedRegister();
});

describe('Item editing', () => {
  describe('a repeat set on an Item is the one every device and every occurrence reads', () => {
    it('carries the series in the Workspace and names it on the Item', async () => {
      const itemId = await anItem();
      const seriesId = nextId();

      const response = await setRepeat(itemId, WEEKLY, { seriesId });
      expect(response.status).toBe(200);

      const snapshot = await snapshotOf();
      expect(snapshot.series).toEqual([
        expect.objectContaining({ id: seriesId, ...WEEKLY, stoppedAt: null }),
      ]);
      expect((await theItem(itemId)).seriesId).toBe(seriesId);
    });

    it('reads each change to the frequency, Next on and the due gap', async () => {
      const itemId = await anItem();
      await setRepeat(itemId, WEEKLY);
      await setRepeat(itemId, { ...WEEKLY, frequency: 'monthly' }, { issuedAt: '2026-10-22T10:01:00.000Z' });
      await setRepeat(itemId, { ...WEEKLY, frequency: 'monthly', nextOn: '2026-11-15' }, { issuedAt: '2026-10-22T10:02:00.000Z' });
      await setRepeat(itemId, { ...WEEKLY, frequency: 'monthly', nextOn: '2026-11-15', dueAfterDays: 9 }, { issuedAt: '2026-10-22T10:03:00.000Z' });

      expect((await snapshotOf()).series).toEqual([
        expect.objectContaining({ frequency: 'monthly', nextOn: '2026-11-15', dueAfterDays: 9 }),
      ]);
      expect(await seriesRows()).toHaveLength(1);
    });

    it('keeps one series when a second tab sets a rule before the first is read back', async () => {
      const itemId = await anItem();
      await setRepeat(itemId, WEEKLY);
      await setRepeat(itemId, { ...WEEKLY, frequency: 'daily' }, { issuedAt: LATER });

      expect(await seriesRows()).toHaveLength(1);
    });

    it('reads a cleared due gap as no due gap', async () => {
      const itemId = await anItem();
      await setRepeat(itemId, WEEKLY);
      await setRepeat(itemId, { ...WEEKLY, dueAfterDays: null }, { issuedAt: LATER });

      expect((await snapshotOf()).series[0]?.dueAfterDays).toBeNull();
    });

    it('stops the series on Never and leaves the Item naming it', async () => {
      const itemId = await anItem();
      await setRepeat(itemId, WEEKLY);
      const response = await setRepeat(itemId, null, { issuedAt: LATER });
      expect(response.status).toBe(200);

      const snapshot = await snapshotOf();
      expect(snapshot.series[0]?.stoppedAt).toBe(LATER);
      expect((await theItem(itemId)).seriesId).toBe(snapshot.series[0]?.id);
    });

    it('starts the same series again when a rule is set after Never', async () => {
      const itemId = await anItem();
      await setRepeat(itemId, WEEKLY);
      await setRepeat(itemId, null, { issuedAt: LATER });
      await setRepeat(itemId, WEEKLY, { issuedAt: '2026-10-22T10:10:00.000Z' });

      const { series } = await snapshotOf();
      expect(series).toHaveLength(1);
      expect(series[0]?.stoppedAt).toBeNull();
    });

    it('is not in another Workspace\'s snapshot', async () => {
      await alsoWorkspaces();
      const itemId = await anItem();
      await anItem(OTHER_WORKSPACE);
      await setRepeat(itemId, WEEKLY);

      expect((await snapshotOf()).series).toHaveLength(1);
      expect((await snapshotOf(OTHER_WORKSPACE)).series).toEqual([]);
    });

    it('is not in a Workspace\'s snapshot once the only Item naming it is dismissed', async () => {
      const itemId = await anItem();
      await setRepeat(itemId, WEEKLY);
      await post('set_dismissed', { commandId: nextId(), issuedAt: LATER, workspaceId: WORKSPACE_ID, itemId, dismissed: true });

      expect((await snapshotOf()).series).toEqual([]);
    });
  });

  describe('setting a repeat leaves the Item\'s own due date as it was', () => {
    it.each([
      { situation: 'due on a Friday, with Weekly set from a Monday', dueDate: '2026-10-30' },
      { situation: 'with no due date, and Weekly set', dueDate: undefined },
    ])('$situation', async ({ dueDate }) => {
      const itemId = await anItem(WORKSPACE_ID, dueDate ? { dueDate } : {});
      await setRepeat(itemId, WEEKLY);

      const item = await theItem(itemId);
      expect(item.dueDate).toBe(dueDate ?? null);
      expect(item.updatedAt).toBe('2026-10-20T10:00:00.000Z');
    });
  });

  describe('Next on is never before today', () => {
    it('refuses a Next on that is yesterday on the calendar of the zone sent, and writes nothing', async () => {
      const itemId = await anItem();
      const response = await setRepeat(itemId, { ...WEEKLY, nextOn: '2026-10-21' });

      expect(response.status).toBe(400);
      expect(((await response.json()) as { error: string }).error).toBe('Next on cannot be before today.');
      expect(await seriesRows()).toEqual([]);
      expect((await theItem(itemId)).seriesId).toBeNull();
    });

    it.each([
      { situation: 'today', nextOn: '2026-10-22', timeZone: 'Europe/Brussels', status: 200 },
      // 23:30 UTC on the 22nd is already the 23rd in Brussels.
      { situation: 'the 22nd, once it is the 23rd where the device is', nextOn: '2026-10-22', timeZone: 'Europe/Brussels', status: 400, issuedAt: '2026-10-22T23:30:00.000Z' },
      { situation: 'the 22nd, while it is still the 22nd where the device is', nextOn: '2026-10-22', timeZone: 'America/New_York', status: 200, issuedAt: '2026-10-22T23:30:00.000Z' },
    ])('answers $status for a Next on of $situation', async ({ nextOn, timeZone, status, issuedAt }) => {
      const itemId = await anItem();
      const response = await setRepeat(itemId, { ...WEEKLY, nextOn, timeZone }, issuedAt ? { issuedAt } : {});

      expect(response.status).toBe(status);
    });

    it('takes the Next on already set after its day has passed, so another choice can still be made', async () => {
      const itemId = await anItem();
      await setRepeat(itemId, WEEKLY, { issuedAt: ISSUED });

      const response = await setRepeat(itemId, { ...WEEKLY, dueAfterDays: 6 }, { issuedAt: '2026-11-03T09:00:00.000Z' });

      expect(response.status).toBe(200);
      expect((await snapshotOf()).series[0]).toMatchObject({ nextOn: WEEKLY.nextOn, dueAfterDays: 6 });
    });

    it('still refuses a Next on moved to a day that has passed', async () => {
      const itemId = await anItem();
      await setRepeat(itemId, WEEKLY, { issuedAt: ISSUED });

      const response = await setRepeat(itemId, { ...WEEKLY, nextOn: '2026-11-01' }, { issuedAt: '2026-11-03T09:00:00.000Z' });

      expect(response.status).toBe(400);
    });
  });

  describe('the time zone the rule was set in is kept with it', () => {
    it('stores the zone sent', async () => {
      const itemId = await anItem();
      await setRepeat(itemId, WEEKLY);

      expect((await snapshotOf()).series[0]?.timeZone).toBe('Europe/Brussels');
    });

    it('refuses a zone this runtime does not know, and writes nothing', async () => {
      const itemId = await anItem();
      const response = await setRepeat(itemId, { ...WEEKLY, timeZone: 'Mars/Olympus_Mons' });

      expect(response.status).toBe(400);
      expect(await seriesRows()).toEqual([]);
    });
  });

  describe('a repeat that cannot be set is refused and nothing is stored', () => {
    it.each<{ situation: string; repeat: unknown }>([
      { situation: 'a frequency outside the list', repeat: { ...WEEKLY, frequency: 'fortnightly' } },
      { situation: 'a negative due gap', repeat: { ...WEEKLY, dueAfterDays: -1 } },
      { situation: 'a due gap over 366 days', repeat: { ...WEEKLY, dueAfterDays: 367 } },
      { situation: 'a due gap that is not whole days', repeat: { ...WEEKLY, dueAfterDays: 1.5 } },
      { situation: 'a Next on that is not a calendar day', repeat: { ...WEEKLY, nextOn: 'next monday' } },
    ])('$situation', async ({ repeat }) => {
      const itemId = await anItem();
      const response = await setRepeat(itemId, repeat as Repeat);

      expect(response.status).toBe(400);
      expect(await seriesRows()).toEqual([]);
    });

    it('refuses an Item that does not exist', async () => {
      const response = await setRepeat(nextId(), WEEKLY);

      expect(response.status).toBe(404);
      expect(await seriesRows()).toEqual([]);
    });

    it('takes a due gap of 0 and of 366 days', async () => {
      const itemId = await anItem();
      expect((await setRepeat(itemId, { ...WEEKLY, dueAfterDays: 0 })).status).toBe(200);
      expect((await setRepeat(itemId, { ...WEEKLY, dueAfterDays: 366 }, { issuedAt: LATER })).status).toBe(200);
    });

    it('refuses a new series under an id another Item\'s series already has', async () => {
      const first = await anItem();
      const second = await anItem();
      const seriesId = nextId();
      await setRepeat(first, WEEKLY, { seriesId });

      const response = await setRepeat(second, WEEKLY, { seriesId });

      expect(response.status).toBe(400);
      expect((await theItem(second)).seriesId).toBeNull();
    });
  });

  describe('a change replayed or made twice at once leaves one repeat', () => {
    it('applies the same change once and answers the replay as not applied', async () => {
      const itemId = await anItem();
      const commandId = nextId();
      const seriesId = nextId();

      const first = await (await setRepeat(itemId, WEEKLY, { commandId, seriesId })).json();
      const again = await (await setRepeat(itemId, WEEKLY, { commandId, seriesId })).json();

      expect(first).toMatchObject({ ok: true, applied: true });
      expect(again).toMatchObject({ ok: true, applied: false });
      expect(await seriesRows()).toHaveLength(1);
    });

    it('lets the later of two tabs win, whichever arrives first', async () => {
      const itemId = await anItem();
      await setRepeat(itemId, { ...WEEKLY, frequency: 'daily' }, { issuedAt: LATER });
      const staler = await (await setRepeat(itemId, WEEKLY, { issuedAt: ISSUED })).json();

      expect(staler).toMatchObject({ ok: true, applied: false });
      expect((await snapshotOf()).series[0]?.frequency).toBe('daily');
    });

    it('changes nothing when Never is set on an Item that repeats nothing', async () => {
      const itemId = await anItem();
      const answer = await (await setRepeat(itemId, null)).json();

      expect(answer).toMatchObject({ ok: true });
      expect(await seriesRows()).toEqual([]);
    });
  });
});
