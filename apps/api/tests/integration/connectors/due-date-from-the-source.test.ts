import { afterEach, beforeEach, describe, expect, inject, it } from 'vitest';
import { applyD1Migrations, env, runDurableObjectAlarm } from 'cloudflare:test';
import type { Connector, ConnectorHost, SourceItem } from '@cockpit/connector-sdk';
import type { EnrichmentJob } from '../../../src/jobs/enrichment.js';
import { handleQueue } from '../../../src/jobs/index.js';
import { seal, sealingKey } from '../../../src/connectors/credential-crypto.js';
import { ACCOUNT_NAME, WORKSPACE_ID, alsoWorkspaces, inTheStore, seedRegister, startFromEmpty, storeNamed } from '../seed.js';
import { batchOf, nextId, postChange } from '../http/note-cleanup.support.js';

/**
 * Integration level, through the account's real store, its real alarm and the
 * Worker's real queue consumer: the day a source gives an Item as due, which a
 * connection treats as the date it gave ("A flag's date becomes the Outlook
 * Item's due date", issue 1759). Which day Outlook's flag means is the Outlook
 * package's (its unit tests); here, that the day is written in the transaction
 * that makes the Item, ahead of the connection's days, and a reported change
 * moves the Item only while its date is still the connection's.
 *
 * **Against a fake pulled connector**, registered in place of the registry's
 * list, whose next check does what a case scripts.
 */

const PULLED = 'fake-pulled';
const OTHER_WORKSPACE = 'ws-atlas';

const fake = {
  /** What the next check does; consumed once. */
  next: null as ((host: ConnectorHost) => Promise<void>) | null,
  /** What every check does until a case says otherwise, for a case about two connections. */
  each: null as ((host: ConnectorHost) => Promise<void>) | null,
};

const connector: Connector = {
  manifest: {
    id: PULLED,
    displayName: 'A pulled source',
    cardText: 'A source.',
    supportsPush: false,
    pulled: true,
    mirrorsOpenState: true,
    auth: { kind: 'none' },
  },
  async sync(host: ConnectorHost) {
    const script = fake.next ?? fake.each;
    fake.next = null;
    await script?.(host);
  },
  async mirrorOpenState() {
    return [];
  },
};

const now = () => new Date(); // clock-ok: the store stamps the Items on the real clock, so a person's change must be no older

let held: EnrichmentJob[] = [];
let realQueue: typeof env.ENRICHMENT;

beforeEach(async () => {
  await applyD1Migrations(env.DB, inject('migrations'));
  await startFromEmpty();
  await seedRegister();
  await alsoWorkspaces();
  held = [];
  realQueue = env.ENRICHMENT;
  env.ENRICHMENT = {
    send: async (body: EnrichmentJob) => {
      held.push(body);
    },
    sendBatch: async () => {
      throw new Error('nothing here sends a batch');
    },
  } as unknown as typeof env.ENRICHMENT;
  fake.next = null;
  fake.each = null;
  env.TEST_CONNECTORS = [connector];
});

afterEach(() => {
  env.ENRICHMENT = realQueue;
  delete env.TEST_CONNECTORS;
});

async function theQueuedCheck(): Promise<EnrichmentJob> {
  for (let waited = 0; waited < 10_000; waited += 25) {
    const at = held.findIndex((job) => job.kind === 'check-a-pulled-connection');
    if (at >= 0) return held.splice(at, 1)[0]!;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('no check was ever queued');
}

/** Connects the account at the source - giving each Item `days` after it arrives, or none - and runs the check connecting queues, which brings in nothing. */
async function connect(dueInDays?: number | null, workspaceId = WORKSPACE_ID, externalAccountKey = `somebody-in-${workspaceId}`): Promise<string> {
  const key = await sealingKey(env.CONNECTOR_CREDENTIAL_KEY);
  const sealed = await seal('a-credential', key!);
  const sourceAccountId = crypto.randomUUID();
  const answer = await storeNamed(ACCOUNT_NAME).applyChange(ACCOUNT_NAME, 'connect_source_account', {
    commandId: crypto.randomUUID(),
    issuedAt: now().toISOString(),
    workspaceId,
    sourceAccountId,
    connectorId: PULLED,
    externalAccountKey,
    displayName: 'somebody at the source',
    ...sealed,
    ...(dueInDays === undefined ? {} : { dueInDays }),
  });
  expect(answer.status).toBe('ok');
  await handleQueue(batchOf(await theQueuedCheck()), env);
  return sourceAccountId;
}

/** The alarm firing and the checks it queues delivered, doing what `script` says. */
async function nextCheck(script: (host: ConnectorHost) => Promise<void>, checks = 1): Promise<void> {
  if (checks === 1) fake.next = script;
  else fake.each = script;
  await inTheStore((sql) => sql.exec(`UPDATE pulled_connections SET due_at = '2000-01-01T00:00:00.000Z'`));
  await runDurableObjectAlarm(storeNamed(ACCOUNT_NAME));
  for (let delivered = 0; delivered < checks; delivered += 1) await handleQueue(batchOf(await theQueuedCheck()), env);
  fake.each = null;
}

const aMessage = (sourceId: string, dueDay?: string): SourceItem => ({
  sourceId,
  sourceLink: null,
  sender: null,
  sourceTimestamp: null,
  title: `Message ${sourceId}`,
  capturedMessage: `What message ${sourceId} says`,
  ...(dueDay ? { dueDay } : {}),
});

const arrives = (sourceId: string, dueDay?: string) => (host: ConnectorHost) => host.emitItem(aMessage(sourceId, dueDay)).then(() => {});
const reports = (sourceId: string, dueDay: string) => (host: ConnectorHost) => host.reportDueDay({ sourceId, dueDay });
const markCameOff = (sourceId: string) => (host: ConnectorHost) =>
  host.emitSourceStateChange({ sourceId, change: 'resolved', observedAt: now().toISOString() });
/** The mark going back on, as Outlook's connector says it: the reopen, then the flag's day. */
const markWentBackOn = (sourceId: string, observedAt: string, dueDay?: string) => async (host: ConnectorHost) => {
  await host.emitSourceStateChange({ sourceId, change: 'reopened', observedAt });
  if (dueDay) await host.reportDueDay({ sourceId, dueDay });
};

interface DateRow {
  due_date: string | null;
  due_date_chosen_at: string | null;
  given_due_date: string | null;
  item_id: string;
}

async function dateOf(sourceId: string, workspaceId = WORKSPACE_ID): Promise<DateRow> {
  const [row] = await inTheStore((sql) =>
    sql
      .exec<DateRow & Record<string, string | null>>(
        `SELECT i.due_date, i.due_date_chosen_at, l.given_due_date, l.item_id
           FROM pulled_links l JOIN items i ON i.id = l.item_id WHERE l.source_id = ? AND l.workspace_id = ?`,
        sourceId,
        workspaceId,
      )
      .toArray(),
  );
  if (!row) throw new Error(`no Item was made for ${sourceId}`);
  return row;
}

/** A due date set in Cockpit, or cleared, a second after now. */
const youSet = (itemId: string, dueDate: string | null) =>
  postChange('set_due_date', { commandId: nextId(), issuedAt: new Date(now().getTime() + 1000).toISOString(), workspaceId: WORKSPACE_ID, itemId, dueDate });

/** How many times the source moved this Item's date: the due-date changes in the log naming it. */
const dateChanges = (itemId: string) =>
  inTheStore((sql) =>
    sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM commands WHERE name = 'set_due_date' AND payload LIKE ?", `%${itemId}%`).one().n,
  );

const REOPENED_ON = '2031-12-10T09:00:00.000Z';

describe('Connector management', () => {
  describe('an Item brought in with the day its source gives is due that day, ahead of the connection’s days', () => {
    it.each([
      { situation: 'giving 3 days', days: 3 as number | null },
      { situation: 'giving none', days: null },
    ])('on a connection $situation', async ({ days }) => {
      await connect(days);

      await nextCheck(arrives('m-1', '2031-06-12'));

      expect(await dateOf('m-1')).toMatchObject({ due_date: '2031-06-12', given_due_date: '2031-06-12', due_date_chosen_at: null });
    });

    it('keeps the day on a conversation the Item follows, which the message’s turn would otherwise date', async () => {
      await connect(3);

      await nextCheck(async (host) => {
        await host.emitItem({
          ...aMessage('conversation:c-1', '2031-06-12'),
          conversation: {
            id: 'c-1',
            link: 'https://source.example/c-1',
            latest: { by: 'them', from: 'Someone', at: now().toISOString(), excerpt: 'Could you look at this' },
            messageCount: 1,
            startedAt: now().toISOString(),
            withWhom: 'Someone',
          },
        });
      });

      expect(await dateOf('conversation:c-1')).toMatchObject({ due_date: '2031-06-12', given_due_date: '2031-06-12', due_date_chosen_at: null });
    });

    it('takes no day that is not a day, and gives the connection’s days instead', async () => {
      await connect(null);

      await nextCheck(arrives('m-1', '2031-02-30'));

      expect(await dateOf('m-1')).toMatchObject({ due_date: null, given_due_date: null });
    });
  });

  describe('a changed day moves the Item only while its date is still the connection’s', () => {
    it('moves it, and records the new day as the connection’s', async () => {
      await connect(3);
      await nextCheck(arrives('m-1', '2031-06-12'));

      await nextCheck(reports('m-1', '2031-06-14'));

      expect(await dateOf('m-1')).toMatchObject({ due_date: '2031-06-14', given_due_date: '2031-06-14', due_date_chosen_at: null });
    });

    it.each([
      { situation: 'set a date', dueDate: '2031-01-01' as string | null },
      { situation: 'cleared the date', dueDate: null },
    ])('leaves it where you $situation', async ({ dueDate }) => {
      await connect(3);
      await nextCheck(arrives('m-1', '2031-06-12'));
      expect((await youSet((await dateOf('m-1')).item_id, dueDate)).status).toBe(200);

      await nextCheck(reports('m-1', '2031-06-14'));

      expect((await dateOf('m-1')).due_date).toBe(dueDate);
    });

    it('leaves it where a reading replaced the date', async () => {
      await connect(3);
      await nextCheck(arrives('m-1', '2031-06-12'));
      const { item_id: itemId } = await dateOf('m-1');
      // What a reading does: replaces the date without recording it on the link, so the two part.
      await inTheStore((sql) => sql.exec(`UPDATE items SET due_date = '2031-05-09' WHERE id = ?`, itemId));

      await nextCheck(reports('m-1', '2031-06-14'));

      expect((await dateOf('m-1')).due_date).toBe('2031-05-09');
    });

    it('gives the day to an Item brought in with no date that nobody set or cleared', async () => {
      await connect(null);
      await nextCheck(arrives('m-1'));

      await nextCheck(reports('m-1', '2031-06-14'));

      expect(await dateOf('m-1')).toMatchObject({ due_date: '2031-06-14', given_due_date: '2031-06-14' });
    });

    it('leaves an Item with no date where you cleared it', async () => {
      await connect(null);
      await nextCheck(arrives('m-1'));
      expect((await youSet((await dateOf('m-1')).item_id, null)).status).toBe(200);

      await nextCheck(reports('m-1', '2031-06-14'));

      expect((await dateOf('m-1')).due_date).toBeNull();
    });

    it('ignores a day reported for a source id it never filed', async () => {
      await connect(3);
      await nextCheck(arrives('m-1', '2031-06-12'));

      await nextCheck(reports('never-filed', '2031-06-14'));

      expect(await dateOf('m-1')).toMatchObject({ due_date: '2031-06-12' });
      expect(await inTheStore((sql) => sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM pulled_links').one().n)).toBe(1);
    });

    it('applies the same day reported twice once', async () => {
      await connect(3);
      await nextCheck(arrives('m-1', '2031-06-12'));
      const { item_id: itemId } = await dateOf('m-1');

      await nextCheck(reports('m-1', '2031-06-14'));
      await nextCheck(reports('m-1', '2031-06-14'));

      expect(await dateChanges(itemId)).toBe(1);
      expect((await dateOf('m-1')).due_date).toBe('2031-06-14');
    });

    it('moves each Workspace’s own Item for one mailbox connected to two, and neither touches the other’s', async () => {
      await connect(3, WORKSPACE_ID, 'one-mailbox');
      await connect(3, OTHER_WORKSPACE, 'one-mailbox');
      await nextCheck(arrives('m-1', '2031-06-12'), 2);
      // The other Workspace's date, set by you there.
      const other = (await dateOf('m-1', OTHER_WORKSPACE)).item_id;
      expect(
        (
          await postChange('set_due_date', {
            commandId: nextId(),
            issuedAt: new Date(now().getTime() + 1000).toISOString(),
            workspaceId: OTHER_WORKSPACE,
            itemId: other,
            dueDate: '2031-01-01',
          })
        ).status,
      ).toBe(200);

      await nextCheck(reports('m-1', '2031-06-14'), 2);

      expect((await dateOf('m-1')).due_date).toBe('2031-06-14');
      expect((await dateOf('m-1', OTHER_WORKSPACE)).due_date).toBe('2031-01-01');
    });
  });

  describe('a flag put back after Done reopens the Item due on the day', () => {
    it('gives the day ahead of the connection’s days while the date is still the connection’s', async () => {
      await connect(3);
      await nextCheck(arrives('m-1'));
      await nextCheck(markCameOff('m-1'));

      await nextCheck(markWentBackOn('m-1', REOPENED_ON, '2031-12-15'));

      expect(await dateOf('m-1')).toMatchObject({ due_date: '2031-12-15', given_due_date: '2031-12-15' });
    });

    it('leaves a date you set where the flag is put back', async () => {
      await connect(3);
      await nextCheck(arrives('m-1'));
      expect((await youSet((await dateOf('m-1')).item_id, '2031-01-01')).status).toBe(200);
      await nextCheck(markCameOff('m-1'));

      await nextCheck(markWentBackOn('m-1', REOPENED_ON, '2031-12-15'));

      expect((await dateOf('m-1')).due_date).toBe('2031-01-01');
    });
  });
});
