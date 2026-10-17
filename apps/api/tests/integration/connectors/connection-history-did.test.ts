import { afterEach, beforeEach, describe, expect, inject, it } from 'vitest';
import { applyD1Migrations, env, runDurableObjectAlarm } from 'cloudflare:test';
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
 * Integration level, through the account's real store, its real alarm, the
 * Worker's real queue consumer and the history's real route: what a check
 * brought in, closed and sent back is counted from the calls its connector
 * makes through the host, written with the check's own end, and each Item
 * named by its title when the history is read ("Say what each check of a
 * connection brought in, closed and sent back", issue 1141).
 *
 * **Against a fake pulled connector that mirrors open state**, as
 * pulled-open-state.test.ts has it, so each case scripts what a check does.
 * Whether a check that did something folds is
 * tests/unit/domain/connection-history.test.ts's.
 */

const FAKE = 'fake-did';

const fake = {
  scripts: [] as ((host: ConnectorHost) => Promise<void>)[],
  runs: 0,
  confirms: (wanted: OpenStateWanted[]): string[] => wanted.map((one) => one.sourceId),
  givesUp: (_wanted: OpenStateWanted[]): string[] => [],
};

const fakeMirroring: Connector = {
  manifest: {
    id: FAKE,
    displayName: 'A pulled source',
    cardText: 'A source Cockpit pulls from.',
    supportsPush: false,
    pulled: true,
    mirrorsOpenState: true,
    auth: { kind: 'none' },
  },
  async sync(host) {
    fake.runs += 1;
    await fake.scripts[Math.min(fake.runs, fake.scripts.length) - 1]?.(host);
  },
  async mirrorOpenState(_host, wanted) {
    return { confirmed: fake.confirms(wanted), gaveUp: fake.givesUp(wanted) };
  },
};

function runsIn(...scripts: ((host: ConnectorHost) => Promise<void>)[]): void {
  fake.scripts = scripts;
}

let held: EnrichmentJob[] = [];
let realQueue: typeof env.ENRICHMENT;

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

async function connect(): Promise<string> {
  const key = await sealingKey(env.CONNECTOR_CREDENTIAL_KEY);
  const sourceAccountId = crypto.randomUUID();
  const answer = await storeNamed(ACCOUNT_NAME).applyChange(ACCOUNT_NAME, 'connect_source_account', {
    commandId: crypto.randomUUID(),
    issuedAt: new Date().toISOString(),
    workspaceId: WORKSPACE_ID,
    sourceAccountId,
    connectorId: FAKE,
    externalAccountKey: 'somebody',
    displayName: 'somebody at the source',
    ...(await seal('a-credential', key!)),
  });
  expect(answer.status).toBe('ok');
  return sourceAccountId;
}

/** Waits for the check connecting or a change queued, and delivers it. */
async function queuedCheckRuns(): Promise<void> {
  for (let waited = 0; waited < 10_000; waited += 25) {
    if (held.some((job) => job.kind === 'check-a-pulled-connection')) {
      for (const check of takeQueuedChecks()) await deliver(check);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('no check was ever queued');
}

async function nextCheckRuns(): Promise<void> {
  await runDurableObjectAlarm(storeNamed(ACCOUNT_NAME));
  for (const check of takeQueuedChecks()) await deliver(check);
}

interface Kind {
  count: number;
  items: { id: string; title: string | null }[];
}
interface Line {
  outcome: string;
  count: number;
  listed: number | null;
  did: { broughtIn: Kind; closed: Kind; sentBack: Kind; refused: Kind };
}

async function linesOf(sourceAccountId: string): Promise<Line[]> {
  const res = await asUser(
    `http://cockpit.test/v1/workspaces/${WORKSPACE_ID}/connections/${sourceAccountId}/history`,
  );
  expect(res.status).toBe(200);
  return ((await res.json()) as { lines: Line[] }).lines;
}

const titles = (kind: Kind) => kind.items.map((item) => item.title);
const counts = (line: Line) => ({
  broughtIn: line.did.broughtIn.count,
  closed: line.did.closed.count,
  sentBack: line.did.sentBack.count,
  refused: line.did.refused.count,
});

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

function bringsIn(...sourceIds: string[]): (host: ConnectorHost) => Promise<void> {
  return async (host) => {
    for (const sourceId of sourceIds) await host.emitItem(aPage(sourceId));
  };
}

async function itemIdFor(sourceId: string): Promise<string> {
  const res = await asUser(`http://cockpit.test/v1/workspaces/${WORKSPACE_ID}/snapshot`);
  const found = ((await res.json()) as { items: { id: string; sourceId: string | null }[] }).items.find(
    (item) => item.sourceId === sourceId,
  );
  return found!.id;
}

async function changeItem(name: 'set_done' | 'set_title', itemId: string, rest: object): Promise<void> {
  const res = await asUser(`http://cockpit.test/v1/commands/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      commandId: crypto.randomUUID(),
      issuedAt: new Date().toISOString(),
      workspaceId: WORKSPACE_ID,
      itemId,
      ...rest,
    }),
  });
  expect(res.status).toBe(200);
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
  fake.runs = 0;
  fake.confirms = (wanted) => wanted.map((one) => one.sourceId);
  fake.givesUp = () => [];
  runsIn(async () => {});
  env.TEST_CONNECTORS = [fakeMirroring];
});

afterEach(() => {
  env.ENRICHMENT = realQueue;
  delete env.TEST_CONNECTORS;
});

describe('Connector management', () => {
  describe('a check’s line counts and records each Item the host filed, closed, sent back or gave up on', () => {
    it('two new Items brought in are counted and named, and the same two read again are not', async () => {
      runsIn(bringsIn('a', 'b'), bringsIn('a', 'b'));
      const id = await connect();
      await queuedCheckRuns();
      await nextCheckRuns();

      const lines = await linesOf(id);
      // The second check did nothing, so it is a quiet line of its own after the first.
      expect(lines.map(counts)).toEqual([
        { broughtIn: 0, closed: 0, sentBack: 0, refused: 0 },
        { broughtIn: 2, closed: 0, sentBack: 0, refused: 0 },
      ]);
      expect(titles(lines[1]!.did.broughtIn).sort()).toEqual(['Page a', 'Page b']);
    });

    it('an Item the complete listing no longer sees is counted as closed', async () => {
      runsIn(
        async (host) => {
          await host.emitItem({ ...aPage('c'), choice: 'label' });
          await host.reportCompleteListing({ choice: 'label', sourceIds: ['c'] });
        },
        (host) => host.reportCompleteListing({ choice: 'label', sourceIds: [] }),
      );
      const id = await connect();
      await queuedCheckRuns();
      await nextCheckRuns();

      const lines = await linesOf(id);
      expect(lines.map(counts)).toEqual([
        { broughtIn: 0, closed: 1, sentBack: 0, refused: 0 },
        { broughtIn: 1, closed: 0, sentBack: 0, refused: 0 },
      ]);
      expect(titles(lines[0]!.did.closed)).toEqual(['Page c']);
    });

    it('an Item the source reports resolved is counted as closed, and one it reopens is not', async () => {
      runsIn(bringsIn('a', 'b'), async (host) => {
        const observedAt = new Date().toISOString();
        await host.emitSourceStateChange({ sourceId: 'a', change: 'resolved', observedAt });
        await host.emitSourceStateChange({ sourceId: 'b', change: 'reopened', observedAt });
      });
      const id = await connect();
      await queuedCheckRuns();
      await nextCheckRuns();

      const [line] = await linesOf(id);
      expect(counts(line!)).toEqual({ broughtIn: 0, closed: 1, sentBack: 0, refused: 0 });
      expect(titles(line!.did.closed)).toEqual(['Page a']);
    });

    it('a change the source holds is counted as sent back, and one it refused for good as refused', async () => {
      runsIn(bringsIn('a', 'b'));
      const id = await connect();
      await queuedCheckRuns();
      await changeItem('set_done', await itemIdFor('a'), { done: true });
      await changeItem('set_done', await itemIdFor('b'), { done: true });
      fake.givesUp = () => ['b'];
      fake.confirms = () => ['a'];

      await queuedCheckRuns();

      const [line] = await linesOf(id);
      expect(counts(line!)).toEqual({ broughtIn: 0, closed: 0, sentBack: 1, refused: 1 });
      expect(titles(line!.did.sentBack)).toEqual(['Page a']);
      expect(titles(line!.did.refused)).toEqual(['Page b']);
    });

    it('two Items filed and then a failure is a Failed line still counting both', async () => {
      runsIn(async (host) => {
        await bringsIn('a', 'b')(host);
        throw new Error('the source stopped answering');
      });
      const id = await connect();
      await queuedCheckRuns();

      const [line] = await linesOf(id);
      expect(line).toMatchObject({ outcome: 'failed' });
      expect(counts(line!).broughtIn).toBe(2);
    });
  });

  describe('a check that did anything is never folded, and never extended', () => {
    it('keeps a line for the check that brought something in, between quiet lines', async () => {
      runsIn(bringsIn(), bringsIn(), bringsIn('a'), bringsIn('a'), bringsIn('a'));
      const id = await connect();
      await queuedCheckRuns();
      await nextCheckRuns();
      await nextCheckRuns();
      await nextCheckRuns();
      await nextCheckRuns();

      const lines = await linesOf(id);
      expect(lines.map((line) => [line.count, line.did.broughtIn.count])).toEqual([
        [2, 0],
        [1, 1],
        [2, 0],
      ]);
    });
  });

  describe('Items on a line are named by their title now', () => {
    it('names an Item by its new title once retitled', async () => {
      runsIn(bringsIn('a'));
      const id = await connect();
      await queuedCheckRuns();
      await changeItem('set_title', await itemIdFor('a'), { title: 'Renamed since' });

      expect(titles((await linesOf(id))[0]!.did.broughtIn)).toEqual(['Renamed since']);
    });

    it('names a dismissed Item by its title, marked dismissed, and leaves out one of another Workspace', async () => {
      runsIn(bringsIn('a', 'b'));
      const id = await connect();
      await queuedCheckRuns();
      const dismissed = await itemIdFor('a');
      const elsewhere = await itemIdFor('b');
      await inTheStore((sql) => {
        sql.exec('UPDATE items SET deleted_at = ? WHERE id = ?', new Date().toISOString(), dismissed);
        sql.exec('UPDATE items SET workspace_id = ? WHERE id = ?', 'ws-atlas', elsewhere);
      });

      const [line] = (await linesOf(id)).slice(0, 1);
      expect(line!.did.broughtIn.count).toBe(2);
      expect(line!.did.broughtIn.items).toEqual([{ id: dismissed, title: expect.any(String), dismissed: true }]);
    });

    it('reads a title null for an id with no row, and a live Item as not dismissed', async () => {
      runsIn(bringsIn('a', 'b'));
      const id = await connect();
      await queuedCheckRuns();
      const missing = await itemIdFor('a');
      const live = await itemIdFor('b');
      await inTheStore((sql) => {
        sql.exec('PRAGMA foreign_keys = OFF');
        sql.exec('DELETE FROM items WHERE id = ?', missing);
      });

      const [line] = (await linesOf(id)).slice(0, 1);
      const byId = new Map(line!.did.broughtIn.items.map((item) => [item.id, item]));
      expect(byId.get(missing)).toEqual({ id: missing, title: null, dismissed: false });
      expect(byId.get(live)).toEqual({ id: live, title: expect.any(String), dismissed: false });
    });
  });
});

describe('Connector management', () => {
  describe('a check’s line says how many messages its complete listing returned', () => {
    const lists = (...sourceIds: string[]) => (host: ConnectorHost) =>
      host.reportCompleteListing({ choice: 'flag', sourceIds });
    const listed = async (id: string) => (await linesOf(id)).map((line) => line.listed);

    it.each([
      { situation: 'a listing of two, nothing brought in', script: lists('a', 'b'), listed: 2, broughtIn: 0 },
      { situation: 'a listing of none', script: lists(), listed: 0, broughtIn: 0 },
      {
        situation: 'a check that brought one in, listing three',
        script: async (host: ConnectorHost) => {
          await host.emitItem(aPage('a'));
          await lists('a', 'b', 'c')(host);
        },
        listed: 3,
        broughtIn: 1,
      },
      { situation: 'a listing that stopped between pages, so none was reported', script: bringsIn(), listed: null, broughtIn: 0 },
      {
        situation: 'a listing followed by a failure',
        script: async (host: ConnectorHost) => {
          await lists('a', 'b')(host);
          throw new Error('the source stopped answering');
        },
        listed: null,
        broughtIn: 0,
      },
    ])('$situation', async ({ script, listed: expected, broughtIn }) => {
      runsIn(script);
      const id = await connect();
      await queuedCheckRuns();

      const [line] = await linesOf(id);
      expect(line!.listed).toBe(expected);
      expect(line!.did.broughtIn.count).toBe(broughtIn);
    });

    it('quiet checks in a row fold into one line showing the newest count', async () => {
      runsIn(lists('a', 'b'), lists('a', 'b', 'c'));
      const id = await connect();
      await queuedCheckRuns();
      await nextCheckRuns();

      const lines = await linesOf(id);
      expect(lines.map((line) => line.count)).toEqual([2]);
      expect(await listed(id)).toEqual([3]);
    });

    it('a Check now after a quiet check is a line of its own with its own count', async () => {
      runsIn(lists('a', 'b'), lists('a'));
      const id = await connect();
      await queuedCheckRuns();
      const pressed = await asUser(
        `http://cockpit.test/v1/workspaces/${WORKSPACE_ID}/connections/${id}/check-now`,
        { method: 'POST' },
      );
      expect(pressed.status).toBe(200);
      await queuedCheckRuns();

      const lines = await linesOf(id);
      expect(lines.map((line) => [line.count, line.listed])).toEqual([
        [1, 1],
        [1, 2],
      ]);
    });
  });
});
