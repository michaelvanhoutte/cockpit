import { afterEach, beforeEach, describe, expect, inject, it, vi } from 'vitest';
import { SELF, applyD1Migrations, env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import type { Connector, ConnectorHost } from '@cockpit/connector-sdk';
import type { EnrichmentJob } from '../../../src/jobs/enrichment.js';
import { handleQueue, handleScheduled } from '../../../src/jobs/index.js';
import { open, seal, sealingKey } from '../../../src/connectors/credential-crypto.js';
import {
  ACCOUNT_NAME,
  WORKSPACE_ID,
  alsoWorkspaces,
  asUser,
  inTheStore,
  seedRegister,
  startFromEmpty,
  storeNamed,
  signInAs,
} from '../seed.js';
import { gmailHolds, gmailIsEmpty, issuerIsReachable, issuerWillIdentify } from '../issuer.js';
import { labelsAnswer } from '../../gmail-payloads.js';

/**
 * Integration level, through the account's real store, its real alarm and the
 * Worker's real queue consumer: every rule here is about what a check of a
 * pulled connection leaves in the store - its state, its credential, the Items
 * it filed - and about the timer and the lease that decide when it runs,
 * across the queue between the two ("Check a pulled connector on its cadence
 * through the generic host", issue 891).
 *
 * **Against a fake pulled connector**, registered here in place of the
 * registry's own list: no real source is pulled through this host until Gmail
 * moves onto it ("Move Gmail out of the core, onto the connector SDK", issue
 * 875). Each case scripts what its `sync` does.
 *
 * **A connection is made through the store's own change**, the one the
 * connect route writes: no route connects a pulled source until "Connect and
 * disconnect a source through one generic sign-in flow" (issue 892), so the
 * route cannot reach this by construction. Everything after - disconnecting,
 * reading the Workspace and its connections, the nightly run - is entered the
 * way the app enters it.
 *
 * **The queue is held**, so each case delivers the checks the alarm queued
 * through the real consumer itself, rather than waiting on the queue's own
 * timing. The arithmetic of a lease is tests/unit/domain/pulled-checks.test.ts's;
 * a store brought up to date with these tables keeping every row it held is
 * accounts/aged-store.test.ts's.
 */

const FAKE = 'fake-pull';
const OTHER_WORKSPACE_ID = 'ws-atlas';

const fake = {
  /** What the runs do, one script per run in order; the last repeats. */
  scripts: [] as ((host: ConnectorHost, run: number) => Promise<void>)[],
  /** How many runs have started. */
  runs: 0,
};

/** A source Cockpit pulls from, whose every run does what the case scripted. */
const fakePulled: Connector = {
  manifest: {
    id: FAKE,
    displayName: 'A pulled source',
    source: 'notion',
    supportsPush: false,
    pulled: true,
    auth: { kind: 'none' },
  },
  async sync(host) {
    fake.runs += 1;
    const script = fake.scripts[Math.min(fake.runs, fake.scripts.length) - 1];
    await script?.(host, fake.runs);
  },
};

/** What every run does, from the next one on. */
function everyRun(script: (host: ConnectorHost, run: number) => Promise<void>): void {
  fake.scripts = [script];
}

/** What the next runs do, one each, the last repeating. */
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

/** The checks queued and not yet delivered, oldest first, taken off the held queue. */
function takeQueuedChecks(): EnrichmentJob[] {
  const checks = held.filter((job) => job.kind === 'check-a-pulled-connection');
  held = held.filter((job) => job.kind !== 'check-a-pulled-connection');
  return checks;
}

/** Delivers one message through the real consumer, and says whether it was asked to be tried again. */
async function deliver(body: EnrichmentJob): Promise<{ retried: boolean }> {
  let retried = false;
  await handleQueue(
    {
      queue: 'cockpit-enrichment',
      messages: [
        {
          id: crypto.randomUUID(),
          timestamp: new Date(),
          body,
          attempts: 1,
          ack: () => {},
          retry: () => {
            retried = true;
          },
        },
      ],
      ackAll: () => {},
      retryAll: () => {},
    } as unknown as Parameters<typeof handleQueue>[0],
    env,
  );
  return { retried };
}

async function seal_(credential: string) {
  const key = await sealingKey(env.CONNECTOR_CREDENTIAL_KEY);
  return seal(credential, key!);
}

/**
 * Connects an account at the fake source to a Workspace, as the connect
 * route's own change does, and answers the connection's id. The same account
 * connected again keeps its id, with the new credential.
 */
async function connect(
  externalAccountKey = 'somebody',
  workspaceId = WORKSPACE_ID,
  credential = 'the-first-credential',
): Promise<string> {
  const sealed = await seal_(credential);
  const sourceAccountId = crypto.randomUUID();
  const answer = await storeNamed(ACCOUNT_NAME).applyChange(ACCOUNT_NAME, 'connect_source_account', {
    commandId: crypto.randomUUID(),
    issuedAt: new Date().toISOString(),
    workspaceId,
    sourceAccountId,
    connectorId: FAKE,
    externalAccountKey,
    displayName: `${externalAccountKey} at the source`,
    ...sealed,
  });
  expect(answer.status).toBe('ok');
  return (await connectionsOf(workspaceId)).find((row) => row.displayName === `${externalAccountKey} at the source`)!
    .id;
}

interface ConnectionRow {
  id: string;
  displayName: string;
  lastTestedAt: string | null;
  failingBecause: string | null;
}

async function connectionsOf(workspaceId = WORKSPACE_ID): Promise<ConnectionRow[]> {
  const res = await asUser(`http://cockpit.test/v1/workspaces/${workspaceId}/connections`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { sourceAccounts: ConnectionRow[] }).sourceAccounts;
}

/** Disconnects a connection, as its row's Disconnect does. */
async function disconnect(sourceAccountId: string, workspaceId = WORKSPACE_ID): Promise<void> {
  const res = await asUser('http://cockpit.test/v1/commands/disconnect_source_account', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      commandId: crypto.randomUUID(),
      issuedAt: new Date().toISOString(),
      workspaceId,
      sourceAccountId,
    }),
  });
  expect(res.status).toBe(200);
}

interface InboxItem {
  id: string;
  title: string;
  sourceId: string | null;
  completedAt: string | null;
}

async function itemsFrom(workspaceId = WORKSPACE_ID): Promise<InboxItem[]> {
  const res = await asUser(`http://cockpit.test/v1/workspaces/${workspaceId}/snapshot`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { items: (InboxItem & { source: string })[] }).items.filter(
    (item) => item.source === 'notion',
  );
}

function nextAlarm(): Promise<number | null> {
  return runInDurableObject(storeNamed(ACCOUNT_NAME), (_instance, state) => state.storage.getAlarm());
}

/** Waits for the check connecting queued at once - its alarm is set for now, so it fires by itself. */
async function checksQueue(count = 1): Promise<EnrichmentJob[]> {
  for (let waited = 0; waited < 10_000; waited += 25) {
    const queued = held.filter((job) => job.kind === 'check-a-pulled-connection');
    if (queued.length >= count) return takeQueuedChecks();
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`fewer than ${count} checks were ever queued`);
}

/** The alarm firing for the time it was set for, and the checks it queued. */
async function alarmFires(): Promise<EnrichmentJob[]> {
  await runDurableObjectAlarm(storeNamed(ACCOUNT_NAME));
  return takeQueuedChecks();
}

/** Connects, and runs the check connecting queues - the first run of the connection. */
async function connectedAndChecked(...args: Parameters<typeof connect>): Promise<string> {
  const id = await connect(...args);
  for (const check of await checksQueue()) await deliver(check);
  return id;
}

/** The next check of every pulled connection: the alarm fires, and each check it queued is delivered. */
async function nextChecksRun(): Promise<void> {
  for (const check of await alarmFires()) await deliver(check);
}

/** Connects a Gmail mailbox holding nothing labelled, the whole walk a browser makes, as gmail-import.test.ts does. */
async function connectGmail(): Promise<void> {
  gmailHolds({ labels: labelsAnswer(), historyId: '777', threads: [], history: [], historyLapsed: false });
  await issuerIsReachable();
  const session = await signInAs();
  const started = await SELF.fetch(`http://cockpit.test/v1/workspaces/${WORKSPACE_ID}/connections/gmail/connect`, {
    redirect: 'manual',
    headers: { cookie: session },
  });
  const asked = new URL(started.headers.get('location')!);
  const attempt = started.headers
    .getSetCookie()
    .map((cookie) => cookie.split(';')[0]!)
    .find((cookie) => cookie.startsWith('cockpit_connect='))!;
  issuerWillIdentify({ email: 'anna@example.com', subject: 'google-anna', nonce: asked.searchParams.get('nonce')! }, 'a-code', {
    refresh_token: 'anna-refresh',
    access_token: 'access-for-anna',
    expires_in: 3599,
    scope: 'openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/gmail.modify',
  });
  const back = await SELF.fetch(
    `http://cockpit.test/v1/connections/gmail/callback?code=a-code&state=${asked.searchParams.get('state')}`,
    { redirect: 'manual', headers: { cookie: `${session}; ${attempt}` } },
  );
  expect(back.headers.get('location')).toBe(`/w/${WORKSPACE_ID}?connections=gmail-connected`);
}

/** When the Workspace's Gmail connection was last checked. */
async function gmailLastChecked(): Promise<string | null> {
  const rows = (await connectionsOf()) as (ConnectionRow & { connectorId: string })[];
  return rows.find((row) => row.connectorId === 'gmail')?.lastTestedAt ?? null;
}

/**
 * The alarm firing, each time for when it was set, until uns checks have
 * run in all - for connections whose next checks fall due moments apart.
 */
async function checksRunUntil(runs: number): Promise<void> {
  for (let fired = 0; fired < 5 && fake.runs < runs; fired += 1) await nextChecksRun();
  expect(fake.runs).toBe(runs);
}

beforeEach(async () => {
  await applyD1Migrations(env.DB, inject('migrations'));
  await startFromEmpty();
  await seedRegister();
  await alsoWorkspaces();
  held = [];
  holdTheQueue();
  fake.runs = 0;
  everyRun(async () => {});
  env.TEST_CONNECTORS = [fakePulled];
  gmailIsEmpty();
});

afterEach(() => {
  env.ENRICHMENT = realQueue;
  delete env.TEST_CONNECTORS;
  env.ANTHROPIC_API_KEY = '';
  env.EMBEDDINGS_STAND_IN = '';
  vi.restoreAllMocks();
});

describe('Connector management', () => {
  describe('a pulled connection is checked about every five minutes while it is connected, and never after it is disconnected', () => {
    it('is checked as soon as it is connected, and again when its next check falls due about five minutes on', async () => {
      await connectedAndChecked();
      expect(fake.runs).toBe(1);

      const next = await nextAlarm();
      expect(next).not.toBeNull();
      expect(next! - Date.now()).toBeGreaterThan(4 * 60_000);
      expect(next! - Date.now()).toBeLessThanOrEqual(5 * 60_000);

      await nextChecksRun();
      expect(fake.runs).toBe(2);
    });

    it('is not checked again once disconnected, even by a check already queued', async () => {
      const id = await connectedAndChecked();
      await disconnect(id);

      expect(await nextAlarm()).toBeNull();
      await deliver({ kind: 'check-a-pulled-connection', accountName: ACCOUNT_NAME, sourceAccountId: id });
      expect(fake.runs).toBe(1);
    });

    it('the same account connected in two Workspaces is checked in each', async () => {
      everyRun(async (host) => {
        const seen = ((await host.getState()) as { runs: number } | null)?.runs ?? 0;
        await host.setState({ runs: seen + 1 });
      });
      await connect('somebody', WORKSPACE_ID);
      await connect('somebody', OTHER_WORKSPACE_ID);
      const checks = await checksQueue(2);
      for (const check of checks) await deliver(check);

      expect(fake.runs).toBe(2);
      const states = await inTheStore((sql) =>
        [...sql.exec<{ state: string }>('SELECT state FROM pulled_connections')].map((row) => row.state),
      );
      expect(states).toEqual(['{"runs":1}', '{"runs":1}']);
    });

    it('a check whose alarm was lost is armed again by the nightly run', async () => {
      await connectedAndChecked();
      await runInDurableObject(storeNamed(ACCOUNT_NAME), (_instance, state) => state.storage.deleteAlarm());

      await handleScheduled({} as never, env);

      expect(await nextAlarm()).not.toBeNull();
      await nextChecksRun();
      expect(fake.runs).toBe(2);
    });
  });

  describe('an account with a Gmail connection as well keeps both checked, on its one alarm', () => {
    it('checks the Gmail connection and the pulled one, and each again when it falls due', async () => {
      await connectGmail();
      await connectedAndChecked();
      for (let waited = 0; waited < 10_000 && (await gmailLastChecked()) === null; waited += 25) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      const gmailFirst = await gmailLastChecked();
      expect(gmailFirst).not.toBeNull();
      expect(fake.runs).toBe(1);

      for (let fired = 0; fired < 6 && (fake.runs < 2 || (await gmailLastChecked()) === gmailFirst); fired += 1) {
        await nextChecksRun();
      }

      expect(fake.runs).toBe(2);
      expect(await gmailLastChecked()).not.toBe(gmailFirst);
    });
  });

  describe('a pulled connector reads back exactly the private state it last saved for that connection', () => {
    it('reads nothing before it saved anything, what it saved in the last check after, and never another connection’s', async () => {
      const read: unknown[] = [];
      everyRun(async (host, run) => {
        read.push(await host.getState());
        await host.setState({ cursor: `after-run-${run}` });
      });
      await connect('somebody');
      await connect('somebody-else');
      for (const check of await checksQueue(2)) await deliver(check);
      expect(read).toEqual([null, null]);

      await checksRunUntil(4);
      expect(read.slice(2)).toEqual(expect.arrayContaining([{ cursor: 'after-run-1' }, { cursor: 'after-run-2' }]));
    });
  });

  describe('a pulled connector gets its connection’s credential opened, and a refreshed one it hands back is what the next check gets', () => {
    it.each([
      { situation: 'nothing handed back', handsBack: null, nextGets: 'the-first-credential' },
      { situation: 'a refreshed one handed back', handsBack: 'a-refreshed-credential', nextGets: 'a-refreshed-credential' },
    ])('the next check gets the right one, with $situation', async ({ handsBack, nextGets }) => {
      const got: string[] = [];
      runsIn(
        async (host) => {
          got.push((await host.getCredentials()).credential!);
          if (handsBack) await host.setCredentials({ credential: handsBack });
        },
        async (host) => {
          got.push((await host.getCredentials()).credential!);
        },
      );
      await connectedAndChecked();
      await nextChecksRun();

      expect(got).toEqual(['the-first-credential', nextGets]);
    });

    it('a refresh is not kept where the account was connected again while the check ran, and what that stored is whole', async () => {
      const got: string[] = [];
      runsIn(
        async (host) => {
          got.push((await host.getCredentials()).credential!);
          await connect('somebody', WORKSPACE_ID, 'connected-again');
          await host.setCredentials({ credential: 'a-refreshed-credential' });
        },
        async (host) => {
          got.push((await host.getCredentials()).credential!);
        },
      );
      await connectedAndChecked();
      await nextChecksRun();

      expect(got).toEqual(['the-first-credential', 'connected-again']);
      const stored = await inTheStore(
        (sql) =>
          [
            ...sql.exec<{ encrypted_credential: string; credential_nonce: string }>(
              `SELECT encrypted_credential, credential_nonce FROM connector_accounts WHERE connector_id = '${FAKE}'`,
            ),
          ][0]!,
      );
      const key = await sealingKey(env.CONNECTOR_CREDENTIAL_KEY);
      expect(
        await open({ sealedCredential: stored.encrypted_credential, credentialNonce: stored.credential_nonce }, key!),
      ).toBe('connected-again');
    });
  });

  describe('an Item a pulled connector emits is filed once per source id in the connection’s Workspace, and queued for clean-up and for reading its meaning', () => {
    const anItem = (sourceId: string) => ({
      source: 'notion' as const,
      sourceId,
      title: `Page ${sourceId}`,
      capturedMessage: `What page ${sourceId} says`,
    });

    it('files a new source id as an open Item there, and asks for both', async () => {
      // Both set, so neither is left unasked because this environment could not have run it.
      env.ANTHROPIC_API_KEY = 'a-key-that-proves-nothing-here';
      env.EMBEDDINGS_STAND_IN = 'true';
      const answers: string[] = [];
      everyRun(async (host) => {
        answers.push(await host.emitItem(anItem('page-1')));
      });
      await connectedAndChecked();

      expect(answers).toEqual(['filed']);
      const [item] = await itemsFrom();
      expect(item).toMatchObject({ sourceId: 'page-1', completedAt: null });
      expect(await itemsFrom(OTHER_WORKSPACE_ID)).toEqual([]);
      const asked = held.filter((job) => 'itemId' in job && job.itemId === item!.id).map((job) => job.kind);
      expect(asked.sort()).toEqual(['clean-up-a-note', 'read-what-a-note-means']);
    });

    it('the same source id in a later check is already known, and no second Item', async () => {
      const answers: string[] = [];
      everyRun(async (host) => {
        answers.push(await host.emitItem(anItem('page-1')));
      });
      await connectedAndChecked();
      await nextChecksRun();

      expect(answers).toEqual(['filed', 'already-known']);
      expect(await itemsFrom()).toHaveLength(1);
    });

    it('files every one of more than a hundred in one check', async () => {
      everyRun(async (host) => {
        for (let page = 0; page < 101; page += 1) await host.emitItem(anItem(`page-${page}`));
      });
      await connectedAndChecked();

      expect(await itemsFrom()).toHaveLength(101);
    });
  });

  describe('a source-state change reaches the Item the connection filed for that source id', () => {
    it.each([
      { situation: 'resolved, for a page it filed', sourceId: 'page-1', done: true },
      { situation: 'resolved, for a page it never filed', sourceId: 'page-unknown', done: false },
    ])('$situation', async ({ sourceId, done }) => {
      runsIn(
        async (host) => {
          await host.emitItem({ source: 'notion', sourceId: 'page-1', title: 'Page 1' });
        },
        async (host) => {
          await host.emitSourceStateChange({ sourceId, change: 'resolved', observedAt: new Date().toISOString() });
        },
      );
      const id = await connectedAndChecked();
      await nextChecksRun();

      const [item] = await itemsFrom();
      expect(item!.completedAt !== null).toBe(done);
      expect((await connectionsOf()).find((row) => row.id === id)!.failingBecause).toBeNull();
    });
  });

  describe('a pulled connection is checked one run at a time', () => {
    it('a check delivered while one is running does nothing', async () => {
      const id = await connect();
      const [check] = await checksQueue();
      everyRun(async () => {
        if (fake.runs === 1) await deliver(check!);
      });
      await deliver(check!);

      expect(fake.runs).toBe(1);
      void id;
    });

    it('the same check delivered twice is one run', async () => {
      await connect();
      const [check] = await checksQueue();
      await deliver(check!);
      await deliver(check!);

      expect(fake.runs).toBe(1);
    });

    it('a run that went away without ending is checked again once its time has run out', async () => {
      const id = await connectedAndChecked();
      // A run that started and never ended - its Worker went away mid-run - and
      // whose time has since run out.
      const past = new Date(Date.now() - 60_000).toISOString();
      await inTheStore((sql) =>
        sql.exec(
          `UPDATE pulled_connections SET run_id = 'a-run-that-went-away', lease_until = ?, due_at = ?, queued_at = NULL
            WHERE source_account_id = ?`,
          past,
          past,
          id,
        ),
      );
      await nextChecksRun();
      expect(fake.runs).toBe(2);
    });
  });

  describe('a check that fails loses nothing and says why', () => {
    it('one that fails after filing, before saving where it got to, is read again from where it last saved', async () => {
      const read: unknown[] = [];
      const answers: string[] = [];
      runsIn(
        async (host) => {
          read.push(await host.getState());
          answers.push(await host.emitItem({ source: 'notion', sourceId: 'page-1', title: 'Page 1' }));
          await host.setState({ after: 'page-1' });
        },
        async (host) => {
          read.push(await host.getState());
          answers.push(await host.emitItem({ source: 'notion', sourceId: 'page-2', title: 'Page 2' }));
          throw new Error('the source stopped answering');
        },
        async (host) => {
          read.push(await host.getState());
          answers.push(await host.emitItem({ source: 'notion', sourceId: 'page-2', title: 'Page 2' }));
          await host.setState({ after: 'page-2' });
        },
      );
      await connectedAndChecked();
      await nextChecksRun();
      await nextChecksRun();

      expect(read).toEqual([null, { after: 'page-1' }, { after: 'page-1' }]);
      expect(answers).toEqual(['filed', 'filed', 'already-known']);
      expect((await itemsFrom()).map((item) => item.sourceId).sort()).toEqual(['page-1', 'page-2']);
    });

    it('the connection’s row reads why it is failing, until the next check that works', async () => {
      runsIn(
        async () => {
          throw new Error('the source stopped answering');
        },
        async () => {},
      );
      const id = await connectedAndChecked();
      expect((await connectionsOf()).find((row) => row.id === id)).toMatchObject({
        failingBecause: 'the source stopped answering',
      });

      const before = Date.now();
      await nextChecksRun();
      const row = (await connectionsOf()).find((one) => one.id === id)!;
      expect(row.failingBecause).toBeNull();
      expect(Date.parse(row.lastTestedAt!)).toBeGreaterThanOrEqual(before);
    });
  });

  describe('a connection disconnected while it is being checked gets nothing more from that check', () => {
    it('files nothing and saves nothing after the disconnect', async () => {
      let id = '';
      const answers: string[] = [];
      everyRun(async (host) => {
        await disconnect(id);
        answers.push(await host.emitItem({ source: 'notion', sourceId: 'page-1', title: 'Page 1' }));
        await host.setState({ after: 'page-1' });
      });
      id = await connect();
      for (const check of await checksQueue()) await deliver(check);

      expect(fake.runs).toBe(1);
      expect(await itemsFrom()).toEqual([]);
      const states = await inTheStore((sql) =>
        [...sql.exec<{ state: string | null }>('SELECT state FROM pulled_connections')].map((row) => row.state),
      );
      expect(states).toEqual([null]);
    });
  });
});
