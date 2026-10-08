import { afterEach, beforeEach, describe, expect, inject, it, vi } from 'vitest';
import { applyD1Migrations, env } from 'cloudflare:test';
import type { Connector, ConnectorHost, SourceItem } from '@cockpit/connector-sdk';
import type { EnrichmentJob } from '../../../src/jobs/enrichment.js';
import { handleQueue } from '../../../src/jobs/index.js';
import { seal, sealingKey } from '../../../src/connectors/credential-crypto.js';
import {
  ACCOUNT_NAME,
  TASK_TYPE_ID,
  WORKSPACE_ID,
  alsoWorkspaces,
  asUser,
  seedRegister,
  startFromEmpty,
  storeNamed,
} from '../seed.js';

/**
 * Integration level, through the account's real store and the Worker's real
 * queue consumer: what a pulled connector's Items arrive as, by what its
 * manifest declares ("Bring a pulled connector's Items in as titled Tasks
 * where it says so", issue 939). Against a fake pulled connector whose
 * manifest each case sets, registered in place of the registry's list.
 */

const FAKE = 'fake-arrivals';

const fake = {
  arrivesAs: undefined as 'note' | 'task' | undefined,
  emit: [] as SourceItem[],
};

function fakeConnector(): Connector {
  return {
    manifest: {
      id: FAKE,
      displayName: 'A pulled source',
      cardText: 'A source Cockpit pulls from.',
      source: 'notion',
      supportsPush: false,
      pulled: true,
      ...(fake.arrivesAs ? { arrivesAs: fake.arrivesAs } : {}),
      auth: { kind: 'none' },
    },
    async sync(host: ConnectorHost) {
      for (const item of fake.emit) await host.emitItem(item);
    },
  };
}

let held: EnrichmentJob[] = [];
let realQueue: typeof env.ENRICHMENT;

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

async function waitForQueuedCheck(): Promise<EnrichmentJob> {
  for (let waited = 0; waited < 10_000; waited += 25) {
    const at = held.findIndex((job) => job.kind === 'check-a-pulled-connection');
    if (at >= 0) return held.splice(at, 1)[0]!;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('no check was ever queued');
}

/** Connects the fake and runs the check connecting queues, which emits `fake.emit`. */
async function connectedAndChecked(): Promise<void> {
  const key = await sealingKey(env.CONNECTOR_CREDENTIAL_KEY);
  const sealed = await seal('a-credential', key!);
  const answer = await storeNamed(ACCOUNT_NAME).applyChange(ACCOUNT_NAME, 'connect_source_account', {
    commandId: crypto.randomUUID(),
    issuedAt: new Date().toISOString(),
    workspaceId: WORKSPACE_ID,
    sourceAccountId: crypto.randomUUID(),
    connectorId: FAKE,
    externalAccountKey: 'somebody',
    displayName: 'somebody at the source',
    ...sealed,
  });
  expect(answer.status).toBe('ok');
  await deliver(await waitForQueuedCheck());
}

function aPage(sourceId: string, title?: string): SourceItem {
  return {
    source: 'notion',
    sourceId,
    sourceLink: null,
    sender: null,
    sourceTimestamp: null,
    capturedMessage: `What page ${sourceId} says`,
    ...(title ? { title } : {}),
  };
}

interface Arrived {
  sourceId: string | null;
  title: string;
  typeId: string | null;
}

async function arrived(): Promise<Arrived[]> {
  const res = await asUser(`http://cockpit.test/v1/workspaces/${WORKSPACE_ID}/snapshot`);
  return ((await res.json()) as { items: (Arrived & { source: string })[] }).items.filter(
    (item) => item.source === 'notion',
  );
}

async function noteTypeId(): Promise<string> {
  const res = await asUser('http://cockpit.test/v1/item-types');
  const types = ((await res.json()) as { itemTypes: { id: string; name: string }[] }).itemTypes;
  return types.find((type) => type.name === 'Note')!.id;
}

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
  fake.arrivesAs = undefined;
  fake.emit = [];
  env.TEST_CONNECTORS = [fakeConnector()];
});

afterEach(() => {
  env.ENRICHMENT = realQueue;
  delete env.TEST_CONNECTORS;
  vi.restoreAllMocks();
});

describe('Connector management', () => {
  describe("a pulled connector's Items arrive as its manifest declares", () => {
    it('files a Task carrying the emitted title where it declares tasks', async () => {
      fake.arrivesAs = 'task';
      fake.emit = [aPage('a', 'The subject line')];
      env.TEST_CONNECTORS = [fakeConnector()];

      await connectedAndChecked();

      expect(await arrived()).toMatchObject([{ sourceId: 'a', title: 'The subject line', typeId: TASK_TYPE_ID }]);
    });

    it('files a Task titled from its message where it declares tasks and emits no title', async () => {
      fake.arrivesAs = 'task';
      fake.emit = [aPage('a')];
      env.TEST_CONNECTORS = [fakeConnector()];

      await connectedAndChecked();

      expect(await arrived()).toMatchObject([{ sourceId: 'a', title: 'What page a says', typeId: TASK_TYPE_ID }]);
    });

    it('files an untitled Note where it declares nothing, whatever title it emits', async () => {
      fake.emit = [aPage('a', 'The subject line')];
      env.TEST_CONNECTORS = [fakeConnector()];

      await connectedAndChecked();

      expect(await arrived()).toMatchObject([
        { sourceId: 'a', title: 'What page a says', typeId: await noteTypeId() },
      ]);
    });

    it('files the title under the fallback Type where the account no longer has its Task', async () => {
      const deleted = await asUser('http://cockpit.test/v1/commands/delete_item_type', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          commandId: crypto.randomUUID(),
          issuedAt: new Date().toISOString(),
          workspaceId: WORKSPACE_ID,
          typeId: TASK_TYPE_ID,
        }),
      });
      expect(deleted.status).toBe(200);
      fake.arrivesAs = 'task';
      fake.emit = [aPage('a', 'The subject line')];
      env.TEST_CONNECTORS = [fakeConnector()];

      await connectedAndChecked();

      expect(await arrived()).toMatchObject([
        { sourceId: 'a', title: 'The subject line', typeId: await noteTypeId() },
      ]);
    });
  });
});
