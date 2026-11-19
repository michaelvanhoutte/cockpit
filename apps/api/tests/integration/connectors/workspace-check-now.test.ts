import { afterEach, beforeEach, describe, expect, inject, it } from 'vitest';
import { SELF, applyD1Migrations, env } from 'cloudflare:test';
import type { Connector, ConnectorHost, SyncAnswer } from '@cockpit/connector-sdk';
import type { ServerEvent } from '@cockpit/shared';
import type { EnrichmentJob } from '../../../src/jobs/enrichment.js';
import { handleQueue } from '../../../src/jobs/index.js';
import { seal, sealingKey } from '../../../src/connectors/credential-crypto.js';
import {
  ACCOUNT_NAME,
  WORKSPACE_ID,
  alsoWorkspaces,
  asUser,
  seedRegister,
  startFromEmpty,
  storeNamed,
} from '../seed.js';

/**
 * Integration level, through the account's real store, its real alarm, the
 * Worker's real queue consumer and the routes: what pressing the Inbox's ↻
 * does to a Workspace's pulled connections, what the Workspace read lists to
 * draw it, and what the announcement of a check's end carries ("Inbox: mail you just labelled waits for the five-minute check, or a Check now per connection in Settings: add a ↻ to the Inbox heading that checks them all now", issue 1835). Against
 * fake pulled connectors, as connection-check-now.test.ts is.
 */

const GMAIL = 'fake-gmail';
const OUTLOOK = 'fake-outlook';
const OTHER_WORKSPACE_ID = 'ws-atlas';

const fake = { scripts: new Map<string, (host: ConnectorHost) => Promise<void | SyncAnswer>>(), host: null as ConnectorHost | null };
const hostOf = () => fake.host!;

const pulled = (id: string): Connector => ({
  manifest: { id, displayName: id, cardText: 'A source Cockpit pulls from.', supportsPush: false, pulled: true, auth: { kind: 'none' } },
  async sync(host: ConnectorHost) {
    fake.host = host;
    return fake.scripts.get(id)?.(host);
  },
});

let held: EnrichmentJob[] = [];
let realQueue: typeof env.ENRICHMENT;

const queuedChecks = () => held.filter((job) => job.kind === 'check-a-pulled-connection');

async function deliver(body: EnrichmentJob): Promise<void> {
  await handleQueue(
    {
      queue: 'cockpit-enrichment',
      messages: [{ id: crypto.randomUUID(), timestamp: new Date(), body, attempts: 1, ack: () => {}, retry: () => {} }], // clock-ok: the store stamps with its own clock, which the test reads against
      ackAll: () => {},
      retryAll: () => {},
    } as unknown as Parameters<typeof handleQueue>[0],
    env,
  );
}

async function connect(connectorId: string, name: string, workspaceId = WORKSPACE_ID): Promise<string> {
  const key = await sealingKey(env.CONNECTOR_CREDENTIAL_KEY);
  const sourceAccountId = crypto.randomUUID();
  const answer = await storeNamed(ACCOUNT_NAME).applyChange(ACCOUNT_NAME, 'connect_source_account', {
    commandId: crypto.randomUUID(),
    issuedAt: new Date().toISOString(), // clock-ok: the store stamps with its own clock, which the test reads against
    workspaceId,
    sourceAccountId,
    connectorId,
    externalAccountKey: name,
    displayName: name,
    ...(await seal('a-credential', key!)),
  });
  expect(answer.status).toBe('ok');
  return sourceAccountId;
}

async function waitForQueued(count: number): Promise<void> {
  for (let waited = 0; waited < 10_000; waited += 25) {
    if (queuedChecks().length >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`fewer than ${count} checks were ever queued`);
}

async function queuedChecksRun(): Promise<void> {
  const checks = queuedChecks();
  held = held.filter((job) => job.kind !== 'check-a-pulled-connection');
  for (const check of checks) await deliver(check);
}

/** Each connection's first check, run: it leaves the connection idle. */
async function connectedAndChecked(...ids: string[]): Promise<void> {
  await waitForQueued(ids.length);
  await queuedChecksRun();
}

const checkWorkspace = (workspaceId = WORKSPACE_ID) =>
  asUser(`http://cockpit.test/v1/workspaces/${workspaceId}/connections/check-now`, { method: 'POST' });

type Pressed = { connections: { sourceAccountId: string; status: string }[]; at: string };
async function pressed(workspaceId = WORKSPACE_ID): Promise<Pressed> {
  const res = await checkWorkspace(workspaceId);
  expect(res.status).toBe(200);
  return (await res.json()) as Pressed;
}

const statusesOf = (answer: Pressed) => Object.fromEntries(answer.connections.map((one) => [one.sourceAccountId, one.status]));

async function opened(workspaceId = WORKSPACE_ID): Promise<{ checkable?: { sourceAccountId: string; name: string }[] }> {
  return (await (await asUser(`http://cockpit.test/v1/workspaces/${workspaceId}/snapshot`)).json()) as never;
}

async function announcementsSince(since: string): Promise<Extract<ServerEvent, { type: 'connection_history_changed' }>[]> {
  const answer = await storeNamed(ACCOUNT_NAME).changesSince(ACCOUNT_NAME, since);
  if (answer.status !== 'ok') throw new Error('the store did not answer');
  return answer.value.events.filter(
    (event): event is Extract<ServerEvent, { type: 'connection_history_changed' }> => event.type === 'connection_history_changed',
  );
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
  } as unknown as typeof env.ENRICHMENT;
  fake.scripts = new Map();
  env.TEST_CONNECTORS = [pulled(GMAIL), pulled(OUTLOOK)];
});

afterEach(() => {
  env.ENRICHMENT = realQueue;
  delete env.TEST_CONNECTORS;
});

describe('Connector management', () => {
  describe('One press checks every pulled connection of the Workspace, under Check now’s rules', () => {
    it('queues a check for each connection that is idle, and answers each with the time of the press', async () => {
      const gmail = await connect(GMAIL, 'me@home.com');
      const outlook = await connect(OUTLOOK, 'me@work.com');
      await connectedAndChecked(gmail, outlook);

      const answer = await pressed();

      expect(statusesOf(answer)).toEqual({ [gmail]: 'queued', [outlook]: 'queued' });
      expect(Number.isNaN(Date.parse(answer.at))).toBe(false);
      await waitForQueued(2);
      expect(queuedChecks()).toHaveLength(2);
    });

    it('relabels a check already waiting, and queues no second', async () => {
      const gmail = await connect(GMAIL, 'me@home.com');
      const outlook = await connect(OUTLOOK, 'me@work.com');
      await waitForQueued(2);

      expect(statusesOf(await pressed())).toEqual({ [gmail]: 'already queued', [outlook]: 'already queued' });
      expect(queuedChecks()).toHaveLength(2);
      await queuedChecksRun();
      for (const id of [gmail, outlook]) {
        const history = (await (await asUser(`http://cockpit.test/v1/workspaces/${WORKSPACE_ID}/connections/${id}/history`)).json()) as {
          lines: { reason: string }[];
        };
        expect(history.lines.map((line) => line.reason)).toEqual(['check-now']);
      }
    });

    it('queues nothing for a check running, and queues the other connection’s', async () => {
      const gmail = await connect(GMAIL, 'me@home.com');
      const outlook = await connect(OUTLOOK, 'me@work.com');
      await connectedAndChecked(gmail, outlook);
      await pressed();
      await waitForQueued(2);
      const [gmailsCheck, outlooksCheck] = [
        queuedChecks().find((job) => job.sourceAccountId === gmail)!,
        queuedChecks().find((job) => job.sourceAccountId === outlook)!,
      ];
      held = [];

      let during: Pressed | undefined;
      fake.scripts.set(GMAIL, async () => {
        during = await pressed();
      });
      await deliver(gmailsCheck);

      expect(during && statusesOf(during)).toEqual({ [gmail]: 'running', [outlook]: 'already queued' });
      expect(queuedChecks()).toHaveLength(0);
      expect(outlooksCheck).toBeDefined();
    });

    it('leaves out a connection the source pushes, and one of another Workspace', async () => {
      const gmail = await connect(GMAIL, 'me@home.com');
      await connect('teams', 'a-team');
      await connect(GMAIL, 'me@work.com', OTHER_WORKSPACE_ID);
      await connectedAndChecked(gmail);

      expect(Object.keys(statusesOf(await pressed()))).toEqual([gmail]);
    });

    it('answers nothing, and queues nothing, for a Workspace with no pulled connection', async () => {
      await connect('teams', 'a-team');

      expect(await pressed()).toEqual({ connections: [], at: expect.any(String) });
      expect(queuedChecks()).toHaveLength(0);
    });

    it('queues one check each however often it is pressed before they run', async () => {
      const gmail = await connect(GMAIL, 'me@home.com');
      const outlook = await connect(OUTLOOK, 'me@work.com');
      await connectedAndChecked(gmail, outlook);

      const first = await pressed();
      // The alarm has queued them when the press comes again, as it has by the time a person presses twice.
      await waitForQueued(2);
      const again = await pressed();

      expect(statusesOf(first)).toEqual({ [gmail]: 'queued', [outlook]: 'queued' });
      expect(statusesOf(again)).toEqual({ [gmail]: 'already queued', [outlook]: 'already queued' });
      expect(queuedChecks()).toHaveLength(2);
    });

    it('is refused as not found for a Workspace the account does not have, and at the guest’s gate as every connection change is', async () => {
      expect((await checkWorkspace('ws-nobody-has')).status).toBe(404);

      const back = await SELF.fetch('http://cockpit.test/v1/sign-in/guest', { redirect: 'manual' });
      const cookie = back.headers.getSetCookie().map((one) => one.split(';')[0]!).find((one) => one.startsWith('cockpit_session='))!;
      const workspaces = (await (await SELF.fetch('http://cockpit.test/v1/workspaces', { headers: { cookie } })).json()) as {
        workspaces: { id: string }[];
      };
      const asGuest = await SELF.fetch(
        `http://cockpit.test/v1/workspaces/${workspaces.workspaces[0]!.id}/connections/check-now`,
        { method: 'POST', headers: { cookie } },
      );
      // The gate every connection route sits behind answers it, the card's Check now with it (issue 772).
      expect(asGuest.status).toBe(403);
    });
  });

  describe('The Workspace read lists the connections the Inbox’s ↻ checks', () => {
    it('names the pulled ones, with their ids, and not the pushed', async () => {
      const gmail = await connect(GMAIL, 'me@home.com');
      const outlook = await connect(OUTLOOK, 'me@work.com');
      await connect('teams', 'a-team');

      expect((await opened()).checkable).toEqual([
        { sourceAccountId: gmail, name: 'me@home.com' },
        { sourceAccountId: outlook, name: 'me@work.com' },
      ]);
    });

    it('lists none where nothing is connected, and not one that was disconnected', async () => {
      expect((await opened()).checkable).toEqual([]);

      const gmail = await connect(GMAIL, 'me@home.com');
      const outlook = await connect(OUTLOOK, 'me@work.com');
      const res = await asUser('http://cockpit.test/v1/commands/disconnect_source_account', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          commandId: crypto.randomUUID(),
          issuedAt: new Date().toISOString(), // clock-ok: the store stamps with its own clock, which the test reads against
          workspaceId: WORKSPACE_ID,
          sourceAccountId: outlook,
        }),
      });
      expect(res.status).toBe(200);

      expect((await opened()).checkable).toEqual([{ sourceAccountId: gmail, name: 'me@home.com' }]);
    });
  });

  describe('A check ending announces what its line says', () => {
    async function checkedOnce(script: (host: ConnectorHost) => Promise<void | SyncAnswer>) {
      const id = await connect(GMAIL, 'me@home.com');
      await connectedAndChecked(id);
      const since = new Date().toISOString(); // clock-ok: the store stamps with its own clock, which the test reads against
      await new Promise((resolve) => setTimeout(resolve, 5));
      fake.scripts.set(GMAIL, script);
      await pressed();
      await waitForQueued(1);
      await queuedChecksRun();
      return { id, since };
    }

    it('says a check that brought in two and closed one worked, with those counts, at the line’s time', async () => {
      const page = (sourceId: string) => ({
        sourceId,
        sourceLink: null,
        sender: null,
        sourceTimestamp: null,
        title: `Page ${sourceId}`,
        capturedMessage: `What page ${sourceId} says`,
        choice: 'label',
      });
      const id = await connect(GMAIL, 'me@home.com');
      fake.scripts.set(GMAIL, async () => {
        const host = hostOf();
        await host.emitItem(page('c'));
        await host.reportCompleteListing({ choice: 'label', sourceIds: ['c'] });
      });
      await connectedAndChecked(id);
      const since = new Date().toISOString(); // clock-ok: the store stamps with its own clock, which the test reads against
      await new Promise((resolve) => setTimeout(resolve, 5));
      fake.scripts.set(GMAIL, async () => {
        const host = hostOf();
        await host.emitItem(page('d'));
        await host.emitItem(page('e'));
        await host.reportCompleteListing({ choice: 'label', sourceIds: ['d', 'e'] });
      });
      await pressed();
      await waitForQueued(1);
      await queuedChecksRun();

      expect(await announcementsSince(since)).toEqual([
        expect.objectContaining({ sourceAccountId: id, outcome: 'worked', broughtIn: 2, closed: 1, at: expect.any(String) }),
      ]);
    });

    it('says a check that failed failed, with the source’s message', async () => {
      const { id, since } = await checkedOnce(async () => {
        throw new Error('the source said no');
      });

      expect(await announcementsSince(since)).toEqual([
        expect.objectContaining({ sourceAccountId: id, outcome: 'failed', message: 'the source said no', broughtIn: 0, closed: 0, at: expect.any(String) }),
      ]);
    });

    it('says a quiet check worked, brought nothing in and closed nothing, at the newer time', async () => {
      const { id, since } = await checkedOnce(async () => {});

      const [announced] = await announcementsSince(since);
      expect(announced).toMatchObject({ sourceAccountId: id, outcome: 'worked', message: null, broughtIn: 0, closed: 0 });
      expect(announced!.at! > since).toBe(true);
    });
  });
});
