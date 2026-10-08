import { afterEach, beforeEach, describe, expect, inject, it, vi } from 'vitest';
import { applyD1Migrations, env, runDurableObjectAlarm } from 'cloudflare:test';
import type { CompleteListing, Connector, ConnectorHost, OpenStateWanted, SourceItem } from '@cockpit/connector-sdk';
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
 * Worker's real queue consumer: what a complete listing a pulled connector
 * reports leaves open and closed ("Close a pulled connector's Items its
 * complete listing no longer sees", issue 938).
 *
 * **Against a fake pulled connector** that mirrors open state, registered in
 * place of the registry's list as `pulled-open-state.test.ts` does. A first
 * check brings Items in; a later check reports the listing a case scripted.
 * Items are closed and reopened through the app's own change route, and what
 * they end as is read off the snapshot.
 */

const FAKE = 'fake-lists';
const KEY = 'somebody';
const OTHER_KEY = 'somebody-else';

const fake = {
  /** What a connection's very first check does, before it has saved any state. */
  first: null as ((host: ConnectorHost) => Promise<void>) | null,
  /** What the next check of each connection does, by the account at the source; consumed once. */
  next: new Map<string, (host: ConnectorHost, connectionId: string) => Promise<void>>(),
  /** What the connector was handed to mirror - a closed Item must never be among it. */
  handed: [] as OpenStateWanted[][],
  /** Which connection each key was connected as. */
  connections: new Map<string, string>(),
};

const fakeLists: Connector = {
  manifest: {
    id: FAKE,
    displayName: 'A pulled source',
    cardText: 'A source Cockpit pulls from.',
    source: 'notion',
    supportsPush: false,
    pulled: true,
    mirrorsOpenState: true,
    auth: { kind: 'none' },
  },
  async sync(host) {
    const state = (await host.getState()) as { key: string } | null;
    if (!state) {
      await fake.first?.(host);
      fake.first = null;
      return;
    }
    const script = fake.next.get(state.key);
    fake.next.delete(state.key);
    await script?.(host, fake.connections.get(state.key)!);
  },
  async mirrorOpenState(_host, wanted) {
    fake.handed.push(wanted);
    return [];
  },
};

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

async function waitForQueuedChecks(count: number): Promise<EnrichmentJob[]> {
  for (let waited = 0; waited < 10_000; waited += 25) {
    if (held.filter((job) => job.kind === 'check-a-pulled-connection').length >= count) return takeQueuedChecks();
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`fewer than ${count} checks were ever queued`);
}

async function connect(externalAccountKey: string): Promise<string> {
  const key = await sealingKey(env.CONNECTOR_CREDENTIAL_KEY);
  const sealed = await seal('a-credential', key!);
  const answer = await storeNamed(ACCOUNT_NAME).applyChange(ACCOUNT_NAME, 'connect_source_account', {
    commandId: crypto.randomUUID(),
    issuedAt: new Date().toISOString(),
    workspaceId: WORKSPACE_ID,
    sourceAccountId: crypto.randomUUID(),
    connectorId: FAKE,
    externalAccountKey,
    displayName: `${externalAccountKey} at the source`,
    ...sealed,
  });
  expect(answer.status).toBe('ok');
  const res = await asUser(`http://cockpit.test/v1/workspaces/${WORKSPACE_ID}/connections`);
  const rows = ((await res.json()) as { sourceAccounts: { id: string; externalAccountKey?: string; displayName: string }[] })
    .sourceAccounts;
  return rows.find((row) => row.displayName === `${externalAccountKey} at the source`)!.id;
}

/** Connects the account and runs the check connecting queues, which brings in what the script says. */
async function connectedAndChecked(
  externalAccountKey: string,
  script: (host: ConnectorHost) => Promise<void>,
): Promise<string> {
  const id = await connect(externalAccountKey);
  fake.connections.set(externalAccountKey, id);
  fake.first = async (host) => {
    await host.setState({ key: externalAccountKey });
    await script(host);
  };
  for (const check of await waitForQueuedChecks(1)) await deliver(check);
  return id;
}

/** The alarm firing and each check it queued delivered, with `script` as what the account does next. */
async function nextCheck(externalAccountKey: string, script: (host: ConnectorHost, id: string) => Promise<void>) {
  fake.next.set(externalAccountKey, script);
  await inTheStore((sql) => sql.exec(`UPDATE pulled_connections SET due_at = '2000-01-01T00:00:00.000Z'`));
  await runDurableObjectAlarm(storeNamed(ACCOUNT_NAME));
  for (const check of await waitForQueuedChecks(1)) await deliver(check);
}

function aPage(sourceId: string, choice?: string): SourceItem {
  return {
    source: 'notion',
    sourceId,
    sourceLink: null,
    sender: null,
    sourceTimestamp: null,
    title: `Page ${sourceId}`,
    capturedMessage: `What page ${sourceId} says`,
    ...(choice ? { choice } : {}),
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

async function openSourceIds(): Promise<string[]> {
  return (await itemsFrom())
    .filter((item) => item.completedAt === null)
    .map((item) => item.sourceId!)
    .sort();
}

async function change(name: 'set_done', sourceId: string, on: boolean): Promise<void> {
  const item = (await itemsFrom()).find((one) => one.sourceId === sourceId)!;
  const res = await asUser(`http://cockpit.test/v1/commands/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      commandId: crypto.randomUUID(),
      issuedAt: new Date().toISOString(),
      workspaceId: WORKSPACE_ID,
      itemId: item.id,
      done: on,
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

/** The listing a check reports, under the choice the Items came in under. */
function lists(listing: CompleteListing): (host: ConnectorHost) => Promise<void> {
  return (host) => host.reportCompleteListing(listing);
}

beforeEach(async () => {
  await applyD1Migrations(env.DB, inject('migrations'));
  await startFromEmpty();
  await seedRegister();
  await alsoWorkspaces();
  held = [];
  holdTheQueue();
  fake.next.clear();
  fake.first = null;
  fake.handed = [];
  fake.connections.clear();
  env.TEST_CONNECTORS = [fakeLists];
});

afterEach(() => {
  env.ENRICHMENT = realQueue;
  delete env.TEST_CONNECTORS;
  vi.restoreAllMocks();
});

describe('Connector management', () => {
  describe('a complete listing closes exactly the open Items it did not see, under the same choice', () => {
    it('closes the ones it missed and leaves every other kind of Item as it was', async () => {
      await connectedAndChecked(KEY, async (host) => {
        await host.emitItem(aPage('seen', 'label'));
        await host.emitItem(aPage('missed', 'label'));
        await host.emitItem(aPage('already-done', 'label'));
        await host.emitItem(aPage('other-choice', 'star'));
        await host.emitItem(aPage('untagged'));
        await host.emitItem(aPage('waiting', 'label'));
      });
      await connectedAndChecked(OTHER_KEY, async (host) => {
        await host.emitItem(aPage('of-another-connection', 'label'));
      });
      await change('set_done', 'already-done', true);
      const doneAt = (await itemsFrom()).find((item) => item.sourceId === 'already-done')!.completedAt;
      // Closed and opened again in Cockpit: the source has not heard it is open.
      await change('set_done', 'waiting', true);
      await change('set_done', 'waiting', false);

      await nextCheck(KEY, lists({ choice: 'label', sourceIds: ['seen'] }));

      expect(await openSourceIds()).toEqual(['of-another-connection', 'other-choice', 'seen', 'untagged', 'waiting']);
      expect((await itemsFrom()).find((item) => item.sourceId === 'already-done')!.completedAt).toBe(doneAt);
      // The source's own close is never sent back to it.
      expect(fake.handed.flat().map((one) => one.sourceId)).not.toContain('missed');
    });

    it('an empty listing closes every open Item brought in under that choice and no other', async () => {
      await connectedAndChecked(KEY, async (host) => {
        await host.emitItem(aPage('one', 'label'));
        await host.emitItem(aPage('two', 'label'));
        await host.emitItem(aPage('other-choice', 'star'));
        await host.emitItem(aPage('untagged'));
      });

      await nextCheck(KEY, lists({ choice: 'label', sourceIds: [] }));

      expect(await openSourceIds()).toEqual(['other-choice', 'untagged']);
    });

    it('the choice an Item came in under is kept when the source brings it in again under another', async () => {
      await connectedAndChecked(KEY, async (host) => {
        await host.emitItem(aPage('moved', 'label'));
      });
      await nextCheck(KEY, async (host) => {
        await host.emitItem(aPage('moved', 'star'));
      });

      await nextCheck(KEY, lists({ choice: 'star', sourceIds: [] }));
      expect(await openSourceIds()).toEqual(['moved']);

      await nextCheck(KEY, lists({ choice: 'label', sourceIds: [] }));
      expect(await openSourceIds()).toEqual([]);
    });

    it('an Item a person dismissed is not closed, and stays dismissed', async () => {
      await connectedAndChecked(KEY, async (host) => {
        await host.emitItem(aPage('dismissed', 'label'));
      });
      const item = (await itemsFrom()).find((one) => one.sourceId === 'dismissed')!;
      const res = await asUser('http://cockpit.test/v1/commands/set_dismissed', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          commandId: crypto.randomUUID(),
          issuedAt: new Date().toISOString(),
          workspaceId: WORKSPACE_ID,
          itemId: item.id,
          dismissed: true,
        }),
      });
      expect(res.status).toBe(200);

      await nextCheck(KEY, lists({ choice: 'label', sourceIds: [] }));

      const rows = await inTheStore((sql) =>
        [...sql.exec<{ completed_at: string | null }>('SELECT completed_at FROM items WHERE id = ?', item.id)],
      );
      expect(rows.map((row) => row.completed_at)).toEqual([null]);
    });
  });

  describe('a complete listing is refused once the run no longer holds its connection', () => {
    it.each([
      {
        situation: 'the connection was disconnected mid-run',
        takeAway: async (id: string) => disconnect(id),
      },
      {
        situation: "the run's time ran out and another took the connection",
        takeAway: async (id: string) => {
          await inTheStore((sql) =>
            sql.exec(`UPDATE pulled_connections SET run_id = 'another-run' WHERE source_account_id = ?`, id),
          );
        },
      },
    ])('$situation, so it closes nothing', async ({ takeAway }) => {
      await connectedAndChecked(KEY, async (host) => {
        await host.emitItem(aPage('missed', 'label'));
      });

      await nextCheck(KEY, async (host, id) => {
        await takeAway(id);
        await host.reportCompleteListing({ choice: 'label', sourceIds: [] });
      });

      expect(await openSourceIds()).toEqual(['missed']);
    });
  });
});
