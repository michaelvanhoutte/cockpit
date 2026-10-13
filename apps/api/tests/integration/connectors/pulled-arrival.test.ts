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
  inTheStore,
  seedRegister,
  startFromEmpty,
  storeNamed,
} from '../seed.js';

/**
 * Integration level, through the account's real store and the Worker's real
 * queue consumer: what a pulled connector's Items arrive as - titled, with no
 * Type ("Capture without a Type, at every front door", issue 1067). Against a
 * fake pulled connector, registered in place of the registry's list.
 */

const FAKE = 'fake-arrivals';

const fake = {
  emit: [] as SourceItem[],
};

function fakeConnector(): Connector {
  return {
    manifest: {
      id: FAKE,
      displayName: 'A pulled source',
      cardText: 'A source Cockpit pulls from.',
      supportsPush: false,
      pulled: true,
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
  description: string | null;
  typeId: string | null;
}

async function arrived(): Promise<Arrived[]> {
  const res = await asUser(`http://cockpit.test/v1/workspaces/${WORKSPACE_ID}/snapshot`);
  return ((await res.json()) as { items: (Arrived & { source: string })[] }).items.filter(
    (item) => item.source === FAKE,
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
  fake.emit = [];
  env.TEST_CONNECTORS = [fakeConnector()];
});

afterEach(() => {
  env.ENRICHMENT = realQueue;
  delete env.TEST_CONNECTORS;
  vi.restoreAllMocks();
});

describe('Connector management', () => {
  describe("a pulled connector's Items arrive titled and with no Type", () => {
    it('files an Item carrying the emitted title', async () => {
      fake.emit = [aPage('a', 'The subject line')];
      env.TEST_CONNECTORS = [fakeConnector()];

      await connectedAndChecked();

      expect(await arrived()).toMatchObject([{ sourceId: 'a', title: 'The subject line', typeId: null }]);
    });

    it('files an Item titled from its message where the connector emits no title', async () => {
      fake.emit = [aPage('a')];
      env.TEST_CONNECTORS = [fakeConnector()];

      await connectedAndChecked();

      expect(await arrived()).toMatchObject([{ sourceId: 'a', title: 'What page a says', typeId: null }]);
    });

    it('files an Item without repeating a title that is all the source said as its description', async () => {
      fake.emit = [{ ...aPage('a', 'Only a title'), capturedMessage: null }];
      env.TEST_CONNECTORS = [fakeConnector()];

      await connectedAndChecked();

      expect(await arrived()).toMatchObject([{ sourceId: 'a', title: 'Only a title', description: null, typeId: null }]);
    });

    it('files an Item where the account has no Types at all, rather than failing the check', async () => {
      for (const typeId of [TASK_TYPE_ID, await noteTypeId()]) {
        const deleted = await asUser('http://cockpit.test/v1/commands/delete_item_type', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            commandId: crypto.randomUUID(),
            issuedAt: new Date().toISOString(),
            workspaceId: WORKSPACE_ID,
            typeId,
          }),
        });
        expect(deleted.status).toBe(200);
      }
      fake.emit = [aPage('a', 'The subject line')];
      env.TEST_CONNECTORS = [fakeConnector()];

      await connectedAndChecked();

      expect(await arrived()).toMatchObject([{ sourceId: 'a', title: 'The subject line', typeId: null }]);
    });
  });
});

/**
 * Integration because the source is stamped by the generic host on its way to
 * the real store, and what is served is that store's own read ("Store every
 * connector Item under its connector id, old Gmail Items included", issue
 * 993). A connector's Item can still carry a source at run time, from a
 * connector built against an older SDK, so the fake emits one. Gmail's own
 * check and a Teams save are the same host's paths, walked whole in
 * gmail-on-the-host.test.ts and teams-ingress.test.ts.
 */
describe('Connector management', () => {
  describe('an Item a connector brings in is stored and served under that connector’s id, whatever the connector says', () => {
    it.each([
      { situation: 'a connector that names no source', says: undefined },
      { situation: 'a connector that names some other source on its Item', says: 'notion' },
      { situation: 'a connector that names Gmail’s old source', says: 'mail' },
    ])('$situation', async ({ says }) => {
      fake.emit = [{ ...aPage('a'), ...(says ? { source: says } : {}) } as SourceItem];
      env.TEST_CONNECTORS = [fakeConnector()];

      await connectedAndChecked();

      const res = await asUser(`http://cockpit.test/v1/workspaces/${WORKSPACE_ID}/snapshot`);
      const served = ((await res.json()) as { items: { id: string; sourceId: string | null; source: string }[] }).items
        .filter((item) => item.sourceId === 'a');
      expect(served.map((item) => item.source)).toEqual([FAKE]);
      const stored = await inTheStore((sql) =>
        sql.exec('SELECT source, source_connector FROM items WHERE id = ?', served[0]!.id).toArray(),
      );
      expect(stored).toEqual([{ source: 'internal', source_connector: FAKE }]);
    });
  });
});
