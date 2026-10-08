import { afterEach, beforeEach, describe, expect, inject, it, vi } from 'vitest';
import { applyD1Migrations, env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import type { Connector, ConnectorHost, OpenStateWanted, SourceItem } from '@cockpit/connector-sdk';
import type { EnrichmentJob } from '../../../src/jobs/enrichment.js';
import { handleQueue } from '../../../src/jobs/index.js';
import { seal, sealingKey } from '../../../src/connectors/credential-crypto.js';
import {
  ACCOUNT_NAME,
  WORKSPACE_ID,
  alsoWorkspaces,
  asUser,
  inTheStore,
  seedRegister,
  startFromEmpty,
  storeNamed,
} from '../seed.js';

/**
 * Integration level, through the account's real store, its real alarm and the
 * Worker's real queue consumer: what a person's Done, Dismiss and their undo
 * leave waiting for a pulled source, and what each check hands its connector
 * before it reads ("Mirror an Item's open state back to a pulled source through
 * the generic host", issue 893).
 *
 * **Against fake pulled connectors**, registered in place of the registry's
 * list as `pulled-checks.test.ts` does: one that declares it mirrors open state
 * and one that does not. Each case scripts what the source says and what the
 * connector confirms; what is handed is read off what the connector received.
 * Items are closed and opened through the app's own change route.
 */

const MIRRORS = 'fake-mirrors';
const SILENT = 'fake-silent';

const fake = {
  /** What each run's `sync` does, one script per run in order; the last repeats. */
  scripts: [] as ((host: ConnectorHost, run: number) => Promise<void>)[],
  runs: 0,
  /** What each run's connector was handed to mirror, in order - one entry per time it was asked. */
  handed: [] as OpenStateWanted[][],
  /** Which source ids the connector says the source now holds. */
  confirms: (wanted: OpenStateWanted[]): string[] => wanted.map((one) => one.sourceId),
  /** What the connector that does not mirror was asked, if ever. */
  silentAsked: 0,
  /** Whether the connector's push throws. */
  throws: false,
};

function connectorNamed(id: string, mirrors: boolean): Connector {
  return {
    manifest: {
      id,
      displayName: 'A pulled source',
      source: 'notion',
      supportsPush: false,
      pulled: true,
      ...(mirrors ? { mirrorsOpenState: true } : {}),
      auth: { kind: 'none' },
    },
    async sync(host) {
      fake.runs += 1;
      await fake.scripts[Math.min(fake.runs, fake.scripts.length) - 1]?.(host, fake.runs);
    },
    async mirrorOpenState(_host, wanted) {
      if (!mirrors) {
        fake.silentAsked += 1;
        return [];
      }
      fake.handed.push(wanted);
      if (fake.throws) throw new Error('the source refused');
      return fake.confirms(wanted);
    },
  };
}

function runsIn(...scripts: ((host: ConnectorHost, run: number) => Promise<void>)[]): void {
  fake.scripts = scripts;
}

let held: EnrichmentJob[] = [];
let realQueue: typeof env.ENRICHMENT;

function holdTheQueue(): void {
  realQueue = env.ENRICHMENT;
  env.ENRICHMENT = {
    send: async (body: EnrichmentJob) => {
      held.push(body);
    },
    sendBatch: async () => {
      throw new Error('nothing here sends a batch');
    },
  } as unknown as typeof env.ENRICHMENT;
}

function takeQueuedChecks(): EnrichmentJob[] {
  const checks = held.filter((job) => job.kind === 'check-a-pulled-connection');
  held = held.filter((job) => job.kind !== 'check-a-pulled-connection');
  return checks;
}

async function deliver(body: EnrichmentJob): Promise<void> {
  await handleQueue(
    {
      queue: 'cockpit-enrichment',
      messages: [
        { id: crypto.randomUUID(), timestamp: new Date(), body, attempts: 1, ack: () => {}, retry: () => {} },
      ],
      ackAll: () => {},
      retryAll: () => {},
    } as unknown as Parameters<typeof handleQueue>[0],
    env,
  );
}

async function connect(connectorId: string, externalAccountKey = 'somebody'): Promise<string> {
  const key = await sealingKey(env.CONNECTOR_CREDENTIAL_KEY);
  const sealed = await seal('a-credential', key!);
  const sourceAccountId = crypto.randomUUID();
  const answer = await storeNamed(ACCOUNT_NAME).applyChange(ACCOUNT_NAME, 'connect_source_account', {
    commandId: crypto.randomUUID(),
    issuedAt: new Date().toISOString(),
    workspaceId: WORKSPACE_ID,
    sourceAccountId,
    connectorId,
    externalAccountKey,
    displayName: `${externalAccountKey} at the source`,
    ...sealed,
  });
  expect(answer.status).toBe('ok');
  const res = await asUser(`http://cockpit.test/v1/workspaces/${WORKSPACE_ID}/connections`);
  const rows = ((await res.json()) as { sourceAccounts: { id: string; connectorId: string }[] }).sourceAccounts;
  return rows.find((row) => row.connectorId === connectorId)!.id;
}

async function waitForQueuedChecks(count: number): Promise<EnrichmentJob[]> {
  for (let waited = 0; waited < 10_000; waited += 25) {
    if (held.filter((job) => job.kind === 'check-a-pulled-connection').length >= count) return takeQueuedChecks();
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`fewer than ${count} checks were ever queued`);
}

/** The Items the source brought in, by the id the source gives them - a dismissed one is no longer listed. */
const known = new Map<string, string>();

/** Connects the mirroring source and runs the check connecting queues. */
async function connectedAndChecked(connectorId = MIRRORS, key = 'somebody'): Promise<string> {
  const id = await connect(connectorId, key);
  for (const check of await waitForQueuedChecks(1)) await deliver(check);
  for (const item of await itemsFrom()) known.set(item.sourceId!, item.id);
  return id;
}

/**
 * The check a change made due now: it is queued by the alarm itself, with no
 * time passing, and delivered through the consumer.
 */
async function checkMadeDueRuns(): Promise<void> {
  for (const check of await waitForQueuedChecks(1)) await deliver(check);
}

/** The alarm firing, and each check it queued delivered. */
async function nextChecksRun(): Promise<void> {
  await runDurableObjectAlarm(storeNamed(ACCOUNT_NAME));
  for (const check of takeQueuedChecks()) await deliver(check);
}

function nextAlarm(): Promise<number | null> {
  return runInDurableObject(storeNamed(ACCOUNT_NAME), (_instance, state) => state.storage.getAlarm());
}

function aPage(sourceId: string): SourceItem {
  return {
    source: 'notion',
    sourceId,
    sourceLink: null,
    sender: null,
    sourceTimestamp: null,
    title: `Page ${sourceId}`,
    capturedMessage: `What page ${sourceId} says`,
  };
}

interface InboxItem {
  id: string;
  sourceId: string | null;
  completedAt: string | null;
}

async function itemsFrom(): Promise<InboxItem[]> {
  const res = await asUser(`http://cockpit.test/v1/workspaces/${WORKSPACE_ID}/snapshot`);
  return ((await res.json()) as { items: (InboxItem & { source: string })[] }).items.filter(
    (item) => item.source === 'notion',
  );
}

async function itemFor(sourceId: string): Promise<InboxItem> {
  return (await itemsFrom()).find((item) => item.sourceId === sourceId)!;
}

/** A person's change to an Item, as the app sends it. */
async function change(
  name: 'set_done' | 'set_dismissed',
  sourceId: string,
  on: boolean,
): Promise<void> {
  const res = await asUser(`http://cockpit.test/v1/commands/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      commandId: crypto.randomUUID(),
      issuedAt: new Date().toISOString(),
      workspaceId: WORKSPACE_ID,
      itemId: known.get(sourceId),
      ...(name === 'set_done' ? { done: on } : { dismissed: on }),
    }),
  });
  expect(res.status).toBe(200);
}

async function disconnect(sourceAccountId: string): Promise<void> {
  const res = await asUser('http://cockpit.test/v1/commands/disconnect_source_account', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      commandId: crypto.randomUUID(),
      issuedAt: new Date().toISOString(),
      workspaceId: WORKSPACE_ID,
      sourceAccountId,
    }),
  });
  expect(res.status).toBe(200);
}

/** The pages the source holds, brought in by the first check. */
function bringsIn(...sourceIds: string[]): (host: ConnectorHost) => Promise<void> {
  return async (host) => {
    for (const sourceId of sourceIds) await host.emitItem(aPage(sourceId));
  };
}

beforeEach(async () => {
  await applyD1Migrations(env.DB, inject('migrations'));
  await startFromEmpty();
  await seedRegister();
  await alsoWorkspaces();
  held = [];
  holdTheQueue();
  fake.runs = 0;
  fake.handed = [];
  fake.silentAsked = 0;
  fake.throws = false;
  known.clear();
  fake.confirms = (wanted) => wanted.map((one) => one.sourceId);
  runsIn(async () => {});
  env.TEST_CONNECTORS = [connectorNamed(MIRRORS, true), connectorNamed(SILENT, false)];
});

afterEach(() => {
  env.ENRICHMENT = realQueue;
  delete env.TEST_CONNECTORS;
  vi.restoreAllMocks();
});

describe('Connector management', () => {
  describe('closing or reopening an Item from a source that mirrors open state tells the source on the next check, which is brought forward', () => {
    it.each([
      { situation: 'marking it done', act: () => change('set_done', 'page-1', true), handed: [{ sourceId: 'page-1', open: false }] },
      { situation: 'dismissing it', act: () => change('set_dismissed', 'page-1', true), handed: [{ sourceId: 'page-1', open: false }] },
      {
        situation: 'reopening it',
        act: async () => {
          await change('set_done', 'page-1', true);
          await change('set_done', 'page-1', false);
        },
        handed: [{ sourceId: 'page-1', open: true }],
      },
      {
        situation: 'undoing the dismissal',
        act: async () => {
          await change('set_dismissed', 'page-1', true);
          await change('set_dismissed', 'page-1', false);
        },
        handed: [{ sourceId: 'page-1', open: true }],
      },
    ])('$situation is handed over at a check made due now', async ({ act, handed }) => {
      runsIn(bringsIn('page-1'));
      await connectedAndChecked();
      // The first check ended with the next one five minutes on.
      expect((await nextAlarm())! - Date.now()).toBeGreaterThan(4 * 60_000);

      await act();

      await checkMadeDueRuns();
      expect(fake.handed).toEqual([handed]);
    });

    it('marking it done and then reopening it before the check hands over only that it is open', async () => {
      runsIn(bringsIn('page-1'));
      await connectedAndChecked();
      await change('set_done', 'page-1', true);
      await change('set_done', 'page-1', false);

      await checkMadeDueRuns();

      expect(fake.handed).toEqual([[{ sourceId: 'page-1', open: true }]]);
    });

    it('an Item from a source that does not mirror asks nothing of it, and brings no check forward', async () => {
      runsIn(bringsIn('page-1'));
      await connectedAndChecked(SILENT);
      const waiting = await inTheStore((sql) =>
        [...sql.exec<{ open_wanted: number | null }>('SELECT open_wanted FROM pulled_links')].map((row) => row.open_wanted),
      );

      await change('set_done', 'page-1', true);

      expect(waiting).toEqual([null]);
      expect(
        await inTheStore((sql) =>
          [...sql.exec<{ open_wanted: number | null }>('SELECT open_wanted FROM pulled_links')].map((row) => row.open_wanted),
        ),
      ).toEqual([null]);
      // Time enough for an alarm made due now to have queued its check.
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(held.filter((job) => job.kind === 'check-a-pulled-connection')).toEqual([]);
      expect((await nextAlarm())! - Date.now()).toBeGreaterThan(4 * 60_000);
      await nextChecksRun();
      expect(fake.silentAsked).toBe(0);
    });
  });

  describe('every check hands a source that mirrors open state what it has not yet confirmed, before it reads, until it does', () => {
    it('hands it before the read, and not again once the connector confirms it', async () => {
      const order: string[] = [];
      runsIn(
        async (host) => {
          order.push('read');
          await bringsIn('page-1')(host);
        },
        async () => {
          order.push('read');
        },
      );
      const spied = env.TEST_CONNECTORS![0]!;
      const asked = spied.mirrorOpenState!.bind(spied);
      spied.mirrorOpenState = async (host, wanted) => {
        order.push('mirror');
        return asked(host, wanted);
      };
      await connectedAndChecked();
      await change('set_done', 'page-1', true);

      await checkMadeDueRuns();
      await nextChecksRun();

      expect(order).toEqual(['read', 'mirror', 'read', 'read']);
      expect(fake.handed).toHaveLength(1);
    });

    it('hands it again at the next check where the connector did not confirm it', async () => {
      fake.confirms = () => [];
      runsIn(bringsIn('page-1'));
      await connectedAndChecked();
      await change('set_done', 'page-1', true);

      await checkMadeDueRuns();
      await nextChecksRun();

      expect(fake.handed).toEqual([[{ sourceId: 'page-1', open: false }], [{ sourceId: 'page-1', open: false }]]);
    });

    it('still reads the source when pushing a change fails, and hands the change again at the next check', async () => {
      fake.throws = true;
      runsIn(bringsIn('page-1'));
      await connectedAndChecked();
      await change('set_done', 'page-1', true);

      await checkMadeDueRuns();
      await nextChecksRun();

      expect(fake.runs).toBe(3);
      expect(fake.handed).toHaveLength(2);
    });

    it('hands over every one of more than a hundred waiting', async () => {
      const pages = Array.from({ length: 101 }, (_, index) => `page-${index}`);
      runsIn(bringsIn(...pages));
      await connectedAndChecked();
      for (const page of pages) await change('set_done', page, true);

      await checkMadeDueRuns();

      expect(fake.handed).toHaveLength(1);
      expect(fake.handed[0]!.map((one) => one.sourceId).sort()).toEqual([...pages].sort());
    });

    it('confirms only what the connector says the source holds', async () => {
      fake.confirms = () => ['page-1'];
      runsIn(bringsIn('page-1', 'page-2'));
      await connectedAndChecked();
      await change('set_done', 'page-1', true);
      await change('set_done', 'page-2', true);

      await checkMadeDueRuns();
      await nextChecksRun();

      expect(fake.handed[1]).toEqual([{ sourceId: 'page-2', open: false }]);
    });
  });

  describe('a change still waiting for the source wins over a change the source reports that disagrees', () => {
    it('an Item reopened in Cockpit stays open when the source says it is resolved at the same check', async () => {
      fake.confirms = () => [];
      runsIn(bringsIn('page-1'), async (host) => {
        await host.emitSourceStateChange({ sourceId: 'page-1', change: 'resolved', observedAt: new Date().toISOString() });
      });
      await connectedAndChecked();
      await change('set_done', 'page-1', true);
      await change('set_done', 'page-1', false);

      await checkMadeDueRuns();

      expect((await itemFor('page-1')).completedAt).toBeNull();
    });
  });

  describe('a change the source reports is never sent back to it', () => {
    it('an Item the source resolved asks nothing of the source at the next check', async () => {
      runsIn(bringsIn('page-1'), async (host) => {
        await host.emitSourceStateChange({ sourceId: 'page-1', change: 'resolved', observedAt: new Date().toISOString() });
      });
      await connectedAndChecked();
      await nextChecksRun();
      expect((await itemFor('page-1')).completedAt).not.toBeNull();

      await nextChecksRun();

      expect(fake.handed).toEqual([]);
    });
  });

  describe('disconnecting a source drops what was waiting for it', () => {
    it('connecting the same account again hands over nothing that was waiting before', async () => {
      runsIn(bringsIn('page-1'));
      const id = await connectedAndChecked();
      await change('set_done', 'page-1', true);
      await disconnect(id);

      await connectedAndChecked();
      await nextChecksRun();

      expect(fake.handed).toEqual([]);
    });
  });
});
