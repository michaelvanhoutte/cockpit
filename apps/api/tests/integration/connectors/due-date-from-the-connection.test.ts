import { afterEach, beforeEach, describe, expect, inject, it, vi } from 'vitest';
import { SELF, applyD1Migrations, env, runDurableObjectAlarm } from 'cloudflare:test';
import type { Connector, ConnectorHost, SourceItem } from '@cockpit/connector-sdk';
import type { EnrichmentJob } from '../../../src/jobs/enrichment.js';
import { handleQueue } from '../../../src/jobs/index.js';
import { seal, sealingKey } from '../../../src/connectors/credential-crypto.js';
import {
  ACCOUNT_NAME,
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
import { A_READING, batchOf, captureANote, nextId, postChange, theModelIs } from '../http/note-cleanup.support.js';

/**
 * Integration level, through the account's real store, its real alarm, the
 * Worker's real queue consumer and the app's own routes: a connection that
 * gives each Item it brings in a due date a set number of days after the day it
 * arrives ("Give each email a Gmail or Outlook connection brings in a due date a
 * set number of days out", issue 1409). The arithmetic of the day is
 * tests/unit/domain/due-in-days.test.ts (L1); here, that the date is written in
 * the transaction that makes the Item, is never taken for yours, is replaced or
 * moved only while it is still the connection's, and that the setting is asked
 * for, stored and refused the way a connection's other answers are.
 *
 * **Against fake pulled connectors**, registered in place of the registry's
 * list, whose next check does what a case scripts: Gmail's and Outlook's own
 * reading of their sources is their packages' to prove. The model is faked at
 * the network boundary, as the issuer is.
 */

const PULLED = 'fake-pulled';
const PUSHED = 'fake-pushed';
const OTHER_WORKSPACE = 'ws-atlas';

const settings = env as unknown as Record<string, string | undefined>;

const fake = {
  /** What the next check does; consumed once. */
  next: null as ((host: ConnectorHost) => Promise<void>) | null,
};

function connectorNamed(id: string, pulled: boolean): Connector {
  return {
    manifest: {
      id,
      displayName: pulled ? 'A pulled source' : 'A pushed source',
      cardText: 'A source.',
      supportsPush: !pulled,
      ...(pulled ? { pulled: true, mirrorsOpenState: true } : {}),
      auth: {
        kind: 'oauth2',
        endpoints: { authorizationUrl: `${ISSUER}/authorize`, tokenUrl: `${ISSUER}/token` },
        scopes: ['read'],
        clientSettings: { id: 'FAKE_SOURCE_CLIENT_ID', secret: 'FAKE_SOURCE_CLIENT_SECRET' },
      },
    },
    async sync(host: ConnectorHost) {
      const script = fake.next;
      fake.next = null;
      await script?.(host);
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
  env.TEST_CONNECTORS = [connectorNamed(PULLED, true), connectorNamed(PUSHED, false)];
  settings.FAKE_SOURCE_CLIENT_ID = 'the-fake-source-client';
  settings.FAKE_SOURCE_CLIENT_SECRET = 'the-fake-source-secret';
});

afterEach(() => {
  env.ENRICHMENT = realQueue;
  env.ANTHROPIC_API_KEY = '';
  delete env.TEST_CONNECTORS;
  delete settings.FAKE_SOURCE_CLIENT_ID;
  delete settings.FAKE_SOURCE_CLIENT_SECRET;
  issuerIsForgotten();
  vi.unstubAllGlobals();
});

async function deliver(body: EnrichmentJob): Promise<void> {
  await handleQueue(batchOf(body), env);
}

async function theQueuedCheck(): Promise<EnrichmentJob> {
  for (let waited = 0; waited < 10_000; waited += 25) {
    const at = held.findIndex((job) => job.kind === 'check-a-pulled-connection');
    if (at >= 0) return held.splice(at, 1)[0]!;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('no check was ever queued');
}

/** Connects the account at the source - giving each Item `days` after it arrives, or none - and runs the check connecting queues, which brings in nothing. */
async function connect(dueInDays?: number | null, connectorId = PULLED, workspaceId = WORKSPACE_ID): Promise<string> {
  const key = await sealingKey(env.CONNECTOR_CREDENTIAL_KEY);
  const sealed = await seal('a-credential', key!);
  const sourceAccountId = crypto.randomUUID();
  const answer = await storeNamed(ACCOUNT_NAME).applyChange(ACCOUNT_NAME, 'connect_source_account', {
    commandId: crypto.randomUUID(),
    issuedAt: new Date().toISOString(),
    workspaceId,
    sourceAccountId,
    connectorId,
    externalAccountKey: `somebody-at-${connectorId}-in-${workspaceId}`,
    displayName: 'somebody at the source',
    ...sealed,
    ...(dueInDays === undefined ? {} : { dueInDays }),
  });
  expect(answer.status).toBe('ok');
  if (connectorId === PULLED) await deliver(await theQueuedCheck());
  return sourceAccountId;
}

/** The alarm firing and the check it queues delivered, doing what `script` says. */
async function nextCheck(script: (host: ConnectorHost) => Promise<void>): Promise<void> {
  fake.next = script;
  await inTheStore((sql) => sql.exec(`UPDATE pulled_connections SET due_at = '2000-01-01T00:00:00.000Z'`));
  await runDurableObjectAlarm(storeNamed(ACCOUNT_NAME));
  await deliver(await theQueuedCheck());
}

const aMessage = (sourceId: string): SourceItem => ({
  sourceId,
  sourceLink: null,
  sender: null,
  sourceTimestamp: null,
  title: `Message ${sourceId}`,
  capturedMessage: `What message ${sourceId} says`,
});

/** A message arriving. */
const arrives = (sourceId: string) => (host: ConnectorHost) => host.emitItem(aMessage(sourceId)).then(() => {});

/** The mark coming off, and going back on, as the source reports it. */
const markCameOff = (sourceId: string) => (host: ConnectorHost) =>
  host.emitSourceStateChange({ sourceId, change: 'resolved', observedAt: new Date().toISOString() });
const markWentBackOn = (sourceId: string, observedAt: string) => (host: ConnectorHost) =>
  host.emitSourceStateChange({ sourceId, change: 'reopened', observedAt });

async function send(name: string, body: Record<string, unknown>, commandId: string = crypto.randomUUID()): Promise<Response> {
  return asUser(`http://cockpit.test/v1/commands/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ commandId, issuedAt: new Date().toISOString(), ...body }),
  });
}

const givesDays = (sourceAccountId: string, dueInDays: unknown, workspaceId = WORKSPACE_ID, commandId?: string) =>
  send('set_connection_due_in_days', { workspaceId, sourceAccountId, dueInDays }, commandId);

interface DateRow {
  due_date: string | null;
  due_date_set_at: string | null;
  due_date_chosen_at: string | null;
  given_due_date: string | null;
  item_id: string;
}

/** What an Item brought in from a message holds of its date, and what its link says the connection gave. */
async function dateOf(sourceId: string): Promise<DateRow> {
  const [row] = await inTheStore((sql) =>
    sql
      .exec<DateRow & Record<string, string | null>>(
        `SELECT i.due_date, i.due_date_set_at, i.due_date_chosen_at, l.given_due_date, l.item_id
           FROM pulled_links l JOIN items i ON i.id = l.item_id WHERE l.source_id = ?`,
        sourceId,
      )
      .toArray(),
  );
  if (!row) throw new Error(`no Item was made for ${sourceId}`);
  return row;
}

/** The day `days` after the one the clock is on, at `offsetHours` from UTC - the arithmetic the case does without the code under test. */
const dayAfter = (days: number, at: number, offsetHours = 0) =>
  new Date(at + offsetHours * 3_600_000 + days * 86_400_000).toISOString().slice(0, 10);

/** Runs `work`, and answers every day it could have been counted from - the clock may cross midnight UTC while it runs. */
async function daysThatCouldBe(days: number, offsetHours: number, work: () => Promise<void>): Promise<string[]> {
  const before = Date.now();
  await work();
  return [...new Set([dayAfter(days, before, offsetHours), dayAfter(days, Date.now(), offsetHours)])];
}

describe('Connector management', () => {
  describe('a connection that gives a due date gives every Item it brings in one, written when the Item is made and not taken for yours', () => {
    it.each([
      { situation: 'giving 3 days', days: 3 as number | null, gives: true },
      { situation: 'giving 365 days', days: 365 as number | null, gives: true },
      { situation: 'giving none', days: null, gives: false },
    ])('a marked message arriving on a connection $situation', async ({ days, gives }) => {
      await connect(days);

      const possible = await daysThatCouldBe(days ?? 0, 0, () => nextCheck(arrives('m-1')));

      const stored = await dateOf('m-1');
      if (gives) {
        expect(possible).toContain(stored.due_date);
        // The ramp colours along from when it arrived, and the date is the connection's, not yours.
        expect(stored.due_date_set_at).not.toBeNull();
        expect(stored.due_date_chosen_at).toBeNull();
        expect(stored.given_due_date).toBe(stored.due_date);
      } else {
        expect(stored).toMatchObject({ due_date: null, due_date_set_at: null, due_date_chosen_at: null, given_due_date: null });
      }
    });

    it('counts the day it arrives on the calendar of the account’s latest capture, not on UTC’s', async () => {
      // A zone a day apart from UTC right now: ahead of it from 10:00 UTC, behind it before.
      const ahead = new Date().getUTCHours() >= 10;
      const [zone, offset] = ahead ? ['Pacific/Kiritimati', 14] : ['Etc/GMT+12', -12];
      await captureANote({ timeZone: zone });
      await connect(3);

      const possible = await daysThatCouldBe(3, offset, () => nextCheck(arrives('m-1')));

      expect(possible).toContain((await dateOf('m-1')).due_date);
      expect(possible).not.toContain(dayAfter(3, Date.now(), 0));
    });

    it('counts a message the source dated long ago from the day it arrives here', async () => {
      await connect(3);

      const possible = await daysThatCouldBe(3, 0, () =>
        nextCheck((host) => host.emitItem({ ...aMessage('m-1'), sourceTimestamp: '2025-01-02T09:00:00.000Z' }).then(() => {})),
      );

      expect(possible).toContain((await dateOf('m-1')).due_date);
    });
  });

  describe('turning it on, or changing the days, counts from that moment', () => {
    it('leaves an Item already in with no date when it is turned on afterwards, and gives the next to arrive one', async () => {
      const connection = await connect();
      await nextCheck(arrives('before'));

      expect((await givesDays(connection, 3)).status).toBe(200);
      await nextCheck(arrives('after'));

      expect((await dateOf('before')).due_date).toBeNull();
      expect((await dateOf('after')).due_date).not.toBeNull();
    });

    it('keeps the dates already given when the days change from 3 to 7, and gives the next to arrive 7', async () => {
      const connection = await connect(3);
      await nextCheck(arrives('three'));
      const given = (await dateOf('three')).due_date;

      expect((await givesDays(connection, 7)).status).toBe(200);
      const possible = await daysThatCouldBe(7, 0, () => nextCheck(arrives('seven')));

      expect((await dateOf('three')).due_date).toBe(given);
      expect(possible).toContain((await dateOf('seven')).due_date);
    });

    it('keeps the dates already given when it is turned off, and gives the next to arrive none', async () => {
      const connection = await connect(3);
      await nextCheck(arrives('three'));
      const given = (await dateOf('three')).due_date;

      expect((await givesDays(connection, null)).status).toBe(200);
      await nextCheck(arrives('none'));

      expect((await dateOf('three')).due_date).toBe(given);
      expect((await dateOf('none')).due_date).toBeNull();
    });
  });

  describe('a date the connection gave is not yours: the reading replaces it with a date the message names, and never replaces yours', () => {
    const NAMED = '2031-05-09';

    /** A capture to give the account a calendar, the model on the network, and a connection giving 3 days. */
    async function readyToRead(): Promise<string> {
      env.ANTHROPIC_API_KEY = 'a-key-that-proves-nothing-here';
      await signInAs();
      theModelIs({ says: A_READING });
      await captureANote({ timeZone: 'Europe/Brussels' });
      return connect(3);
    }

    /** The clean-up queued for the Item a message became, delivered with the model saying `says`. */
    async function readWith(sourceId: string, says: Record<string, unknown>): Promise<void> {
      theModelIs({ says: { ...A_READING, ...says } });
      const { item_id: itemId } = await dateOf(sourceId);
      const job = held.find((one) => one.kind === 'clean-up-a-note' && one.itemId === itemId);
      expect(job, 'no clean-up was queued for the Item').toBeDefined();
      await deliver(job!);
    }

    it('replaces the connection’s date with the day the message names, which is then not the connection’s', async () => {
      await readyToRead();
      await nextCheck(arrives('m-1'));
      const before = await dateOf('m-1');
      expect(before.due_date).not.toBeNull();

      await readWith('m-1', { dueDate: NAMED });

      expect(await dateOf('m-1')).toMatchObject({ due_date: NAMED, due_date_chosen_at: null, given_due_date: before.due_date });
    });

    it('leaves the connection’s date where the message names no day', async () => {
      await readyToRead();
      await nextCheck(arrives('m-1'));
      const before = await dateOf('m-1');

      await readWith('m-1', {});

      expect(await dateOf('m-1')).toMatchObject({ due_date: before.due_date, given_due_date: before.due_date });
    });

    it('replaces it though you have edited the title and set the priority, so the date is all the reading has left to set', async () => {
      await readyToRead();
      await nextCheck(arrives('m-1'));
      const { item_id: itemId } = await dateOf('m-1');
      const issuedAt = new Date(Date.now() + 1000).toISOString();
      const aChange = { commandId: nextId(), issuedAt, workspaceId: WORKSPACE_ID, itemId };
      expect((await postChange('set_title', { ...aChange, title: 'My own title' })).status).toBe(200);
      expect((await postChange('set_priority', { ...aChange, commandId: nextId(), priority: 'low' })).status).toBe(200);

      await readWith('m-1', { dueDate: NAMED });

      expect((await dateOf('m-1')).due_date).toBe(NAMED);
    });

    it.each([
      { situation: 'set', change: (itemId: string) => ({ itemId, dueDate: '2031-01-01' }), stays: '2031-01-01' },
      { situation: 'cleared', change: (itemId: string) => ({ itemId, dueDate: null }), stays: null },
    ])('leaves a date you $situation before the reading lands', async ({ change, stays }) => {
      await readyToRead();
      await nextCheck(arrives('m-1'));
      const { item_id: itemId } = await dateOf('m-1');
      const changed = await postChange('set_due_date', {
        commandId: nextId(),
        issuedAt: new Date(Date.now() + 1000).toISOString(),
        workspaceId: WORKSPACE_ID,
        ...change(itemId),
      });
      expect(changed.status).toBe(200);

      await readWith('m-1', { dueDate: NAMED });

      expect((await dateOf('m-1')).due_date).toBe(stays);
    });
  });

  describe('reopening gives a fresh date only while the date is still the connection’s', () => {
    // Far enough ahead to be after the check that brought the Item in, so the day it reopens is the one named.
    const REOPENED_ON = '2031-12-10T09:00:00.000Z';

    /** Brings a message in, then has the source take its mark off and put it back on that day. */
    async function closedAndReopened(sourceId = 'm-1'): Promise<void> {
      await nextCheck(markCameOff(sourceId));
      await nextCheck(markWentBackOn(sourceId, REOPENED_ON));
    }

    it('gives the day it reopened plus the connection’s days, and records it as the connection’s', async () => {
      await connect(3);
      await nextCheck(arrives('m-1'));

      await closedAndReopened();

      expect(await dateOf('m-1')).toMatchObject({ due_date: '2031-12-13', given_due_date: '2031-12-13', due_date_chosen_at: null });
    });

    it('counts the days the connection gives by then, not the ones it gave when the message arrived', async () => {
      const connection = await connect(3);
      await nextCheck(arrives('m-1'));
      expect((await givesDays(connection, 7)).status).toBe(200);

      await closedAndReopened();

      expect((await dateOf('m-1')).due_date).toBe('2031-12-17');
    });

    it('counts from the day it reopened though a device running fast put the Item’s own clock days ahead', async () => {
      await connect(3);
      await nextCheck(arrives('m-1'));
      await nextCheck(markCameOff('m-1'));
      const { item_id: itemId } = await dateOf('m-1');
      await inTheStore((sql) => sql.exec(`UPDATE items SET updated_at = '2031-12-20T09:00:00.000Z' WHERE id = ?`, itemId));

      await nextCheck(markWentBackOn('m-1', REOPENED_ON));

      expect(await dateOf('m-1')).toMatchObject({ due_date: '2031-12-13', given_due_date: '2031-12-13' });
    });

    it('lets open tabs hear of it, as of any change the source makes', async () => {
      await connect(3);
      await nextCheck(arrives('m-1'));
      const { item_id: itemId } = await dateOf('m-1');

      await closedAndReopened();

      const logged = await inTheStore((sql) =>
        sql
          .exec<{ name: string }>("SELECT name FROM commands WHERE payload LIKE ? ORDER BY received_at", `%${itemId}%`)
          .toArray()
          .map((row) => row.name),
      );
      expect(logged).toContain('set_due_date');
    });

    it.each([
      {
        situation: 'you set a date',
        meanwhile: (itemId: string) => postChange('set_due_date', { commandId: nextId(), issuedAt: new Date(Date.now() + 1000).toISOString(), workspaceId: WORKSPACE_ID, itemId, dueDate: '2031-01-01' }),
        stays: '2031-01-01',
      },
      {
        situation: 'you cleared the date',
        meanwhile: (itemId: string) => postChange('set_due_date', { commandId: nextId(), issuedAt: new Date(Date.now() + 1000).toISOString(), workspaceId: WORKSPACE_ID, itemId, dueDate: null }),
        stays: null,
      },
    ])('leaves it alone where $situation', async ({ meanwhile, stays }) => {
      await connect(3);
      await nextCheck(arrives('m-1'));
      expect((await meanwhile((await dateOf('m-1')).item_id)).status).toBe(200);

      await closedAndReopened();

      expect((await dateOf('m-1')).due_date).toBe(stays);
    });

    it('leaves it alone where a reading replaced it', async () => {
      env.ANTHROPIC_API_KEY = 'a-key-that-proves-nothing-here';
      await signInAs();
      theModelIs({ says: A_READING });
      await captureANote({ timeZone: 'Europe/Brussels' });
      await connect(3);
      await nextCheck(arrives('m-1'));
      const { item_id: itemId } = await dateOf('m-1');
      theModelIs({ says: { ...A_READING, dueDate: '2031-05-09' } });
      await deliver(held.find((one) => one.kind === 'clean-up-a-note' && one.itemId === itemId)!);
      expect((await dateOf('m-1')).due_date).toBe('2031-05-09');

      await closedAndReopened();

      expect((await dateOf('m-1')).due_date).toBe('2031-05-09');
    });

    it('leaves the old date where the connection gives none by then', async () => {
      const connection = await connect(3);
      await nextCheck(arrives('m-1'));
      const before = (await dateOf('m-1')).due_date;
      expect((await givesDays(connection, null)).status).toBe(200);

      await closedAndReopened();

      expect(await dateOf('m-1')).toMatchObject({ due_date: before, given_due_date: before });
    });

    it('gives an Item that arrived before the connection gave dates none now', async () => {
      const connection = await connect();
      await nextCheck(arrives('m-1'));
      expect((await givesDays(connection, 3)).status).toBe(200);

      await closedAndReopened();

      expect((await dateOf('m-1')).due_date).toBeNull();
    });
  });

  describe('the days are asked before Connect and stored with the connection', () => {
    const storedDays = () =>
      inTheStore((sql) =>
        [...sql.exec<{ due_in_days: number | null }>('SELECT due_in_days FROM connector_accounts ORDER BY connected_at')].map(
          (row) => row.due_in_days,
        ),
      );

    /** Pressing Connect once the window has asked: what the browser is sent to, and what it is left holding. */
    async function startConnecting(connectorId: string, session: string, dueInDays?: string) {
      const query = dueInDays === undefined ? '' : `?${new URLSearchParams({ dueInDays })}`;
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
      issuerWillIdentify({ email: 'nobody@example.com', nonce: started.asked!.searchParams.get('nonce')! }, 'a-code', { access_token: 'ada' });
      return SELF.fetch(
        `http://cockpit.test/v1/connections/${connectorId}/callback?${new URLSearchParams({
          code: 'a-code',
          state: started.asked!.searchParams.get('state')!,
        })}`,
        { redirect: 'manual', headers: { cookie: `${session}; ${attempt}` } },
      );
    }

    /** The cookie as a hand-edited one would come back: the days replaced. */
    function withDays(attempt: string, answer: unknown): string {
      const [name, value] = [attempt.slice(0, attempt.indexOf('=')), attempt.slice(attempt.indexOf('=') + 1)];
      const carried = JSON.parse(decodeURIComponent(value)) as Record<string, unknown>;
      carried.dueInDays = answer;
      return `${name}=${encodeURIComponent(JSON.stringify(carried))}`;
    }

    it('lists a pulled connector as asking first, and one that is not pulled as not', async () => {
      const listed = ((await (await asUser('http://cockpit.test/v1/connectors')).json()) as {
        connectors: { id: string; asksFirst: boolean; pulled?: boolean }[];
      }).connectors;

      expect(listed.find((one) => one.id === PULLED)).toMatchObject({ asksFirst: true, pulled: true });
      expect(listed.find((one) => one.id === PUSHED)).toMatchObject({ asksFirst: false });
      expect(listed.find((one) => one.id === PUSHED)?.pulled).toBeUndefined();
    });

    it.each([
      { situation: 'with 3 days, stores 3', asked: '3', stored: [3] },
      { situation: 'with 365 days, stores 365', asked: '365', stored: [365] },
      { situation: 'with none, stores none', asked: 'none', stored: [null] },
      // A tab opened before Connect asked it sends no answer at all.
      { situation: 'with no answer, stores none', asked: undefined, stored: [null] },
    ])('Connect $situation', async ({ asked, stored }) => {
      const session = await signInAs(USER_ID);
      const started = await startConnecting(PULLED, session, asked);

      const back = await comeBack(PULLED, session, started);

      expect(back.headers.get('location')).toBe(`/w/${WORKSPACE_ID}?connections=connected`);
      expect(await storedDays()).toEqual(stored);
    });

    it.each([
      { situation: '0', asked: '0' },
      { situation: '366', asked: '366' },
      { situation: 'a part of a day', asked: '1.5' },
      { situation: 'a negative number', asked: '-3' },
      { situation: 'words', asked: 'three' },
      { situation: 'nothing', asked: '' },
    ])('Connect with $situation starts nothing', async ({ asked }) => {
      const started = await startConnecting(PULLED, await signInAs(USER_ID), asked);

      expect(started.res.headers.get('location')).toBe(`/w/${WORKSPACE_ID}?connections=refused`);
      expect(started.attempt).toBeUndefined();
      expect(await storedDays()).toEqual([]);
    });

    it.each([
      { situation: '0', answer: 0 },
      { situation: '366', answer: 366 },
      { situation: 'a part of a day', answer: 1.5 },
      { situation: 'words', answer: 'three' },
    ])('refuses a callback whose attempt carries $situation, and stores nothing', async ({ answer }) => {
      const session = await signInAs(USER_ID);
      const started = await startConnecting(PULLED, session, '3');

      const back = await comeBack(PULLED, session, started, withDays(started.attempt!, answer));

      // An attempt that cannot be read is no attempt, sent home as any is.
      expect(back.headers.get('location')).toBe('/');
      expect(await storedDays()).toEqual([]);
    });

    it.each([
      { situation: 'on, then reconnected unticked, is none', first: '3', again: 'none', stored: [null] },
      { situation: 'none, then reconnected ticked at 5, is 5', first: 'none', again: '5', stored: [5] },
      // A tab opened before Connect asked it reconnects with no answer, which keeps the row's own.
      { situation: 'on, then reconnected with no answer, stays on', first: '3', again: undefined, stored: [3] },
    ])('a connection $situation', async ({ first, again, stored }) => {
      const session = await signInAs(USER_ID);
      await comeBack(PULLED, session, await startConnecting(PULLED, session, first));

      await comeBack(PULLED, session, await startConnecting(PULLED, session, again));

      expect(await storedDays()).toEqual(stored);
    });

    it('carries no answer for a connector that is not pulled', async () => {
      const session = await signInAs(USER_ID);

      await comeBack(PUSHED, session, await startConnecting(PUSHED, session, '3'));

      expect(await storedDays()).toEqual([null]);
    });
  });

  describe('Change… sets the days on a pulled connection and refuses anything else', () => {
    it('stores the days, and none again', async () => {
      const connection = await connect();

      expect((await givesDays(connection, 3)).status).toBe(200);
      const listed = async () =>
        ((await (await asUser(`http://cockpit.test/v1/workspaces/${WORKSPACE_ID}/connections`)).json()) as {
          sourceAccounts: { id: string; dueInDays: number | null }[];
        }).sourceAccounts.find((one) => one.id === connection)?.dueInDays;
      expect(await listed()).toBe(3);

      expect((await givesDays(connection, null)).status).toBe(200);
      expect(await listed()).toBeNull();
    });

    it.each([
      { situation: '0', days: 0 },
      { situation: '366', days: 366 },
      { situation: 'a part of a day', days: 1.5 },
      { situation: 'words', days: 'three' },
      { situation: 'no answer', days: undefined },
    ])('refuses $situation days, and stores nothing', async ({ days }) => {
      const connection = await connect(3);

      const res = await givesDays(connection, days);

      expect(res.status).toBe(400);
      expect(await inTheStore((sql) => [...sql.exec<{ due_in_days: number }>('SELECT due_in_days FROM connector_accounts')].map((row) => row.due_in_days))).toEqual([3]);
    });

    it('refuses a connection whose connector is not pulled, and stores nothing', async () => {
      const connection = await connect(undefined, PUSHED);

      const res = await givesDays(connection, 3);

      expect(res.status).toBe(400);
      expect(await inTheStore((sql) => [...sql.exec<{ due_in_days: number | null }>('SELECT due_in_days FROM connector_accounts')].map((row) => row.due_in_days))).toEqual([null]);
    });

    it('refuses another Workspace’s connection, and stores nothing', async () => {
      const connection = await connect(undefined, PULLED, OTHER_WORKSPACE);

      const res = await givesDays(connection, 3);

      expect(res.status).toBe(404);
      expect(await inTheStore((sql) => [...sql.exec<{ due_in_days: number | null }>('SELECT due_in_days FROM connector_accounts')].map((row) => row.due_in_days))).toEqual([null]);
    });

    it('refuses a connection that is not there', async () => {
      expect((await givesDays('nothing-here', 3)).status).toBe(404);
    });

    it('applies the same change sent twice once', async () => {
      const connection = await connect();
      const commandId = crypto.randomUUID();

      const first = await givesDays(connection, 3, WORKSPACE_ID, commandId);
      const again = await givesDays(connection, 3, WORKSPACE_ID, commandId);

      expect(await first.json()).toMatchObject({ applied: true });
      expect(await again.json()).toMatchObject({ applied: false });
      const logged = await inTheStore((sql) =>
        sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM commands WHERE name = 'set_connection_due_in_days'").one(),
      );
      expect(logged.n).toBe(1);
    });
  });
});
