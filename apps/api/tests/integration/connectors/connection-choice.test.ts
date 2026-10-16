import { afterEach, beforeEach, describe, expect, inject, it } from 'vitest';
import { SELF, applyD1Migrations, env, runDurableObjectAlarm } from 'cloudflare:test';
import type { Connector, ConnectorHost, SourceItem } from '@cockpit/connector-sdk';
import type { EnrichmentJob } from '../../../src/jobs/enrichment.js';
import { handleQueue } from '../../../src/jobs/index.js';
import { seal, sealingKey } from '../../../src/connectors/credential-crypto.js';
import {
  ACCOUNT_NAME,
  DASHBOARD_ID,
  USER_ID,
  WORKSPACE_ID,
  alsoWorkspaces,
  asUser,
  inTheStore,
  seedRegister,
  signInAs,
  startFromEmpty,
  storeNamed,
} from '../seed.js';
import { ISSUER, issuerIsForgotten, issuerIsReachable, issuerWillIdentify } from '../issuer.js';

/**
 * Integration level, through the real Worker and the account's real store: a
 * connector's one choice asked before Connect, carried through the sign-in in
 * the attempt, stored on the connection, changed later, and handed to the
 * connector on its next run ("Ask a connection's one choice on connecting, and
 * change it later", issue 942). Against fake connectors registered in place of
 * the registry's list: one that declares a choice and one that declares none.
 */

const CHOOSES = 'fake-chooses';
const PLAIN = 'fake-plain';
const NAMES = 'fake-names';
const OTHER_WORKSPACE = 'ws-atlas';

const OPTIONS = [
  { value: 'starred', label: 'Starred pages' },
  { value: 'all', label: 'Every page' },
] as const;

const settings = env as unknown as Record<string, string | undefined>;

/** The choice each run of the connector that declares one was handed, in order. */
const seen: (string | null)[] = [];

function sourceNamed(id: string, choice: boolean, names = false): Connector {
  return {
    manifest: {
      id,
      displayName: choice ? 'A source that asks first' : 'A source that asks nothing',
      cardText: 'A source.',
      supportsPush: false,
      pulled: true,
      mirrorsOpenState: true,
      ...(choice ? { choice: { question: 'Bring in', options: OPTIONS } } : {}),
      ...(names ? { names: { noun: 'category', example: 'a message with the category' } } : {}),
      auth: {
        kind: 'oauth2',
        endpoints: { authorizationUrl: `${ISSUER}/authorize`, tokenUrl: `${ISSUER}/token` },
        scopes: ['read'],
        clientSettings: { id: 'FAKE_SOURCE_CLIENT_ID', secret: 'FAKE_SOURCE_CLIENT_SECRET' },
      },
    },
    async sync(host: ConnectorHost) {
      seen.push(host.choice);
      await host.emitItem(names ? { ...aPage('page-1'), names: ['Customer Atlas'] } : aPage('page-1'));
    },
    async mirrorOpenState() {
      return [];
    },
    accountFrom({ tokenResponse }) {
      if (typeof tokenResponse.access_token !== 'string') return null;
      return { key: `account-of-${tokenResponse.access_token}`, displayName: `Source account ${tokenResponse.access_token}` };
    },
  };
}

function aPage(sourceId: string): SourceItem {
  return {
    sourceId,
    sourceLink: null,
    sender: null,
    sourceTimestamp: null,
    title: `Page ${sourceId}`,
    capturedMessage: `What page ${sourceId} says`,
  };
}

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
  seen.length = 0;
  env.TEST_CONNECTORS = [sourceNamed(CHOOSES, true), sourceNamed(PLAIN, false), sourceNamed(NAMES, true, true)];
  settings.FAKE_SOURCE_CLIENT_ID = 'the-fake-source-client';
  settings.FAKE_SOURCE_CLIENT_SECRET = 'the-fake-source-secret';
});

afterEach(() => {
  env.ENRICHMENT = realQueue;
  delete env.TEST_CONNECTORS;
  delete settings.FAKE_SOURCE_CLIENT_ID;
  delete settings.FAKE_SOURCE_CLIENT_SECRET;
  issuerIsForgotten();
});

interface StoredRow extends Record<string, string | null> {
  connector_id: string;
  choice: string | null;
}

function storedRows(): Promise<StoredRow[]> {
  return inTheStore((sql) => [
    ...sql.exec<StoredRow>('SELECT connector_id, choice FROM connector_accounts ORDER BY connected_at'),
  ]);
}

/** Pressing Connect once the window has asked: what the browser is sent to, and what it is left holding. */
async function startConnecting(connectorId: string, session: string, choice?: string, filesByName?: string) {
  const asked = new URLSearchParams();
  if (choice !== undefined) asked.set('choice', choice);
  if (filesByName !== undefined) asked.set('filesByName', filesByName);
  const query = asked.size ? `?${asked}` : '';
  const res = await SELF.fetch(
    `http://cockpit.test/v1/workspaces/${WORKSPACE_ID}/connections/${connectorId}/connect${query}`,
    { redirect: 'manual', headers: { cookie: session } },
  );
  const attempt = res.headers
    .getSetCookie()
    .map((cookie) => cookie.split(';')[0]!)
    .find((cookie) => cookie.startsWith('cockpit_connect='));
  return { res, attempt, asked: res.status === 302 && attempt ? new URL(res.headers.get('location')!) : null };
}

/** The source answering, and the browser coming back with the attempt it is holding. */
async function comeBack(connectorId: string, session: string, started: Awaited<ReturnType<typeof startConnecting>>, attempt = started.attempt) {
  await issuerIsReachable();
  issuerWillIdentify(
    { email: 'nobody@example.com', nonce: started.asked!.searchParams.get('nonce')! },
    'a-code',
    { access_token: 'ada' },
  );
  return SELF.fetch(
    `http://cockpit.test/v1/connections/${connectorId}/callback?${new URLSearchParams({
      code: 'a-code',
      state: started.asked!.searchParams.get('state')!,
    })}`,
    { redirect: 'manual', headers: { cookie: `${session}; ${attempt}` } },
  );
}

/** The same attempt as the browser holds it, with the choice replaced (or taken away) as a hand-edited cookie would. */
function withChoice(attempt: string, choice: string | undefined): string {
  const [name, value] = [attempt.slice(0, attempt.indexOf('=')), attempt.slice(attempt.indexOf('=') + 1)];
  const carried = JSON.parse(decodeURIComponent(value)) as Record<string, unknown>;
  if (choice === undefined) delete carried.choice;
  else carried.choice = choice;
  return `${name}=${encodeURIComponent(JSON.stringify(carried))}`;
}

async function connectedUnder(choice: string): Promise<{ id: string; session: string }> {
  const session = await signInAs(USER_ID);
  const started = await startConnecting(CHOOSES, session, choice);
  const back = await comeBack(CHOOSES, session, started);
  expect(back.headers.get('location')).toBe(`/w/${WORKSPACE_ID}?connections=connected`);
  return { id: (await listed(WORKSPACE_ID))[0]!.id, session };
}

interface Listed {
  id: string;
  connectorId: string;
  follows?: string;
  followsLabel?: string;
}

async function listed(workspaceId: string): Promise<Listed[]> {
  const res = await asUser(`http://cockpit.test/v1/workspaces/${workspaceId}/connections`);
  return ((await res.json()) as { sourceAccounts: Listed[] }).sourceAccounts;
}

function choose(workspaceId: string, sourceAccountId: string, choice: string) {
  return asUser('http://cockpit.test/v1/commands/set_connection_choice', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      commandId: crypto.randomUUID(),
      issuedAt: new Date().toISOString(),
      workspaceId,
      sourceAccountId,
      choice,
    }),
  });
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

async function nextCheckRuns(): Promise<void> {
  for (let waited = 0; waited < 10_000; waited += 25) {
    const checks = held.filter((job) => job.kind === 'check-a-pulled-connection');
    if (checks.length > 0) {
      held = held.filter((job) => job.kind !== 'check-a-pulled-connection');
      for (const check of checks) await deliver(check);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('no check was ever queued');
}

/** Connects the account directly under a choice and runs the check connecting queued, so an Item and its link exist. */
async function connectedDirectly(choice: string): Promise<string> {
  const key = await sealingKey(env.CONNECTOR_CREDENTIAL_KEY);
  const sealed = await seal('a-credential', key!);
  const answer = await storeNamed(ACCOUNT_NAME).applyChange(ACCOUNT_NAME, 'connect_source_account', {
    commandId: crypto.randomUUID(),
    issuedAt: new Date().toISOString(),
    workspaceId: WORKSPACE_ID,
    sourceAccountId: crypto.randomUUID(),
    connectorId: CHOOSES,
    externalAccountKey: 'somebody',
    displayName: 'Somebody at the source',
    ...sealed,
    choice,
  });
  expect(answer.status).toBe('ok');
  await nextCheckRuns();
  return (await listed(WORKSPACE_ID))[0]!.id;
}

const waitingOpenStates = () =>
  inTheStore((sql) => [...sql.exec<{ open_wanted: number | null }>('SELECT open_wanted FROM pulled_links')].map((row) => row.open_wanted));

async function dismissedPageOne(): Promise<void> {
  const snapshot = (await (await asUser(`http://cockpit.test/v1/workspaces/${WORKSPACE_ID}/snapshot`)).json()) as {
    items: { id: string; source: string }[];
  };
  const item = snapshot.items.find((one) => one.source.startsWith('fake-'))!;
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
}

describe('Connector management', () => {
  describe('a connection’s choice is asked before Connect and stored with the connection', () => {
    it('lists the question and options a connector declares, and that Connect asks first', async () => {
      const connectors = (
        (await (await asUser('http://cockpit.test/v1/connectors')).json()) as {
          connectors: { id: string; asksFirst: boolean; choice?: unknown }[];
        }
      ).connectors;

      expect(connectors.find((one) => one.id === CHOOSES)).toMatchObject({
        asksFirst: true,
        choice: { question: 'Bring in', options: OPTIONS },
      });
      expect(connectors.find((one) => one.id === PLAIN)).toMatchObject({ asksFirst: false });
      expect(connectors.find((one) => one.id === PLAIN)).not.toHaveProperty('choice');
    });

    it('stores the option picked after the callback, and the row says it in the connector’s words', async () => {
      const session = await signInAs(USER_ID);
      const started = await startConnecting(CHOOSES, session, 'all');

      const back = await comeBack(CHOOSES, session, started);

      expect(back.headers.get('location')).toBe(`/w/${WORKSPACE_ID}?connections=connected`);
      expect(await storedRows()).toEqual([{ connector_id: CHOOSES, choice: 'all' }]);
      expect(await listed(WORKSPACE_ID)).toMatchObject([{ follows: 'all', followsLabel: 'Every page' }]);
    });

    it.each([
      { situation: 'one that is not among the options', choice: 'nonsense' },
      { situation: 'none at all', choice: undefined },
    ])('starts nothing for $situation', async ({ choice }) => {
      const started = await startConnecting(CHOOSES, await signInAs(USER_ID), choice);

      expect(started.res.headers.get('location')).toBe(`/w/${WORKSPACE_ID}?connections=refused`);
      expect(started.attempt).toBeUndefined();
      expect(await storedRows()).toEqual([]);
    });

    it.each([
      { situation: 'a value not among the options', choice: 'nonsense' },
      { situation: 'no value at all', choice: undefined },
    ])('refuses a callback whose attempt carries $situation, and stores nothing', async ({ choice }) => {
      const session = await signInAs(USER_ID);
      const started = await startConnecting(CHOOSES, session, 'all');

      const back = await comeBack(CHOOSES, session, started, withChoice(started.attempt!, choice));

      expect(back.headers.get('location')).toBe(`/w/${WORKSPACE_ID}?connections=refused`);
      expect(await storedRows()).toEqual([]);
    });

    it('connects a connector that declares none without a choice, and carries none it is handed', async () => {
      const session = await signInAs(USER_ID);
      const started = await startConnecting(PLAIN, session, 'all');

      const back = await comeBack(PLAIN, session, started);

      expect(back.headers.get('location')).toBe(`/w/${WORKSPACE_ID}?connections=connected`);
      expect(await storedRows()).toEqual([{ connector_id: PLAIN, choice: null }]);
      expect((await listed(WORKSPACE_ID))[0]).not.toHaveProperty('follows');
    });

    it('asks again on connecting the same account again, and the answer replaces the stored one', async () => {
      const first = await connectedUnder('starred');
      const started = await startConnecting(CHOOSES, first.session, 'all');

      await comeBack(CHOOSES, first.session, started);

      expect(await storedRows()).toEqual([{ connector_id: CHOOSES, choice: 'all' }]);
    });
  });

  describe('Change… on a connection’s row changes its choice', () => {
    it('changes it to the other option, and the row says the new label', async () => {
      const { id } = await connectedUnder('starred');
      expect(await listed(WORKSPACE_ID)).toMatchObject([{ follows: 'starred', followsLabel: 'Starred pages' }]);

      const res = await choose(WORKSPACE_ID, id, 'all');

      expect(res.status).toBe(200);
      expect((await storedRows())[0]!.choice).toBe('all');
      expect(await listed(WORKSPACE_ID)).toMatchObject([{ follows: 'all', followsLabel: 'Every page' }]);
    });

    it('refuses another Workspace’s connection, and stores nothing', async () => {
      const { id } = await connectedUnder('starred');

      const res = await choose(OTHER_WORKSPACE, id, 'all');

      expect(res.status).toBe(404);
      expect((await storedRows())[0]!.choice).toBe('starred');
    });

    it('refuses a value its connector does not offer', async () => {
      const { id } = await connectedUnder('starred');

      const res = await choose(WORKSPACE_ID, id, 'nonsense');

      expect(res.status).toBe(400);
      expect((await storedRows())[0]!.choice).toBe('starred');
    });

    it('refuses a connection whose connector declares none', async () => {
      const session = await signInAs(USER_ID);
      await comeBack(PLAIN, session, await startConnecting(PLAIN, session));
      const [{ id }] = (await listed(WORKSPACE_ID)) as [Listed];

      const res = await choose(WORKSPACE_ID, id, 'all');

      expect(res.status).toBe(400);
      expect((await storedRows())[0]!.choice).toBeNull();
    });
  });

  describe('a change reaches the connector and drops what was waiting', () => {
    it('drops an open state still waiting for the source', async () => {
      const id = await connectedDirectly('starred');
      await dismissedPageOne();
      expect(await waitingOpenStates()).toEqual([0]);

      await choose(WORKSPACE_ID, id, 'all');

      expect(await waitingOpenStates()).toEqual([null]);
    });

    it('drops an open state still waiting when the account is connected again under another choice', async () => {
      const first = await connectedUnder('starred');
      await nextCheckRuns();
      await dismissedPageOne();
      expect(await waitingOpenStates()).toEqual([0]);

      const started = await startConnecting(CHOOSES, first.session, 'all');
      await comeBack(CHOOSES, first.session, started);

      expect(await waitingOpenStates()).toEqual([null]);
    });

    it('keeps what was waiting when the choice already held is chosen again', async () => {
      const id = await connectedDirectly('starred');
      await dismissedPageOne();

      await choose(WORKSPACE_ID, id, 'starred');

      expect(await waitingOpenStates()).toEqual([0]);
    });

    it('hands the connector the stored choice on each run, so it sees a change by comparing with the one it ran under', async () => {
      const id = await connectedDirectly('starred');
      expect(seen).toEqual(['starred']);

      await choose(WORKSPACE_ID, id, 'all');
      await inTheStore((sql) => sql.exec(`UPDATE pulled_connections SET due_at = ?`, new Date(Date.now() - 1000).toISOString()));
      await runDurableObjectAlarm(storeNamed(ACCOUNT_NAME));
      await nextCheckRuns();

      expect(seen).toEqual(['starred', 'all']);
    });
  });
});

/** The cookie as a hand-edited one would come back: the answer to whether it files by name replaced, or taken away. */
function withFilesByName(attempt: string, answer: unknown): string {
  const [name, value] = [attempt.slice(0, attempt.indexOf('=')), attempt.slice(attempt.indexOf('=') + 1)];
  const carried = JSON.parse(decodeURIComponent(value)) as Record<string, unknown>;
  if (answer === undefined) delete carried.filesByName;
  else carried.filesByName = answer;
  return `${name}=${encodeURIComponent(JSON.stringify(carried))}`;
}

const switches = () =>
  inTheStore((sql) => [...sql.exec<{ files_by_name: number }>('SELECT files_by_name FROM connector_accounts ORDER BY connected_at')].map((row) => row.files_by_name));

async function addPanel(name: string): Promise<string> {
  const panelId = crypto.randomUUID();
  const res = await asUser('http://cockpit.test/v1/commands/add_panel', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      commandId: crypto.randomUUID(),
      issuedAt: new Date().toISOString(),
      workspaceId: WORKSPACE_ID,
      dashboardId: DASHBOARD_ID,
      panelId,
      name,
    }),
  });
  expect(res.status).toBe(200);
  return panelId;
}

/** The Panels the Items the connection brought in are on. */
async function panelsHoldingItems(): Promise<string[]> {
  const read = (await (await asUser(`http://cockpit.test/v1/workspaces/${WORKSPACE_ID}/snapshot`)).json()) as {
    items: { id: string; source: string }[];
    filings: { panelId: string; itemId: string }[];
  };
  const brought = new Set(read.items.filter((item) => item.source.startsWith('fake-')).map((item) => item.id));
  return read.filings.filter((filing) => brought.has(filing.itemId)).map((filing) => filing.panelId);
}

describe('Connector management', () => {
  describe('whether a connection files by name is asked before Connect and stored with the connection', () => {
    it('lists that a connector reporting names asks first', async () => {
      const connectors = (
        (await (await asUser('http://cockpit.test/v1/connectors')).json()) as {
          connectors: { id: string; asksFirst: boolean }[];
        }
      ).connectors;

      expect(connectors.find((one) => one.id === NAMES)).toMatchObject({ asksFirst: true });
    });

    it.each([
      { situation: 'ticked, the connection files by name', answer: 'true', stored: [1] },
      { situation: 'unticked, it does not', answer: 'false', stored: [0] },
      // A tab opened before Connect asked it sends no answer at all.
      { situation: 'not asked at all, it does not', answer: undefined, stored: [0] },
    ])('$situation', async ({ answer, stored }) => {
      const session = await signInAs(USER_ID);
      const started = await startConnecting(NAMES, session, 'all', answer);

      const back = await comeBack(NAMES, session, started);

      expect(back.headers.get('location')).toBe(`/w/${WORKSPACE_ID}?connections=connected`);
      expect(await switches()).toEqual(stored);
    });

    it.each([
      { situation: 'ticked, its first check files what it brings in on the Panel named after the name', answer: 'true', filedOn: true },
      { situation: 'unticked, its first check leaves it in the Inbox', answer: 'false', filedOn: false },
    ])('$situation', async ({ answer, filedOn }) => {
      const panelId = await addPanel('Customer Atlas');
      const session = await signInAs(USER_ID);
      await comeBack(NAMES, session, await startConnecting(NAMES, session, 'all', answer));

      await nextCheckRuns();

      expect(await panelsHoldingItems()).toEqual(filedOn ? [panelId] : []);
    });

    it.each([
      { situation: 'one that is neither a yes nor a no', answer: 'maybe' },
      { situation: 'an empty one', answer: '' },
    ])('starts nothing for $situation', async ({ answer }) => {
      const started = await startConnecting(NAMES, await signInAs(USER_ID), 'all', answer);

      expect(started.res.headers.get('location')).toBe(`/w/${WORKSPACE_ID}?connections=refused`);
      expect(started.attempt).toBeUndefined();
      expect(await storedRows()).toEqual([]);
    });

    it.each([
      { situation: 'a value that is not a yes or no', answer: 'yes' },
      { situation: 'a number', answer: 1 },
    ])('refuses a callback whose attempt carries $situation, and stores nothing', async ({ answer }) => {
      const session = await signInAs(USER_ID);
      const started = await startConnecting(NAMES, session, 'all', 'true');

      const back = await comeBack(NAMES, session, started, withFilesByName(started.attempt!, answer));

      // An attempt that cannot be read is no attempt, sent home as any is.
      expect(back.headers.get('location')).toBe('/');
      expect(await storedRows()).toEqual([]);
    });

    it.each([
      { situation: 'on, then reconnected unticked, is off', first: 'true', again: 'false', stored: [0] },
      { situation: 'off, then reconnected ticked, is on', first: 'false', again: 'true', stored: [1] },
      // A tab opened before Connect asked it reconnects with no answer, which keeps the row's own.
      { situation: 'on, then reconnected with no answer, stays on', first: 'true', again: undefined, stored: [1] },
    ])('a connection $situation', async ({ first, again, stored }) => {
      const session = await signInAs(USER_ID);
      await comeBack(NAMES, session, await startConnecting(NAMES, session, 'all', first));

      await comeBack(NAMES, session, await startConnecting(NAMES, session, 'all', again));

      expect(await switches()).toEqual(stored);
    });

    it('carries no answer for a connector that reports no names', async () => {
      const session = await signInAs(USER_ID);

      await comeBack(PLAIN, session, await startConnecting(PLAIN, session, undefined, 'true'));

      expect(await switches()).toEqual([0]);
    });
  });
});