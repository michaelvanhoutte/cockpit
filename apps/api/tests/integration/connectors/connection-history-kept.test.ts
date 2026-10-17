import { afterEach, beforeEach, describe, expect, inject, it, vi } from 'vitest';
import { applyD1Migrations, env } from 'cloudflare:test';
import { handleScheduled } from '../../../src/jobs/index.js';
import {
  ACCOUNT_NAME,
  OTHER_ACCOUNT_NAME,
  inStoreAsItIs,
  inTheStore,
  seedRegister,
  startFromEmpty,
  storeNamed,
} from '../seed.js';

/**
 * Integration level, through the real register, every account's real store and
 * the nightly run itself: a connection's history is kept 30 days, and the
 * nightly run deletes the rest in every account ("Keep a connection's history
 * 30 days, and fold a quiet past day into one line", issue 1145). The deletion
 * is a query on real stores reached the way the nightly run reaches them, so
 * nothing below this level can hold it. How a quiet past day is drawn is the
 * history view's own F1 suite's.
 */

const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (days: number) => new Date(Date.now() - days * DAY).toISOString();

async function runTheNight(): Promise<void> {
  await handleScheduled({} as never, env);
}

/** One account's store, brought up to date first so its tables are there. */
async function inStoreOf<T>(accountName: string, work: (sql: SqlStorage) => T): Promise<T> {
  if (accountName === ACCOUNT_NAME) return inTheStore(work);
  const opened = await storeNamed(accountName).workspaces(accountName);
  if (opened.status !== 'ok') throw new Error(JSON.stringify(opened));
  return inStoreAsItIs(accountName, work);
}

/** A line of one connection's history, from `firstAt` to `lastAt`. */
async function aLine(accountName: string, id: string, firstAt: string, lastAt: string): Promise<void> {
  await inStoreOf(accountName, (sql) =>
    sql.exec(
      `INSERT INTO connection_history (id, tenant_id, source_account_id, outcome, reason, message, message_cut, count, first_at, last_at)
       VALUES (?, ?, 'a-connection', 'worked', 'scheduled', NULL, 0, 2, ?, ?)`,
      id,
      accountName,
      firstAt,
      lastAt,
    ),
  );
}

async function linesOf(accountName: string): Promise<string[]> {
  return inStoreOf(accountName, (sql) =>
    sql
      .exec<{ id: string }>('SELECT id FROM connection_history ORDER BY id')
      .toArray()
      .map((row) => row.id),
  );
}

/** Every row of every table in the account's store but the history, to show nothing else moved. */
async function everythingElseIn(accountName: string): Promise<Record<string, unknown[]>> {
  return inStoreOf(accountName, (sql) => {
    const tables = sql
      .exec<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT IN ('connection_history') AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name",
      )
      .toArray();
    return Object.fromEntries(
      tables.map(({ name }) => [name, sql.exec(`SELECT * FROM "${name.replaceAll('"', '""')}"`).toArray()]),
    );
  });
}

/** The same four lines in an account: past keeping, kept, and folded across the boundary. */
async function aMonthOfHistory(accountName: string): Promise<void> {
  await aLine(accountName, 'ended-31-days-ago', daysAgo(31.2), daysAgo(31));
  await aLine(accountName, 'ended-29-days-ago', daysAgo(29.2), daysAgo(29));
  await aLine(accountName, 'begun-31-ended-29-days-ago', daysAgo(31), daysAgo(29));
  await aLine(accountName, 'ended-today', daysAgo(0.1), daysAgo(0));
}

const KEPT = ['begun-31-ended-29-days-ago', 'ended-29-days-ago', 'ended-today'];

let complained: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  await applyD1Migrations(env.DB, inject('migrations'));
  await startFromEmpty();
  await seedRegister();
  complained = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Connector management', () => {
  describe('the nightly run deletes every account’s history lines older than 30 days, and nothing else', () => {
    it('keeps a line by when it last ran, in every account, and leaves everything else as it was', async () => {
      await aMonthOfHistory(ACCOUNT_NAME);
      await aMonthOfHistory(OTHER_ACCOUNT_NAME);
      const before = await everythingElseIn(ACCOUNT_NAME);

      await runTheNight();

      expect(await linesOf(ACCOUNT_NAME)).toEqual(KEPT);
      expect(await linesOf(OTHER_ACCOUNT_NAME)).toEqual(KEPT);
      expect(await everythingElseIn(ACCOUNT_NAME)).toEqual(before);
    });
  });

  describe('one account the nightly run cannot prune leaves the rest pruned', () => {
    it('says so, keeps that account’s lines for a later night, and prunes the account after it', async () => {
      await aMonthOfHistory(ACCOUNT_NAME);
      await aMonthOfHistory(OTHER_ACCOUNT_NAME);
      // The register lists accounts by name, so Ada's is reached first.
      expect(OTHER_ACCOUNT_NAME < ACCOUNT_NAME).toBe(true);
      await inStoreOf(OTHER_ACCOUNT_NAME, (sql) =>
        sql.exec(
          "CREATE TRIGGER refuse_to_prune BEFORE DELETE ON connection_history BEGIN SELECT RAISE(ABORT, 'arranged to fail'); END",
        ),
      );

      await runTheNight();

      expect(await linesOf(OTHER_ACCOUNT_NAME)).toEqual([...KEPT, 'ended-31-days-ago'].sort());
      expect(await linesOf(ACCOUNT_NAME)).toEqual(KEPT);
      expect((complained.mock.calls as unknown[][]).map((call) => String(call[0])).join('\n')).toContain(
        `account ${OTHER_ACCOUNT_NAME}'s connection history`,
      );
      await inStoreOf(OTHER_ACCOUNT_NAME, (sql) => sql.exec('DROP TRIGGER refuse_to_prune'));
    });
  });

  describe('a second nightly run the same night deletes nothing more', () => {
    it('leaves every line the first run kept', async () => {
      await aMonthOfHistory(ACCOUNT_NAME);
      await runTheNight();
      const afterTheFirst = await linesOf(ACCOUNT_NAME);

      await runTheNight();

      expect(afterTheFirst).toEqual(KEPT);
      expect(await linesOf(ACCOUNT_NAME)).toEqual(KEPT);
    });
  });
});
