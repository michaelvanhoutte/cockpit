import { afterEach, beforeEach, describe, expect, inject, it, vi } from 'vitest';
import { applyD1Migrations, env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import type { Connector } from '@cockpit/connector-sdk';
import type { Attachment, CommandName, Filing, Item, Series } from '@cockpit/shared';
import type { EnrichmentJob } from '../../../src/jobs/enrichment.js';
import { handleQueue, handleScheduled } from '../../../src/jobs/index.js';
import { seal, sealingKey } from '../../../src/connectors/credential-crypto.js';
import {
  ACCOUNT_NAME,
  DASHBOARD_ID,
  WORKSPACE_ID,
  alsoWorkspaces,
  asUser,
  inTheStore,
  seedRegister,
  startFromEmpty,
  storeNamed,
} from '../seed.js';

/**
 * Integration level, through the account's real store and its real alarm: a
 * repeating Item coming back is a write the store makes to itself on a day, so
 * only the store, its alarm and the clock it reads can say what lands
 * ("Bring a repeating Item back on its day, as a fresh copy", issue 1407).
 *
 * **Arranged through the real Worker as the person, at the real time, with each
 * change dated in 2090**, and the alarm run with the clock set to the day it is
 * asked about - so no alarm set for one of these days ever fires by itself while
 * a case runs, and the sign-in the requests carry stays good. Read back through
 * the Workspace the app reads. The day arithmetic is L1 (`series.test.ts`, shared
 * and api).
 */

const ZONE = 'Europe/Brussels';
/** When the rule is set: a Monday, a week before its first day. */
const SET = '2090-01-02T09:00:00.000Z';
const FIRST = '2090-01-09';
const SECOND = '2090-01-16';
const THIRD = '2090-01-23';
const WEEKLY = { frequency: 'weekly', nextOn: FIRST, dueAfterDays: null, timeZone: ZONE } as const;

/** Nine in the morning in Brussels, which is eight UTC in January. */
const morningOf = (day: string) => `${day}T08:00:00.000Z`;

let seq = 0;
function nextId(): string {
  seq += 1;
  return `018f0000-0000-7000-8000-${String(seq).padStart(12, '0')}`;
}

/** A change made the way the app makes one, dated `issuedAt`. */
async function change(name: CommandName, payload: Record<string, unknown>, issuedAt = SET): Promise<void> {
  const res = await asUser(`http://cockpit.test/v1/commands/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ commandId: nextId(), issuedAt, workspaceId: WORKSPACE_ID, ...payload }),
  });
  expect(res.status, await res.clone().text()).toBe(200);
}

async function anItem(title: string, workspaceId = WORKSPACE_ID): Promise<string> {
  const itemId = nextId();
  await change('capture_item', { itemId, message: title, workspaceId }, '2090-01-01T09:00:00.000Z');
  return itemId;
}

async function aPanel(name: string): Promise<string> {
  const panelId = nextId();
  await change('add_panel', { dashboardId: DASHBOARD_ID, panelId, name, kind: 'items' }, '2090-01-01T09:00:00.000Z');
  return panelId;
}

/** Files an Item on a Panel, at its top. */
async function fileOn(itemId: string, panelId: string): Promise<void> {
  const held = (await workspace()).filings.filter((one) => one.panelId === panelId).map((one) => one.itemId);
  await change('add_item_to_panel', { itemId, panelId, order: [itemId, ...held] }, '2090-01-01T09:00:00.000Z');
}

const repeat = (itemId: string, rule: Record<string, unknown> | null = WEEKLY, issuedAt = SET) =>
  change('set_repeat', { itemId, seriesId: nextId(), repeat: rule }, issuedAt);
const done = (itemId: string, issuedAt = '2090-01-03T09:00:00.000Z') => change('set_done', { itemId, done: true }, issuedAt);

interface Read {
  items: Item[];
  filings: Filing[];
  series: Series[];
  attachments: Attachment[];
}

async function workspace(workspaceId = WORKSPACE_ID): Promise<Read> {
  const res = await asUser(`http://cockpit.test/v1/workspaces/${workspaceId}/snapshot`);
  expect(res.status).toBe(200);
  return (await res.json()) as Read;
}

/** The Items of the one series in the Workspace, oldest first. */
async function occurrences(workspaceId = WORKSPACE_ID): Promise<Item[]> {
  const read = await workspace(workspaceId);
  return read.items.filter((item) => item.seriesId !== null && item.seriesId === read.series[0]?.id);
}

/** What one Panel holds, top to bottom. */
async function panelHolds(panelId: string): Promise<string[]> {
  return (await workspace()).filings
    .filter((one) => one.panelId === panelId)
    .sort((a, b) => a.position - b.position)
    .map((one) => one.itemId);
}

const seriesRow = () =>
  inTheStore((sql) => sql.exec<{ next_on: string; last_on: string | null; stopped_at: string | null }>('SELECT * FROM series').one());

/** The account's alarm running at `at`, as it would on that day. */
async function alarmRunsAt(at: string): Promise<void> {
  vi.useFakeTimers({ toFake: ['Date'], now: Date.parse(at) });
  try {
    await runDurableObjectAlarm(storeNamed(ACCOUNT_NAME));
  } finally {
    vi.useRealTimers();
  }
}

const nextAlarm = () => runInDurableObject(storeNamed(ACCOUNT_NAME), (_instance, state) => state.storage.getAlarm());

/** An Item set to repeat weekly from FIRST, finished with, and its id. */
async function aFinishedWeeklyItem(title = 'Weekly review'): Promise<string> {
  const itemId = await anItem(title);
  await repeat(itemId);
  await done(itemId);
  return itemId;
}

beforeEach(async () => {
  await applyD1Migrations(env.DB, inject('migrations'));
  await startFromEmpty();
  await seedRegister();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('Item editing', () => {
  describe('on its day a repeating Item comes back as a fresh copy of the latest one, at the top of its live Panels', () => {
    it.each([
      { situation: 'on two Panels, it tops both', panels: 2, deleted: 0 },
      { situation: 'on two Panels one of which is deleted, it tops only the live one', panels: 2, deleted: 1 },
      { situation: 'on Panels none of which is live, it is in the Inbox', panels: 1, deleted: 1 },
      { situation: 'filed on none, it is in the Inbox', panels: 0, deleted: 0 },
    ])('$situation', async ({ panels: count, deleted }) => {
      const itemId = await anItem('Weekly review');
      const panels: string[] = [];
      for (let n = 0; n < count; n += 1) {
        const panelId = await aPanel(`Panel ${n + 2}`);
        await fileOn(await anItem(`Already on panel ${n + 2}`), panelId);
        await fileOn(itemId, panelId);
        panels.push(panelId);
      }
      await repeat(itemId);
      await done(itemId);
      for (const panelId of panels.slice(0, deleted)) {
        await change('delete_panel', { panelId }, '2090-01-03T10:00:00.000Z');
      }

      await alarmRunsAt(morningOf(FIRST));

      const [, fresh] = await occurrences();
      expect(fresh).toBeDefined();
      const read = await workspace();
      const onPanels = read.filings.filter((one) => one.itemId === fresh!.id).map((one) => one.panelId);
      expect(onPanels.sort()).toEqual(panels.slice(deleted).sort());
      for (const panelId of panels.slice(deleted)) expect((await panelHolds(panelId))[0]).toBe(fresh!.id);
    });

    it('carries what the latest one says now, starts To do and names the series', async () => {
      const itemId = await anItem('Weekly review');
      await repeat(itemId);
      await change('set_title', { itemId, title: 'Weekly review, retitled' }, '2090-01-04T09:00:00.000Z');
      await change('set_description', { itemId, description: 'Go through the open items' }, '2090-01-04T09:00:00.000Z');
      await change('set_priority', { itemId, priority: 'high' }, '2090-01-04T09:00:00.000Z');
      await change('set_started', { itemId, started: true }, '2090-01-04T09:00:00.000Z');
      await done(itemId, '2090-01-05T09:00:00.000Z');

      await alarmRunsAt(morningOf(FIRST));

      const [previous, fresh] = await occurrences();
      expect(fresh).toMatchObject({
        title: 'Weekly review, retitled',
        description: 'Go through the open items',
        priority: 'high',
        workspaceId: WORKSPACE_ID,
        seriesId: previous!.seriesId,
        completedAt: null,
        startedAt: null,
        deletedAt: null,
      });
      expect(fresh!.id).not.toBe(previous!.id);
    });

    it.each([
      { situation: 'due five days after it appears', dueAfterDays: 5, dueDate: '2090-01-14' },
      { situation: 'with no due gap, due on no day', dueAfterDays: null, dueDate: null },
    ])('is $situation', async ({ dueAfterDays, dueDate }) => {
      const itemId = await anItem('Weekly review');
      await repeat(itemId, { ...WEEKLY, dueAfterDays });
      await done(itemId);

      await alarmRunsAt(morningOf(FIRST));

      expect((await occurrences())[1]?.dueDate).toBe(dueDate);
    });
  });

  describe('a repeating Item is never open twice, and never comes back on a day already passed', () => {
    it.each([
      { situation: 'still To do on the day, nothing is added and Next on moves on', finish: null, added: false },
      { situation: 'In progress on the day, nothing is added and Next on moves on', finish: 'set_started', added: false },
      { situation: 'Done on the day, the next one is added', finish: 'set_done', added: true },
      { situation: 'dismissed on the day, the next one is added', finish: 'set_dismissed', added: true },
    ] as const)('$situation', async ({ finish, added }) => {
      const itemId = await anItem('Weekly review');
      await repeat(itemId);
      if (finish === 'set_started') await change('set_started', { itemId, started: true }, '2090-01-03T09:00:00.000Z');
      if (finish === 'set_done') await done(itemId);
      if (finish === 'set_dismissed') await change('set_dismissed', { itemId, dismissed: true }, '2090-01-03T09:00:00.000Z');

      await alarmRunsAt(morningOf(FIRST));

      const written = await inTheStore((sql) => sql.exec('SELECT id FROM items WHERE series_id IS NOT NULL').toArray());
      expect(written).toHaveLength(added ? 2 : 1);
      expect(await seriesRow()).toMatchObject({ next_on: SECOND, last_on: FIRST });
    });

    it('comes back on the next day the series counts after it is finished late, not the day it is finished', async () => {
      const itemId = await anItem('Weekly review');
      await repeat(itemId);
      await alarmRunsAt(morningOf(FIRST));
      await done(itemId, morningOf('2090-01-12'));

      await alarmRunsAt(morningOf('2090-01-12'));
      expect(await occurrences()).toHaveLength(1);

      await alarmRunsAt(morningOf(SECOND));
      const [, fresh] = await occurrences();
      expect(fresh?.createdAt).toBe(morningOf(SECOND));
    });

    it('takes back a Never after the day came round, sent from a tab that read before it did, at the day the series moved to', async () => {
      const itemId = await aFinishedWeeklyItem();
      await alarmRunsAt(morningOf(FIRST));
      await repeat(itemId, null, morningOf('2090-01-11'));

      // The Undo carries the Next on the tab held before the day came round.
      await repeat(itemId, WEEKLY, '2090-01-11T08:01:00.000Z');

      expect(await seriesRow()).toMatchObject({ next_on: SECOND, stopped_at: null });
    });

    it('starts a rule again after Never from the first day it comes round from today, when its Next on has passed', async () => {
      const itemId = await aFinishedWeeklyItem();
      await repeat(itemId, null, '2090-01-03T10:00:00.000Z');

      await repeat(itemId, WEEKLY, morningOf('2090-01-17'));

      expect(await seriesRow()).toMatchObject({ next_on: THIRD, stopped_at: null });
    });
  });

  describe('moving one Item’s due date moves only it, and moving Next on moves the series', () => {
    it('still brings the next one on the series’ day after this one’s due date is moved', async () => {
      const itemId = await aFinishedWeeklyItem();
      await change('set_due_date', { itemId, dueDate: '2090-01-20' }, '2090-01-04T09:00:00.000Z');

      await alarmRunsAt(morningOf(FIRST));

      expect(await occurrences()).toHaveLength(2);
    });

    it('brings the next one on the new day once Next on is moved', async () => {
      const itemId = await aFinishedWeeklyItem();
      await repeat(itemId, { ...WEEKLY, nextOn: '2090-01-11' }, '2090-01-04T09:00:00.000Z');

      await alarmRunsAt(morningOf(FIRST));
      expect(await occurrences()).toHaveLength(1);
      await alarmRunsAt(morningOf('2090-01-11'));
      expect(await occurrences()).toHaveLength(2);
    });
  });

  describe('Never on any of a series’ Items stops it', () => {
    it.each([
      { situation: 'on the open one', onTheOpenOne: true },
      { situation: 'on a Done one', onTheOpenOne: false },
    ])('nothing more comes back after Never $situation', async ({ onTheOpenOne }) => {
      const first = await aFinishedWeeklyItem();
      await alarmRunsAt(morningOf(FIRST));
      const [, open] = await occurrences();
      await done(open!.id, morningOf('2090-01-10'));
      await repeat(onTheOpenOne ? open!.id : first, null, morningOf('2090-01-10'));

      await alarmRunsAt(morningOf(SECOND));

      expect(await occurrences()).toHaveLength(2);
      expect(await nextAlarm()).toBeNull();
    });
  });

  describe('a repeating Item’s files and images are its own', () => {
    async function anImage(itemId: string): Promise<string> {
      const attachmentId = nextId();
      const res = await asUser(`http://cockpit.test/v1/items/${itemId}/attachments`, {
        method: 'POST',
        headers: {
          'content-type': 'image/png',
          'x-attachment-id': attachmentId,
          'x-command-id': nextId(),
          'x-issued-at': '2090-01-02T08:00:00.000Z',
          'x-workspace-id': WORKSPACE_ID,
          'x-filename': 'photo.png',
        },
        body: new Uint8Array([137, 80, 78, 71]),
      });
      expect(res.status, await res.clone().text()).toBe(201);
      return attachmentId;
    }

    it.each([
      { situation: 'the previous one done', dismissed: false },
      { situation: 'the previous one dismissed', dismissed: true },
    ])('loads its files, and its description shows its own, with $situation', async ({ dismissed }) => {
      const itemId = await anItem('Receipts to file');
      const image = await anImage(itemId);
      await change('set_description', { itemId, description: `The scan:\n\n![photo.png](/v1/attachments/${image})` });
      await repeat(itemId);
      await done(itemId);
      if (dismissed) await change('set_dismissed', { itemId, dismissed: true }, '2090-01-04T09:00:00.000Z');

      await alarmRunsAt(morningOf(FIRST));

      const read = await workspace();
      const fresh = read.items.find((item) => item.seriesId !== null && item.id !== itemId)!;
      const own = read.attachments.filter((one) => one.itemId === fresh.id);
      expect(own).toEqual([expect.objectContaining({ filename: 'photo.png', contentType: 'image/png' })]);
      expect(own[0]!.id).not.toBe(image);
      expect(fresh.description).toBe(`The scan:\n\n![photo.png](/v1/attachments/${own[0]!.id})`);
      const loaded = await asUser(`http://cockpit.test/v1/attachments/${own[0]!.id}`);
      expect(loaded.status).toBe(200);
      expect(new Uint8Array(await loaded.arrayBuffer())).toEqual(new Uint8Array([137, 80, 78, 71]));
    });
  });

  describe('a repeating Item comes back however the account’s alarm is kept', () => {
    const FAKE = 'fake-pull';
    const fakePulled: Connector = {
      manifest: {
        id: FAKE,
        displayName: 'A pulled source',
        cardText: 'A source Cockpit pulls from.',
        supportsPush: false,
        pulled: true,
        auth: { kind: 'none' },
      },
      async sync() {
        runs += 1;
      },
    };
    let runs = 0;
    let held: EnrichmentJob[] = [];
    let realQueue: typeof env.ENRICHMENT;

    beforeEach(() => {
      runs = 0;
      held = [];
      realQueue = env.ENRICHMENT;
      env.ENRICHMENT = {
        send: async (body: EnrichmentJob) => {
          held.push(body);
        },
      } as unknown as typeof env.ENRICHMENT;
      env.TEST_CONNECTORS = [fakePulled];
    });

    afterEach(() => {
      env.ENRICHMENT = realQueue;
      delete env.TEST_CONNECTORS;
    });

    /** Connects the fake source at `at`, and runs the check connecting queues. */
    async function connectedAt(at: string): Promise<void> {
      const sealed = await seal('a-credential', (await sealingKey(env.CONNECTOR_CREDENTIAL_KEY))!);
      vi.useFakeTimers({ toFake: ['Date'], now: Date.parse(at) });
      try {
        const answer = await storeNamed(ACCOUNT_NAME).applyChange(ACCOUNT_NAME, 'connect_source_account', {
          commandId: nextId(),
          issuedAt: at,
          workspaceId: WORKSPACE_ID,
          sourceAccountId: nextId(),
          connectorId: FAKE,
          externalAccountKey: 'somebody',
          displayName: 'somebody at the source',
          ...sealed,
        });
        expect(answer.status).toBe('ok');
        await runDurableObjectAlarm(storeNamed(ACCOUNT_NAME));
        for (const body of held.splice(0)) await deliver(body);
      } finally {
        vi.useRealTimers();
      }
    }

    async function deliver(body: EnrichmentJob): Promise<void> {
      await handleQueue(
        {
          queue: 'cockpit-enrichment',
          messages: [{ id: nextId(), timestamp: new Date(), body, attempts: 1, ack: () => {}, retry: () => {} }],
          ackAll: () => {},
          retryAll: () => {},
        } as unknown as Parameters<typeof handleQueue>[0],
        env,
      );
    }

    it('is set for the series’ day where that comes before the next check, and brings back and checks both when it runs', async () => {
      await aFinishedWeeklyItem();
      // Two minutes before the day starts in Brussels: the next check is five minutes off.
      await connectedAt('2090-01-08T22:58:00.000Z');
      expect(runs).toBe(1);
      expect(await nextAlarm()).toBe(Date.parse('2090-01-08T23:00:00.000Z'));

      await alarmRunsAt(morningOf(FIRST));

      expect(await occurrences()).toHaveLength(2);
      for (const body of held.splice(0)) await deliver(body);
      expect(runs).toBe(2);
    });

    it('is set for the next check where that comes first', async () => {
      await aFinishedWeeklyItem();
      await connectedAt('2090-01-05T09:00:00.000Z');

      expect(await nextAlarm()).toBe(Date.parse('2090-01-05T09:05:00.000Z'));
    });

    it('is set for nothing once there is neither a connection nor a running series', async () => {
      const itemId = await aFinishedWeeklyItem();
      expect(await nextAlarm()).toBe(Date.parse('2090-01-08T23:00:00.000Z'));

      await repeat(itemId, null, '2090-01-04T09:00:00.000Z');

      expect(await nextAlarm()).toBeNull();
    });

    it('is armed again by the nightly run when it was lost, and brings the Item back', async () => {
      await aFinishedWeeklyItem();
      await runInDurableObject(storeNamed(ACCOUNT_NAME), (_instance, state) => state.storage.deleteAlarm());

      await handleScheduled({} as never, env);

      expect(await nextAlarm()).toBe(Date.parse('2090-01-08T23:00:00.000Z'));
      await alarmRunsAt(morningOf(FIRST));
      expect(await occurrences()).toHaveLength(2);
    });
  });

  describe('a repeating Item comes back once, whatever goes wrong on the way', () => {
    it('brings back one Item when the alarm runs twice on its day', async () => {
      await aFinishedWeeklyItem();

      await alarmRunsAt(morningOf(FIRST));
      await alarmRunsAt('2090-01-09T09:00:00.000Z');

      expect(await occurrences()).toHaveLength(2);
    });

    it('brings back no second Item when Next on is put back on the day it already came back, and moves on', async () => {
      const itemId = await aFinishedWeeklyItem();
      await alarmRunsAt(morningOf(FIRST));
      const [, open] = await occurrences();
      await done(open!.id, '2090-01-09T10:00:00.000Z');
      await repeat(itemId, WEEKLY, '2090-01-09T10:01:00.000Z');
      expect((await seriesRow()).next_on).toBe(FIRST);

      await alarmRunsAt('2090-01-09T11:00:00.000Z');

      expect(await occurrences()).toHaveLength(2);
      expect(await seriesRow()).toMatchObject({ next_on: SECOND });
    });

    it('brings back one Item after the store has slept for weeks, and moves on from today', async () => {
      await aFinishedWeeklyItem();

      await alarmRunsAt(morningOf('2090-01-25'));

      const [, fresh] = await occurrences();
      expect(await occurrences()).toHaveLength(2);
      expect(fresh?.createdAt).toBe(morningOf('2090-01-25'));
      expect(await seriesRow()).toMatchObject({ next_on: '2090-01-30' });
    });

    it('writes no Item, no filing and no file when one of its writes fails, leaves Next on as it was, and brings it back on the next try', async () => {
      const itemId = await anItem('Receipts to file');
      const panelId = await aPanel('Receipts');
      await fileOn(itemId, panelId);
      await inTheStore((sql) =>
        sql.exec(
          `INSERT INTO attachments (id, tenant_id, item_id, r2_key, filename, size, content_type, created_at)
           VALUES (?, ?, ?, ?, 'photo.png', 4, 'image/png', ?)`,
          nextId(),
          ACCOUNT_NAME,
          itemId,
          `${ACCOUNT_NAME}/${itemId}/scan`,
          '2090-01-02T08:00:00.000Z',
        ),
      );
      await repeat(itemId);
      await done(itemId);
      await inTheStore((sql) =>
        sql.exec(`CREATE TRIGGER refuse_files BEFORE INSERT ON attachments BEGIN SELECT RAISE(ABORT, 'refused'); END`),
      );
      vi.spyOn(console, 'error').mockImplementation(() => {});

      await alarmRunsAt(morningOf(FIRST));

      expect(await inTheStore((sql) => sql.exec('SELECT id FROM items WHERE series_id IS NOT NULL').toArray())).toHaveLength(1);
      expect(await panelHolds(panelId)).toEqual([itemId]);
      expect(await inTheStore((sql) => sql.exec('SELECT id FROM attachments').toArray())).toHaveLength(1);
      expect(await seriesRow()).toMatchObject({ next_on: FIRST, last_on: null });
      expect(await nextAlarm()).toBe(Date.parse(morningOf(FIRST)) + 60 * 60_000);

      await inTheStore((sql) => sql.exec('DROP TRIGGER refuse_files'));
      await alarmRunsAt('2090-01-09T09:00:00.000Z');

      const [, fresh] = await occurrences();
      expect(await panelHolds(panelId)).toEqual([fresh!.id, itemId]);
    });

    it('brings back no second Item when the alarm is lost after one came back, and is armed for the next day', async () => {
      await aFinishedWeeklyItem();
      await alarmRunsAt(morningOf(FIRST));
      await runInDurableObject(storeNamed(ACCOUNT_NAME), (_instance, state) => state.storage.deleteAlarm());

      await handleScheduled({} as never, env);
      await alarmRunsAt('2090-01-09T09:00:00.000Z');

      expect(await occurrences()).toHaveLength(2);
      expect(await nextAlarm()).toBe(Date.parse('2090-01-15T23:00:00.000Z'));
    });

    it('stops the series and says so, rather than bring one back, once its Workspace is deleted', async () => {
      await alsoWorkspaces();
      const itemId = await anItem('Weekly review', 'ws-atlas');
      await change('set_repeat', { itemId, seriesId: nextId(), repeat: WEEKLY, workspaceId: 'ws-atlas' });
      await change('set_done', { itemId, done: true, workspaceId: 'ws-atlas' }, '2090-01-03T09:00:00.000Z');
      await change('delete_workspace', { workspaceId: 'ws-atlas' }, '2090-01-04T09:00:00.000Z');
      const warned = vi.spyOn(console, 'warn').mockImplementation(() => {});

      await alarmRunsAt(morningOf(FIRST));

      expect(await inTheStore((sql) => sql.exec('SELECT id FROM items WHERE series_id IS NOT NULL').toArray())).toHaveLength(1);
      expect((await seriesRow()).stopped_at).toBe(morningOf(FIRST));
      expect(warned.mock.calls.map(([line]) => String(line)).join('\n')).toContain('its Workspace is gone');
      expect(await nextAlarm()).toBeNull();
    });
  });
});
