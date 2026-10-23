import { afterEach, beforeEach, describe, expect, inject, it, vi } from 'vitest';
import { env, applyD1Migrations, runDurableObjectAlarm } from 'cloudflare:test';
import { ACCOUNT_WIDE, type CommandPayload, type Item, type RecurringItem } from '@cockpit/shared';
import { ACCOUNT_NAME, DASHBOARD_ID, WORKSPACE_ID, alsoWorkspaces, asUser, inTheStore, seedRegister, startFromEmpty, storeNamed } from '../seed.js';

/**
 * Integration level, through the real Worker: the Workspace's recurring items as
 * the Recurring items modal reads them, and what making, changing and deleting
 * one comes to in the account's store ("Make, change and delete recurring items
 * from the Recurring items modal", issue 1449). The rules for *saying* a rule
 * are L1 (`series.test.ts`, shared); what the next copy is made from is
 * `recurring-items-converted.test.ts` and `repeating-items.test.ts`.
 */

const OTHER_WORKSPACE = 'ws-atlas';
/** A Thursday, years ahead so the account's alarm set for a recurring item never fires while a case runs. */
const ISSUED = '2082-10-22T10:00:00.000Z';
const LATER = '2082-10-22T10:05:00.000Z';
const WEEKLY = { frequency: 'weekly', nextOn: '2082-11-02', dueAfterDays: 5, timeZone: 'Europe/Brussels' } as const;

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

type Made = CommandPayload<'create_recurring_item'>;

const content = (extra: Partial<Made> = {}): Omit<Made, 'commandId' | 'issuedAt' | 'workspaceId' | 'seriesId'> => ({
  title: 'Weekly review',
  description: 'Look back, then ahead.',
  priority: 'high',
  panelIds: [],
  repeat: WEEKLY,
  ...extra,
});

function create(extra: Partial<Made> = {}, seriesId = nextId(), workspaceId = WORKSPACE_ID) {
  return post('create_recurring_item', { commandId: nextId(), issuedAt: ISSUED, workspaceId, seriesId, ...content(), ...extra });
}

function write(seriesId: string, extra: Partial<Made> = {}, issuedAt = LATER, workspaceId = WORKSPACE_ID) {
  return post('write_recurring_item', { commandId: nextId(), issuedAt, workspaceId, seriesId, ...content(), ...extra });
}

function remove(seriesId: string, issuedAt = LATER, workspaceId = WORKSPACE_ID) {
  return post('delete_recurring_item', { commandId: nextId(), issuedAt, workspaceId, seriesId });
}

async function aMade(extra: Partial<Made> = {}, workspaceId = WORKSPACE_ID): Promise<string> {
  const seriesId = nextId();
  const response = await create(extra, seriesId, workspaceId);
  expect(response.status, await response.clone().text()).toBe(200);
  return seriesId;
}

async function recurringItemsOf(workspaceId = WORKSPACE_ID): Promise<RecurringItem[]> {
  const response = await asUser(`http://cockpit.test/v1/workspaces/${workspaceId}/recurring-items`);
  expect(response.status).toBe(200);
  return ((await response.json()) as { recurringItems: RecurringItem[] }).recurringItems;
}

async function aPanel(name: string, workspaceId = WORKSPACE_ID, dashboardId = DASHBOARD_ID): Promise<string> {
  const panelId = nextId();
  const response = await post('add_panel', {
    commandId: nextId(),
    issuedAt: '2082-10-20T10:00:00.000Z',
    workspaceId,
    dashboardId,
    panelId,
    name,
    kind: 'items',
  });
  expect(response.status, await response.clone().text()).toBe(200);
  return panelId;
}

/** The Items of the Workspace that name the recurring item, as the store holds them. */
async function copiesOf(seriesId: string): Promise<string[]> {
  const snapshot = (await (await asUser(`http://cockpit.test/v1/workspaces/${WORKSPACE_ID}/snapshot`)).json()) as { items: Item[] };
  return snapshot.items.filter((item) => item.seriesId === seriesId).map((item) => item.id);
}

/** The account's alarm running at `at`, as it would on that day. */
async function alarmRunsAt(at: string): Promise<void> {
  vi.useFakeTimers({ toFake: ['Date'], now: Date.parse(at) });
  try {
    await runDurableObjectAlarm(storeNamed(ACCOUNT_NAME));
  } finally {
    vi.useRealTimers();
  }
}

const seriesRows = () => inTheStore((sql) => sql.exec('SELECT * FROM series').toArray());

beforeEach(async () => {
  await applyD1Migrations(env.DB, inject('migrations'));
  await startFromEmpty();
  await seedRegister();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Workspace management', () => {
  describe('the recurring items of a Workspace are read whole, soonest first', () => {
    it('lists a Workspace\'s own with their content, rule and Panels, and not another\'s', async () => {
      await alsoWorkspaces();
      const panelId = await aPanel('Reviews');
      const later = await aMade({ title: 'Quarterly VAT', repeat: { ...WEEKLY, frequency: 'quarterly', nextOn: '2082-12-01' }, panelIds: [panelId] });
      const sooner = await aMade({ title: 'Weekly review', description: '' });
      await aMade({ title: 'Atlas invoices' }, OTHER_WORKSPACE);

      expect(await recurringItemsOf()).toEqual([
        {
          id: sooner,
          workspaceId: WORKSPACE_ID,
          title: 'Weekly review',
          description: '',
          priority: 'high',
          panelIds: [],
          frequency: 'weekly',
          nextOn: '2082-11-02',
          dueAfterDays: 5,
        },
        expect.objectContaining({ id: later, title: 'Quarterly VAT', frequency: 'quarterly', panelIds: [panelId] }),
      ]);
      expect((await recurringItemsOf(OTHER_WORKSPACE)).map((one) => one.title)).toEqual(['Atlas invoices']);
    });

    it('leaves out one that was deleted', async () => {
      const kept = await aMade({ title: 'Kept' });
      const gone = await aMade({ title: 'Gone' });
      await remove(gone);

      expect((await recurringItemsOf()).map((one) => one.id)).toEqual([kept]);
    });

    it('refuses a Workspace that is not there', async () => {
      const response = await asUser('http://cockpit.test/v1/workspaces/ws-nowhere/recurring-items');

      expect(response.status).toBe(404);
    });

    it('leaves out a Panel deleted since, so it is not offered again', async () => {
      const kept = await aPanel('Kept');
      const gone = await aPanel('Gone');
      await aMade({ panelIds: [kept, gone] });
      await post('delete_panel', { commandId: nextId(), issuedAt: LATER, workspaceId: WORKSPACE_ID, panelId: gone });

      expect((await recurringItemsOf())[0]?.panelIds).toEqual([kept]);
    });

    it('answers every one however many there are', async () => {
      // Past a screenful, and past the bound values one statement may carry.
      for (let one = 0; one < 130; one += 1) await aMade({ title: `Recurring ${String(one).padStart(3, '0')}` });

      const listed = await recurringItemsOf();

      expect(listed).toHaveLength(130);
      expect(new Set(listed.map((one) => one.id)).size).toBe(130);
    });
  });

  describe('a recurring item is made and written whole, or refused with its reason', () => {
    it('is read back as it was made', async () => {
      const panelId = await aPanel('Reviews');
      const seriesId = await aMade({ panelIds: [panelId] });

      expect(await recurringItemsOf()).toEqual([
        expect.objectContaining({ id: seriesId, title: 'Weekly review', frequency: 'weekly', nextOn: '2082-11-02', dueAfterDays: 5, panelIds: [panelId] }),
      ]);
      expect(await seriesRows()).toHaveLength(1);
    });

    it('is read back changed once its title, Panels and rule are written', async () => {
      const first = await aPanel('First');
      const second = await aPanel('Second');
      const seriesId = await aMade({ panelIds: [first] });

      const response = await write(seriesId, {
        title: 'Monthly review',
        description: '',
        priority: null,
        panelIds: [second, first],
        repeat: { ...WEEKLY, frequency: 'monthly', nextOn: '2082-11-15', dueAfterDays: null },
      });

      expect(response.status).toBe(200);
      expect(await recurringItemsOf()).toEqual([
        expect.objectContaining({
          id: seriesId,
          title: 'Monthly review',
          description: '',
          priority: null,
          panelIds: [second, first],
          frequency: 'monthly',
          nextOn: '2082-11-15',
          dueAfterDays: null,
        }),
      ]);
      expect(await seriesRows()).toHaveLength(1);
    });

    it('keeps the day it came round on when the rest is written and the day is sent back unchanged', async () => {
      const seriesId = await aMade();

      // After its day has passed, the form sends the stored day back with every other choice.
      const response = await write(seriesId, { title: 'Renamed' }, '2082-11-03T09:00:00.000Z');

      expect(response.status).toBe(200);
      expect((await recurringItemsOf())[0]).toMatchObject({ title: 'Renamed', nextOn: '2082-11-02' });
    });

    it.each([
      { situation: 'a Next on before today on the device calendar', repeat: { ...WEEKLY, nextOn: '2082-10-21' }, panelIds: [], reason: 'Next on cannot be before today.' },
      { situation: 'a Panel that is not there', repeat: WEEKLY, panelIds: [nextId()], reason: 'A Panel it files on is no longer in this Workspace.' },
      { situation: 'a time zone this runtime does not know', repeat: { ...WEEKLY, timeZone: 'Mars/Olympus_Mons' }, panelIds: [], reason: undefined },
    ])('refuses $situation, whether made or written, and leaves what is there as it was', async ({ repeat, panelIds, reason }) => {
      const made = await aMade();

      const refusedMake = await create({ repeat, panelIds });
      const refusedWrite = await write(made, { title: 'Not saved', repeat, panelIds });

      for (const response of [refusedMake, refusedWrite]) {
        expect(response.status).toBe(400);
        if (reason) expect(((await response.json()) as { error: string }).error).toBe(reason);
      }
      expect(await recurringItemsOf()).toEqual([expect.objectContaining({ id: made, title: 'Weekly review', nextOn: '2082-11-02' })]);
      expect(await seriesRows()).toHaveLength(1);
    });

    it('refuses a Panel of another Workspace, and a Panel deleted, and writes nothing', async () => {
      await alsoWorkspaces();
      const elsewhere = await aPanel('Elsewhere', OTHER_WORKSPACE, `${OTHER_WORKSPACE}-dashboard-1`);
      const deleted = await aPanel('Deleted');
      await post('delete_panel', { commandId: nextId(), issuedAt: LATER, workspaceId: WORKSPACE_ID, panelId: deleted });

      for (const panelId of [elsewhere, deleted]) {
        const response = await create({ panelIds: [panelId] });
        expect(response.status).toBe(400);
        expect(((await response.json()) as { error: string }).error).toBe('A Panel it files on is no longer in this Workspace.');
      }
      expect(await seriesRows()).toEqual([]);
    });

    it('refuses a write to one that is not there, was deleted, or is another Workspace\'s', async () => {
      await alsoWorkspaces();
      const deleted = await aMade();
      await remove(deleted);
      const atlas = await aMade({}, OTHER_WORKSPACE);

      for (const seriesId of [nextId(), deleted]) {
        const response = await write(seriesId);
        expect(response.status).toBe(400);
        expect(((await response.json()) as { error: string }).error).toBe('That recurring item is no longer there.');
      }
      expect((await write(atlas, {}, LATER, WORKSPACE_ID)).status).toBe(400);
      expect((await recurringItemsOf(OTHER_WORKSPACE))[0]).toMatchObject({ title: 'Weekly review' });
    });

    it('refuses one made under an id already taken, and a Workspace that is not there', async () => {
      const seriesId = await aMade();

      expect((await create({}, seriesId)).status).toBe(400);
      expect((await create({}, nextId(), 'ws-nowhere')).status).toBe(404);
      expect(await seriesRows()).toHaveLength(1);
    });

    it('is applied once however many times the same change arrives', async () => {
      const payload = { commandId: nextId(), issuedAt: ISSUED, workspaceId: WORKSPACE_ID, seriesId: nextId(), ...content() };

      const first = await post('create_recurring_item', payload);
      const again = await post('create_recurring_item', payload);

      expect(first.status).toBe(200);
      expect(await again.json()).toMatchObject({ ok: true, applied: false });
      expect(await seriesRows()).toHaveLength(1);
    });

    it('lets the later of two tabs\' writes win, whichever arrives last', async () => {
      const seriesId = await aMade();

      await write(seriesId, { title: 'From the second tab' }, '2082-10-22T10:10:00.000Z');
      const late = await write(seriesId, { title: 'From the first tab' }, '2082-10-22T10:07:00.000Z');

      expect(late.status).toBe(200);
      expect((await recurringItemsOf())[0]?.title).toBe('From the second tab');
    });
  });

  describe('deleting a recurring item stops it, and its copies keep naming it', () => {
    it('takes it out of the list, keeps the copies naming it and makes no more', async () => {
      const seriesId = await aMade({ repeat: { ...WEEKLY, nextOn: '2090-01-09', dueAfterDays: null } });
      await alarmRunsAt('2090-01-09T08:00:00.000Z');
      const copiesBefore = await copiesOf(seriesId);
      expect(copiesBefore).toHaveLength(1);

      const response = await remove(seriesId, '2090-01-10T09:00:00.000Z');
      await alarmRunsAt('2090-01-16T08:00:00.000Z');

      expect(response.status).toBe(200);
      expect(await recurringItemsOf()).toEqual([]);
      expect(await copiesOf(seriesId)).toEqual(copiesBefore);
      const snapshot = (await (await asUser(`http://cockpit.test/v1/workspaces/${WORKSPACE_ID}/snapshot`)).json()) as {
        series: { id: string; stoppedAt: string | null }[];
      };
      expect(snapshot.series).toEqual([expect.objectContaining({ id: seriesId, stoppedAt: '2090-01-10T09:00:00.000Z' })]);
    });

    it('is applied once, and a second delete changes nothing', async () => {
      const seriesId = await aMade();

      await remove(seriesId);
      const again = await remove(seriesId, '2082-10-22T10:09:00.000Z');

      expect(again.status).toBe(200);
      expect(await again.json()).toMatchObject({ applied: false });
      expect(((await seriesRows())[0] as { stopped_at: string | null }).stopped_at).toBe(LATER);
    });

    it('refuses one that is not there, and one of another Workspace', async () => {
      await alsoWorkspaces();
      const atlas = await aMade({}, OTHER_WORKSPACE);

      expect((await remove(nextId())).status).toBe(400);
      expect((await remove(atlas)).status).toBe(400);
      expect(await recurringItemsOf(OTHER_WORKSPACE)).toHaveLength(1);
    });
  });

  describe('a change to a recurring item is told to the Workspaces that draw its copy', () => {
    /**
     * The Workspaces the change answered at `at` is announced to, as a tab polling hears them. **A change
     * to the series' own Workspace is hidden behind the copy the alarm made there**, which carries a later
     * stamp (the alarm runs on the day it is due), so what this can tell is whether it went account-wide.
     */
    const heardOf = async (at: string | undefined) => {
      const heard = await storeNamed(ACCOUNT_NAME).changesSince(ACCOUNT_NAME, '');
      if (heard.status !== 'ok') throw new Error(JSON.stringify(heard));
      return heard.value.events.flatMap((event) =>
        event.type === 'snapshot_invalidated' && event.at === at ? [event.workspaceId] : [],
      );
    };

    it.each([
      { audience: 'its own Workspace alone', where: 'in its own Workspace', moved: false, heard: [] },
      { audience: 'every Workspace', where: 'in another Workspace', moved: true, heard: [ACCOUNT_WIDE] },
    ])('is told to $audience when its latest copy is drawn $where, for a write and for a delete', async ({ moved, heard }) => {
      await alsoWorkspaces();
      const seriesId = await aMade({ repeat: { ...WEEKLY, nextOn: '2090-01-09', dueAfterDays: null } });
      await alarmRunsAt('2090-01-09T08:00:00.000Z');
      expect(await copiesOf(seriesId)).toHaveLength(1);
      if (moved) await inTheStore((sql) => sql.exec('UPDATE items SET workspace_id = ? WHERE series_id = ?', OTHER_WORKSPACE, seriesId));

      const written = await write(seriesId, { repeat: { ...WEEKLY, nextOn: '2090-01-20', dueAfterDays: null } }, '2090-01-10T09:00:00.000Z');
      expect(written.status).toBe(200);
      expect(await heardOf(((await written.json()) as { at?: string }).at)).toEqual(heard);

      const deleted = await remove(seriesId, '2090-01-11T09:00:00.000Z');
      expect(deleted.status).toBe(200);
      expect(await heardOf(((await deleted.json()) as { at?: string }).at)).toEqual(heard);
    });
  });
});
