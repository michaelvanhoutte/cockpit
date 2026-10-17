import { afterEach, beforeEach, describe, expect, inject, it } from 'vitest';
import { applyD1Migrations, env, runDurableObjectAlarm } from 'cloudflare:test';
import type { Connector, ConnectorHost, SourceItem } from '@cockpit/connector-sdk';
import type { EnrichmentJob } from '../../../src/jobs/enrichment.js';
import { handleQueue } from '../../../src/jobs/index.js';
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
 * Integration level, through the account's real store, its real alarm, the
 * Worker's real queue consumer and the app's own routes: what a connection set
 * to file by name does with the names its connector reports ("File Outlook mail
 * on the Panel named after its category", issue 1146). Which Panel a name
 * matches is filing-by-name.test.ts's (L1); here, that the switch, the names
 * recorded on each link and the filing are stored, and stored together.
 *
 * **Against a fake pulled connector that reports names**, registered in place
 * of the registry's list, whose next check does what a case scripts: Outlook's
 * own reading of categories is its package's to prove.
 */

const FAKE = 'fake-names';
const PLAIN = 'fake-plain';
const QUALIFYING = 'fake-qualifying';

const fake = {
  /** What the next check does; consumed once. */
  next: null as ((host: ConnectorHost) => Promise<void>) | null,
};

function pulledConnector(id: string, names: boolean, byDashboard = false): Connector {
  return {
    manifest: {
      id,
      displayName: 'A pulled source',
      cardText: 'A source Cockpit pulls from.',
      supportsPush: false,
      pulled: true,
      ...(names ? { names: { noun: 'category', example: 'a message with the category', ...(byDashboard ? { byDashboard } : {}) } } : {}),
      auth: { kind: 'none' },
    },
    async sync(host) {
      const script = fake.next;
      fake.next = null;
      await script?.(host);
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

async function theQueuedCheck(): Promise<EnrichmentJob> {
  for (let waited = 0; waited < 10_000; waited += 25) {
    const at = held.findIndex((job) => job.kind === 'check-a-pulled-connection');
    if (at >= 0) return held.splice(at, 1)[0]!;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('no check was ever queued');
}

/** Connects the account at the source and runs the check connecting queues, which brings in nothing. */
async function connect(connectorId = FAKE): Promise<string> {
  const key = await sealingKey(env.CONNECTOR_CREDENTIAL_KEY);
  const sealed = await seal('a-credential', key!);
  const sourceAccountId = crypto.randomUUID();
  const answer = await storeNamed(ACCOUNT_NAME).applyChange(ACCOUNT_NAME, 'connect_source_account', {
    commandId: crypto.randomUUID(),
    issuedAt: new Date().toISOString(),
    workspaceId: WORKSPACE_ID,
    sourceAccountId,
    connectorId,
    externalAccountKey: `somebody-at-${connectorId}`,
    displayName: 'somebody at the source',
    ...sealed,
  });
  expect(answer.status).toBe('ok');
  await deliver(await theQueuedCheck());
  return sourceAccountId;
}

/** The alarm firing and the check it queues delivered, doing what `script` says. */
async function nextCheck(script: (host: ConnectorHost) => Promise<void>): Promise<void> {
  fake.next = script;
  await inTheStore((sql) => sql.exec(`UPDATE pulled_connections SET due_at = '2000-01-01T00:00:00.000Z'`));
  await runDurableObjectAlarm(storeNamed(ACCOUNT_NAME));
  await deliver(await theQueuedCheck());
}

/** A message arriving, carrying these names - or, with none given, a connector saying nothing of its names. */
const arrives = (sourceId: string, names?: string[]) => (host: ConnectorHost) =>
  host
    .emitItem({
      sourceId,
      sourceLink: null,
      sender: null,
      sourceTimestamp: null,
      title: `Message ${sourceId}`,
      capturedMessage: `What message ${sourceId} says`,
      ...(names ? { names } : {}),
    } satisfies SourceItem)
    .then(() => {});

/** The names of a message already in, as the source holds them now. */
const nowNamed = (sourceId: string, names: string[]) => (host: ConnectorHost) => host.reportNames({ sourceId, names });

async function send(name: string, body: Record<string, unknown>): Promise<Response> {
  return asUser(`http://cockpit.test/v1/commands/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ commandId: crypto.randomUUID(), issuedAt: new Date().toISOString(), ...body }),
  });
}

async function filesByName(sourceAccountId: string, on: boolean): Promise<Response> {
  return send('set_connection_files_by_name', { workspaceId: WORKSPACE_ID, sourceAccountId, filesByName: on });
}

async function addPanel(name: string, where = { workspaceId: WORKSPACE_ID, dashboardId: DASHBOARD_ID }): Promise<string> {
  const panelId = crypto.randomUUID();
  const res = await send('add_panel', { ...where, panelId, name });
  expect(res.status).toBe(200);
  return panelId;
}

async function snapshot(): Promise<{
  items: { id: string; sourceId: string | null }[];
  filings: { panelId: string; itemId: string }[];
}> {
  const res = await asUser(`http://cockpit.test/v1/workspaces/${WORKSPACE_ID}/snapshot`);
  expect(res.status).toBe(200);
  return res.json();
}

/** The Item a message became, or undefined where none was made. */
async function itemOf(sourceId: string): Promise<string | undefined> {
  return (await snapshot()).items.find((item) => item.sourceId === sourceId)?.id;
}

/** The Panels the Item a message became is on - none being the Inbox. */
async function panelsOf(sourceId: string): Promise<string[]> {
  const read = await snapshot();
  const itemId = read.items.find((item) => item.sourceId === sourceId)?.id;
  expect(itemId, `no Item for ${sourceId}`).toBeDefined();
  return read.filings
    .filter((filing) => filing.itemId === itemId)
    .map((filing) => filing.panelId)
    .sort();
}

async function namesRecordedFor(sourceId: string): Promise<unknown> {
  const [row] = await inTheStore((sql) =>
    sql.exec<{ names: string | null }>('SELECT names FROM pulled_links WHERE source_id = ?', sourceId).toArray(),
  );
  return row?.names == null ? null : JSON.parse(row.names);
}

async function takeOff(sourceId: string, panelId: string): Promise<void> {
  const res = await send('remove_item_from_panel', { workspaceId: WORKSPACE_ID, itemId: await itemOf(sourceId), panelId });
  expect(res.status).toBe(200);
}

beforeEach(async () => {
  await applyD1Migrations(env.DB, inject('migrations'));
  await startFromEmpty();
  await seedRegister();
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
  env.TEST_CONNECTORS = [pulledConnector(FAKE, true), pulledConnector(PLAIN, false), pulledConnector(QUALIFYING, true, true)];
});

afterEach(async () => {
  env.ENRICHMENT = realQueue;
  delete env.TEST_CONNECTORS;
  await inTheStore((sql) => sql.exec('DROP TRIGGER IF EXISTS filing_fails'));
});

describe('Connector management', () => {
  describe('names are acted on only while the connection’s switch is on', () => {
    it.each([
      {
        situation: 'off, a message arriving with Customer Atlas stays in the Inbox, its names recorded',
        onBeforeArrival: false,
        steps: [arrives('m-1', ['Customer Atlas'])],
        onAtlas: false,
      },
      {
        situation: 'on, the same message lands on Customer Atlas and not in the Inbox',
        onBeforeArrival: true,
        steps: [arrives('m-1', ['Customer Atlas'])],
        onAtlas: true,
      },
      {
        situation: 'switched on while an Item already in carries Customer Atlas, nothing is filed at the next check',
        onBeforeArrival: false,
        steps: [arrives('m-1', ['Customer Atlas']), 'switch on', nowNamed('m-1', ['Customer Atlas'])],
        onAtlas: false,
      },
      {
        situation: 'switched on, then Customer Atlas added, it is filed at the next check',
        onBeforeArrival: false,
        steps: [arrives('m-1', []), 'switch on', nowNamed('m-1', ['Customer Atlas'])],
        onAtlas: true,
      },
    ] as const)('$situation', async ({ onBeforeArrival, steps, onAtlas }) => {
      const atlas = await addPanel('Customer Atlas');
      const connection = await connect();
      if (onBeforeArrival) expect((await filesByName(connection, true)).status).toBe(200);

      for (const step of steps) {
        if (step === 'switch on') expect((await filesByName(connection, true)).status).toBe(200);
        else await nextCheck(step);
      }

      expect(await panelsOf('m-1')).toEqual(onAtlas ? [atlas] : []);
      expect(await namesRecordedFor('m-1')).toEqual(['Customer Atlas']);
    });

    it.each([
      { situation: 'a connection whose source reports names is switched on', connectorId: FAKE, takes: true },
      { situation: 'a connection whose source reports none is refused and stays off', connectorId: PLAIN, takes: false },
    ])('$situation', async ({ connectorId, takes }) => {
      const connection = await connect(connectorId);

      const res = await filesByName(connection, true);

      expect(res.status === 200).toBe(takes);
      const rows = await asUser(`http://cockpit.test/v1/workspaces/${WORKSPACE_ID}/connections`);
      const row = ((await rows.json()) as { sourceAccounts: { id: string; filesByName: boolean }[] }).sourceAccounts.find(
        (one) => one.id === connection,
      );
      expect(row?.filesByName).toBe(takes);
    });
  });

  describe('only a name new since the last report files the Item', () => {
    it.each([
      {
        situation: 'added later while the Item is in the Inbox: filed, leaving the Inbox',
        arrivesWith: [],
        then: async () => [nowNamed('m-1', ['Customer Atlas'])],
        on: ['atlas'],
      },
      {
        situation: 'added later while it is on Admin: also on Customer Atlas, still on Admin',
        arrivesWith: ['Admin'],
        then: async () => [nowNamed('m-1', ['Admin', 'Customer Atlas'])],
        on: ['admin', 'atlas'],
      },
      {
        situation: 'the person takes it off Customer Atlas while the category stays: not filed again',
        arrivesWith: ['Customer Atlas'],
        then: async (panels: Record<string, string>) => {
          await takeOff('m-1', panels.atlas!);
          return [nowNamed('m-1', ['Customer Atlas', 'Unrelated'])];
        },
        on: [],
      },
      {
        situation: 'the category comes off: it stays filed',
        arrivesWith: ['Customer Atlas'],
        then: async () => [nowNamed('m-1', [])],
        on: ['atlas'],
      },
      {
        situation: 'the category comes off, then goes back on: filed again',
        arrivesWith: ['Customer Atlas'],
        then: async (panels: Record<string, string>) => {
          await takeOff('m-1', panels.atlas!);
          return [nowNamed('m-1', []), nowNamed('m-1', ['Customer Atlas'])];
        },
        on: ['atlas'],
      },
      {
        situation: 'the same names reported twice: filed once',
        arrivesWith: [],
        then: async () => [nowNamed('m-1', ['Customer Atlas']), nowNamed('m-1', ['Customer Atlas'])],
        on: ['atlas'],
      },
    ])('$situation', async ({ arrivesWith, then, on }) => {
      const panels: Record<string, string> = { atlas: await addPanel('Customer Atlas'), admin: await addPanel('Admin') };
      const connection = await connect();
      await filesByName(connection, true);
      await nextCheck(arrives('m-1', arrivesWith));

      for (const check of await then(panels)) await nextCheck(check);

      expect(await panelsOf('m-1')).toEqual(on.map((key) => panels[key]!).sort());
      const filedAgain = await inTheStore((sql) =>
        sql
          .exec<{ n: number }>("SELECT COUNT(*) AS n FROM commands WHERE name = 'add_item_to_panel'")
          .toArray(),
      );
      // Filing by name is the one thing here that adds an Item to a Panel after it arrives.
      expect(filedAgain[0]!.n).toBeLessThanOrEqual(1);
    });
  });

  describe('an Item from before this shipped gets a baseline from its first report and files nothing then', () => {
    it('records the first report without filing, and files on a name added after it', async () => {
      const atlas = await addPanel('Customer Atlas');
      const admin = await addPanel('Admin');
      const connection = await connect();
      await filesByName(connection, true);
      // Brought in saying nothing of its names, as every Item from before was.
      await nextCheck(arrives('m-1'));
      expect(await namesRecordedFor('m-1')).toBeNull();

      await nextCheck(nowNamed('m-1', ['Customer Atlas']));
      expect(await panelsOf('m-1')).toEqual([]);
      expect(await namesRecordedFor('m-1')).toEqual(['Customer Atlas']);

      await nextCheck(nowNamed('m-1', ['Customer Atlas', 'Admin']));
      expect(await panelsOf('m-1')).toEqual([admin]);
      expect(atlas).not.toBe(admin);
    });
  });

  describe('filing by name teaches nothing and ignores Never propose', () => {
    it.each([
      { situation: 'filed by category on arrival', neverPropose: false, later: false },
      { situation: 'filed by a category added later', neverPropose: false, later: true },
      { situation: 'filed on a Panel set to Never propose', neverPropose: true, later: false },
    ])('$situation', async ({ neverPropose, later }) => {
      const atlas = await addPanel('Customer Atlas');
      if (neverPropose) {
        expect((await send('set_panel_never_propose', { workspaceId: WORKSPACE_ID, panelId: atlas, neverPropose: true })).status).toBe(200);
      }
      const connection = await connect();
      await filesByName(connection, true);

      await nextCheck(arrives('m-1', later ? [] : ['Customer Atlas']));
      if (later) await nextCheck(nowNamed('m-1', ['Customer Atlas']));

      expect(await panelsOf('m-1')).toEqual([atlas]);
      const decisions = await inTheStore((sql) => sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM decision_history').toArray());
      expect(decisions[0]!.n).toBe(0);
    });
  });

  describe('creating and filing an Item happen together or not at all', () => {
    it('makes no Item when filing it fails, and makes and files it once at the next check', async () => {
      const atlas = await addPanel('Customer Atlas');
      const connection = await connect();
      await filesByName(connection, true);
      // A write to a Panel that fails after the Item's own row went in.
      await inTheStore((sql) =>
        sql.exec("CREATE TRIGGER filing_fails BEFORE INSERT ON panel_items BEGIN SELECT RAISE(ABORT, 'the filing failed'); END"),
      );

      await nextCheck(arrives('m-1', ['Customer Atlas']));
      expect(await itemOf('m-1')).toBeUndefined();
      await inTheStore((sql) => sql.exec('DROP TRIGGER filing_fails'));

      await nextCheck(arrives('m-1', ['Customer Atlas']));
      expect(await panelsOf('m-1')).toEqual([atlas]);
      expect((await snapshot()).items.filter((item) => item.sourceId === 'm-1')).toHaveLength(1);
    });
  });

  describe('names count only from a connector that declares it reports them', () => {
    it('records and files nothing by the names a connector declaring none sends', async () => {
      await addPanel('Customer Atlas');
      const connection = await connect(PLAIN);
      // On as no route allows for such a connection, so only the host's own guard stands.
      await inTheStore((sql) => sql.exec('UPDATE connector_accounts SET files_by_name = 1 WHERE id = ?', connection));

      await nextCheck(arrives('m-1', ['Customer Atlas']));
      await nextCheck(nowNamed('m-1', ['Customer Atlas', 'Admin']));

      expect({ panels: await panelsOf('m-1'), names: await namesRecordedFor('m-1') }).toEqual({ panels: [], names: null });
    });
  });

  describe('a Workspace never files onto another’s Panel', () => {
    it('leaves a message whose category names only another Workspace’s Panel in the Inbox', async () => {
      await alsoWorkspaces();
      await addPanel('Customer Atlas', { workspaceId: 'ws-atlas', dashboardId: 'ws-atlas-dashboard-1' });
      const connection = await connect();
      await filesByName(connection, true);

      await nextCheck(arrives('m-1', ['Customer Atlas']));

      // On no Panel of any Workspace: a snapshot of this one would not show the other's.
      const itemId = await itemOf('m-1');
      const filed = await inTheStore((sql) => sql.exec('SELECT panel_id FROM panel_items WHERE item_id = ?', itemId).toArray());
      expect(filed).toEqual([]);
    });
  });
});

interface NameSaid {
  name: string;
  panel: string | null;
  dashboard: string | null;
  why: string | null;
  dashboards: number | null;
  panels: number | null;
}
interface HistoryLine {
  count: number;
  did: { named: { count: number; messages: { id: string; title: string | null; dismissed: boolean; names: NameSaid[] }[] } };
}

async function historyOf(connection: string): Promise<HistoryLine[]> {
  const res = await asUser(`http://cockpit.test/v1/workspaces/${WORKSPACE_ID}/connections/${connection}/history`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { lines: HistoryLine[] }).lines;
}

/** What the newest line says each message's names did, by the message's title, in short. */
async function newestSaid(connection: string): Promise<Record<string, string[]>> {
  const [newest] = await historyOf(connection);
  return Object.fromEntries(
    newest!.did.named.messages.map((message) => [
      message.title,
      message.names.map((one) =>
        one.why === null ? `${one.name} -> ${one.panel}` : `${one.name}: ${one.why}${one.dashboards ? ` ${one.dashboards}` : ''}${one.panels ? ` ${one.panels}` : ''}`,
      ),
    ]),
  );
}

async function addDashboardWithPanel(name: string, panelName: string): Promise<void> {
  const dashboardId = crypto.randomUUID();
  expect((await send('add_dashboard', { workspaceId: WORKSPACE_ID, dashboardId, panelId: crypto.randomUUID(), name })).status).toBe(200);
  await addPanel(panelName, { workspaceId: WORKSPACE_ID, dashboardId });
}

const arrivesMarked = (sourceId: string, names: string[], followed: string) => (host: ConnectorHost) =>
  host
    .emitItem({
      sourceId,
      sourceLink: null,
      sender: null,
      sourceTimestamp: null,
      title: `Message ${sourceId}`,
      capturedMessage: `What message ${sourceId} says`,
      names,
      followed,
    } satisfies SourceItem)
    .then(() => {});

describe('Connector management', () => {
  describe('a check’s line names each name it read, and whether it filed or why it skipped (issue 1197)', () => {
    it.each([
      {
        situation: 'a message arriving with a name one Panel carries is filed on it',
        panels: ['Tasks'],
        on: true,
        steps: [arrives('m-1', ['Tasks'])],
        says: { 'Message m-1': ['Tasks -> Tasks'] },
      },
      {
        situation: 'a name Panels on three Dashboards carry is skipped',
        panels: ['Tasks', 'Tasks@Privé', 'Tasks@Werk'],
        on: true,
        steps: [arrives('m-1', ['Tasks'])],
        says: { 'Message m-1': ['Tasks: several 3'] },
      },
      {
        situation: 'a name no Panel carries is skipped',
        panels: ['Tasks'],
        on: true,
        steps: [arrives('m-1', ['Red category'])],
        says: { 'Message m-1': ['Red category: no-panel'] },
      },
      {
        situation: 'every name is skipped while filing by name is off',
        panels: ['Tasks'],
        on: false,
        steps: [arrives('m-1', ['Tasks', 'Red category'])],
        says: { 'Message m-1': ['Tasks: off', 'Red category: off'] },
      },
      {
        situation: 'the followed mark comes first, and is skipped',
        panels: ['Tasks'],
        on: true,
        steps: [arrivesMarked('m-1', ['Tasks'], 'Cockpit')],
        says: { 'Message m-1': ['Cockpit: followed', 'Tasks -> Tasks'] },
      },
      {
        situation: 'a message with nothing but the followed mark adds nothing',
        panels: ['Tasks'],
        on: true,
        steps: [arrivesMarked('m-1', [], 'Cockpit')],
        says: {},
      },
      {
        situation: 'a message already in when filing was ticked, its names first reported, is skipped as already there',
        panels: ['Tasks'],
        on: false,
        steps: [arrives('m-1'), 'switch on', nowNamed('m-1', ['Tasks'])],
        says: { 'Message m-1': ['Tasks: baseline'] },
      },
      {
        situation: 'a message already in with a name added since says only the added name',
        panels: ['Tasks'],
        on: true,
        steps: [arrives('m-1', ['Red category']), nowNamed('m-1', ['Red category', 'Tasks'])],
        says: { 'Message m-1': ['Tasks -> Tasks'] },
      },
      {
        situation: 'a message already in whose names are unchanged adds nothing',
        panels: ['Tasks'],
        on: true,
        steps: [arrives('m-1', ['Tasks']), nowNamed('m-1', ['tasks'])],
        says: {},
      },
    ] as const)('$situation', async ({ panels, on, steps, says }) => {
      for (const panel of panels) {
        const [name, dashboard] = panel.split('@');
        if (dashboard) await addDashboardWithPanel(dashboard, name!);
        else await addPanel(name!);
      }
      const connection = await connect();
      if (on) expect((await filesByName(connection, true)).status).toBe(200);

      for (const step of steps) {
        if (step === 'switch on') expect((await filesByName(connection, true)).status).toBe(200);
        else await nextCheck(step);
      }

      expect(await newestSaid(connection)).toEqual(says);
    });

    it('names the Panel and the Dashboard it filed on', async () => {
      await addDashboardWithPanel('Privé', 'Tasks');
      const connection = await connect();
      await filesByName(connection, true);

      await nextCheck(arrives('m-1', ['Tasks']));

      const [newest] = await historyOf(connection);
      expect(newest!.did.named.messages[0]!.names).toEqual([
        { name: 'Tasks', panel: 'Tasks', dashboard: 'Privé', why: null, dashboards: null, panels: null },
      ]);
    });

    it('is a line of its own between quiet ones, and never folded into them', async () => {
      await addPanel('Tasks');
      const connection = await connect();
      await filesByName(connection, true);
      await nextCheck(arrives('m-1', []));
      await nextCheck(async () => {});
      await nextCheck(nowNamed('m-1', ['Tasks']));
      await nextCheck(async () => {});
      await nextCheck(async () => {});

      const lines = await historyOf(connection);

      expect(lines.map((line) => [line.count, line.did.named.count])).toEqual([
        [2, 0],
        [1, 1],
        // The quiet check before it, the message brought in, and the check connecting.
        [1, 0],
        [1, 0],
        [1, 0],
      ]);
    });

    it('names the first 50 messages and counts every one beyond', async () => {
      const connection = await connect();
      const ids = Array.from({ length: 51 }, (_, i) => `m-${i}`);
      await nextCheck(async (host) => {
        for (const id of ids) await arrives(id, ['Red category'])(host);
      });

      const [newest] = await historyOf(connection);

      expect(newest!.did.named.count).toBe(51);
      expect(newest!.did.named.messages).toHaveLength(50);
    });

    it('a check that read no names has no names part', async () => {
      const connection = await connect();
      await nextCheck(arrives('m-1'));

      const [newest] = await historyOf(connection);

      expect(newest!.did.named).toEqual({ count: 0, messages: [] });
    });
  });
});

describe('Connector management', () => {
  describe('a name may qualify a Panel by its Dashboard only for a connector whose manifest declares it (issue 1198)', () => {
    it.each([
      { situation: 'a connector that declares it files Cubico-Tasks on Tasks of Cubico', connector: QUALIFYING, filed: true },
      { situation: 'a connector that does not files nothing by Cubico-Tasks', connector: FAKE, filed: false },
    ])('$situation', async ({ connector, filed }) => {
      await addDashboardWithPanel('Cubico', 'Tasks');
      await addDashboardWithPanel('Privé', 'Tasks');
      const connection = await connect(connector);
      await filesByName(connection, true);

      await nextCheck(arrives('m-1', ['Cubico-Tasks']));

      expect(await panelsOf('m-1')).toHaveLength(filed ? 1 : 0);
      expect(await newestSaid(connection)).toEqual({
        'Message m-1': [filed ? 'Cubico-Tasks -> Tasks' : 'Cubico-Tasks: no-panel'],
      });
    });

    it('files on a Panel called Cubico-Tasks as before, for a connector that does not declare it', async () => {
      await addDashboardWithPanel('Cubico', 'Tasks');
      const called = await addPanel('Cubico-Tasks');
      const connection = await connect(FAKE);
      await filesByName(connection, true);

      await nextCheck(arrives('m-1', ['Cubico-Tasks']));

      expect(await panelsOf('m-1')).toEqual([called]);
    });

    it('files nothing and says how many Panels a name read as when it reads as two', async () => {
      await addDashboardWithPanel('Privé', 'Tasks');
      await addDashboardWithPanel('Home', 'Prive-Tasks');
      const connection = await connect(QUALIFYING);
      await filesByName(connection, true);

      await nextCheck(arrives('m-1', ['prive-tasks']));

      expect(await panelsOf('m-1')).toEqual([]);
      expect(await newestSaid(connection)).toEqual({ 'Message m-1': ['prive-tasks: pairs 2'] });
    });
  });
});
