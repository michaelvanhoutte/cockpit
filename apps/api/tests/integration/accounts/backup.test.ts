import { beforeEach, describe, expect, inject, it } from 'vitest';
import { SELF, applyD1Migrations, env } from 'cloudflare:test';
import { accountChanges } from '../../../src/accounts/changes.js';
import {
  ACCOUNT_NAME,
  OTHER_ACCOUNT_NAME,
  OTHER_USER_ID,
  USER_ID,
  asUser,
  inStoreAsItIs,
  seedRegister,
  startFromEmpty,
} from '../seed.js';

/**
 * Integration level throughout, and the reason is the same for every rule
 * below: a backup is made of what a real register and a real store actually
 * hold. Nothing under the HTTP entry point can prove that the rows in the file
 * are the rows in the store, which is the entire claim.
 *
 * The one thing deliberately asked elsewhere is whether a request carries the
 * operator's secret: that is a decision about two strings, it is asked at
 * tests/unit/auth/admin.test.ts, and the case that matters most there - an
 * environment where no secret was ever set - cannot be expressed here at all,
 * because these bindings always carry one. What is left for this file is
 * whether the gate is actually in front of the routes, which is the half that
 * could be wrong however right the decision is.
 */

const SECRET = 'test-operator-secret';
const AT = '2026-09-01T10:00:00.000Z';

let seq = 0;
function nextId(): string {
  seq += 1;
  return `018f0000-0000-7000-8000-${String(seq).padStart(12, '0')}`;
}

interface AccountFile {
  account: string;
  changesApplied: string[];
  tables: Record<string, Record<string, unknown>[]>;
}

interface RegisterFile {
  tenants: Record<string, unknown>[];
  users: Record<string, unknown>[];
  accounts: string[];
}

function asOperator(path: string, secret: string | null = SECRET): Promise<Response> {
  return SELF.fetch(`http://cockpit.test${path}`, {
    headers: secret === null ? {} : { authorization: `Bearer ${secret}` },
  });
}

async function backUpRegister(): Promise<RegisterFile> {
  const res = await asOperator('/v1/admin/backup/register');
  expect(res.status).toBe(200);
  return (await res.json()) as RegisterFile;
}

async function backUp(accountName: string): Promise<AccountFile> {
  const res = await asOperator(`/v1/admin/backup/accounts/${accountName}`);
  expect(res.status).toBe(200);
  return (await res.json()) as AccountFile;
}

/** Opens an account the way a person does, which is what creates its store. */
async function useAccount(userId: string): Promise<void> {
  const res = await asUser('http://cockpit.test/v1/workspaces', {}, userId);
  expect(res.status).toBe(200);
}

/** Puts something in an account that nothing else would have put there. */
async function captureInto(userId: string, message: string): Promise<void> {
  const workspaces = await asUser('http://cockpit.test/v1/workspaces', {}, userId);
  const { workspaces: list } = (await workspaces.json()) as { workspaces: { id: string }[] };
  const res = await asUser(
    'http://cockpit.test/v1/commands/capture_item',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        commandId: nextId(),
        issuedAt: AT,
        itemId: nextId(),
        workspaceId: list[0]!.id,
        message,
      }),
    },
    userId,
  );
  expect(res.status).toBe(200);
}

beforeEach(async () => {
  await applyD1Migrations(env.DB, inject('migrations'));
  await startFromEmpty();
  await seedRegister();
});

describe('Backup', () => {
  describe('a backup holds every account in the register, or just the one asked for by name', () => {
    it('names every registered account', async () => {
      expect((await backUpRegister()).accounts).toEqual([ACCOUNT_NAME, OTHER_ACCOUNT_NAME].sort());
    });

    it('holds only the account asked for', async () => {
      await useAccount(USER_ID);
      await captureInto(USER_ID, 'mine');

      expect((await backUp(ACCOUNT_NAME)).account).toBe(ACCOUNT_NAME);
    });

    it('refuses a name that is not in the register, and reads nothing', async () => {
      const res = await asOperator('/v1/admin/backup/accounts/nobody');

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'no account nobody' });
    });

    /**
     * A real state rather than an error: an account is in the register from the
     * moment it is added, and its store is not created until somebody first
     * opens it. A backup taken in between holds an account with nothing in it.
     */
    it('holds an account nobody has ever opened, and it is empty', async () => {
      const file = await backUp(ACCOUNT_NAME);

      expect(file.tables).toEqual({});
      expect(file.changesApplied).toEqual([]);
    });
  });

  describe('a backup holds what an environment can be rebuilt from, and nothing that would bring a sign-in back', () => {
    it('holds the accounts and the people who own them', async () => {
      const { tenants, users } = await backUpRegister();

      expect(tenants.map((row) => row.id)).toEqual([ACCOUNT_NAME, OTHER_ACCOUNT_NAME].sort());
      expect(users.map((row) => row.id)).toEqual([USER_ID, OTHER_USER_ID].sort());
    });

    /**
     * The address and the Google identity are in the backup without this file
     * or the one that writes it naming them ("Record the Google account each
     * user signs in with", issue 195) - which is the point of taking whatever
     * columns the register has rather than a list somebody has to remember.
     */
    it('holds what a person signs in by, whatever the register has come to carry', async () => {
      const { users } = await backUpRegister();

      expect(users[0]).toHaveProperty('email');
      expect(users[0]).toHaveProperty('google_subject');
    });

    it('holds no sign-ins, even while somebody is signed in', async () => {
      await useAccount(USER_ID);

      const file = (await backUpRegister()) as unknown as Record<string, unknown>;
      expect(Object.keys(file)).toEqual(expect.not.arrayContaining(['sessions']));
      expect(await env.DB.prepare('SELECT count(*) AS n FROM sessions').first<{ n: number }>()).toEqual(
        { n: 1 },
      );
    });

    it('holds every table the account has, the change log included', async () => {
      await useAccount(USER_ID);
      await captureInto(USER_ID, 'something worth keeping');

      const { tables } = await backUp(ACCOUNT_NAME);
      expect(Object.keys(tables)).toEqual(
        expect.arrayContaining(['workspaces', 'items', 'commands', 'item_types']),
      );
      expect(tables.items!.map((row) => row.captured_message)).toContain(
        'something worth keeping',
      );
      expect(tables.commands!.length).toBeGreaterThan(0);
    });

    it('records which changes the account had applied', async () => {
      await useAccount(USER_ID);

      expect((await backUp(ACCOUNT_NAME)).changesApplied).toEqual(
        accountChanges(ACCOUNT_NAME).map((change) => change.name),
      );
    });

    /**
     * The store's own ledger of what it has run is recorded as `changesApplied`
     * and is not one of the account's tables, so that restoring a backup writes
     * the account's data and decides for itself what it has applied.
     */
    it('keeps the record of applied changes out of the tables', async () => {
      await useAccount(USER_ID);

      expect(Object.keys((await backUp(ACCOUNT_NAME)).tables)).not.toContain('account_changes');
    });
  });

  describe('a backup says whose every row is', () => {
    it('carries the account’s name on every row', async () => {
      await useAccount(USER_ID);
      await captureInto(USER_ID, 'mine');

      const { tables } = await backUp(ACCOUNT_NAME);
      const rows = Object.values(tables).flat();
      expect(rows.length).toBeGreaterThan(0);
      expect([...new Set(rows.map((row) => row.tenant_id))]).toEqual([ACCOUNT_NAME]);
    });

    /**
     * `tenant_id` is the second lock, and a lock nothing ever tries is one
     * nobody would notice had broken. Nothing reachable through the application
     * can put a foreign row in a store, so it is written directly - the same
     * exception the database constraints test takes, and for the same reason.
     */
    it('refuses to write out a store holding somebody else’s row, and says which', async () => {
      await useAccount(USER_ID);
      // One of the account's own workspaces, re-stamped as somebody else's.
      // Turning a row that is already there is what keeps this case about the
      // lock rather than about knowing every column of a table it does not
      // otherwise care about.
      await inStoreAsItIs(ACCOUNT_NAME, (sql) => {
        sql.exec(
          `UPDATE workspaces SET tenant_id = ?
             WHERE id = (SELECT id FROM workspaces ORDER BY id LIMIT 1)`,
          OTHER_ACCOUNT_NAME,
        );
      });

      const res = await asOperator(`/v1/admin/backup/accounts/${ACCOUNT_NAME}`);
      expect(res.status).toBe(409);
      const { error } = (await res.json()) as { error: string };
      expect(error).toContain('workspaces');
      expect(error).toContain(OTHER_ACCOUNT_NAME);
    });
  });

  describe('taking a backup changes nothing', () => {
    /**
     * The rule that shapes the whole feature. Every other way into a store
     * applies the outstanding changes first, so a backup of every account would
     * migrate every account - the riskiest write there is, on all of them, at a
     * moment nobody chose.
     */
    it('leaves an account behind on changes exactly as behind as it was', async () => {
      const changes = accountChanges(ACCOUNT_NAME);
      await inStoreAsItIs(ACCOUNT_NAME, (sql) => {
        sql.exec(
          `CREATE TABLE IF NOT EXISTS account_changes (
             name text PRIMARY KEY NOT NULL,
             applied_at text NOT NULL
           ) STRICT`,
        );
        for (const change of changes.slice(0, 1)) {
          for (const statement of change.statements) {
            sql.exec(statement.sql, ...(statement.params ?? []));
          }
          sql.exec('INSERT INTO account_changes (name, applied_at) VALUES (?, ?)', change.name, AT);
        }
      });

      expect((await backUp(ACCOUNT_NAME)).changesApplied).toEqual([changes[0]!.name]);

      const stillApplied = await inStoreAsItIs(ACCOUNT_NAME, (sql) =>
        sql.exec<{ name: string }>('SELECT name FROM account_changes').toArray().map((r) => r.name),
      );
      expect(stillApplied).toEqual([changes[0]!.name]);
    });

    it('leaves a store nobody has opened still unopened', async () => {
      await backUp(ACCOUNT_NAME);

      const tables = await inStoreAsItIs(ACCOUNT_NAME, (sql) =>
        sql
          .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
          .toArray()
          .map((row) => row.name),
      );
      expect(tables).toEqual([]);
    });

    it('writes nothing to the register', async () => {
      await useAccount(USER_ID);
      const before = await env.DB.prepare('SELECT * FROM users ORDER BY id').all();

      await backUpRegister();
      await backUp(ACCOUNT_NAME);

      expect((await env.DB.prepare('SELECT * FROM users ORDER BY id').all()).results).toEqual(
        before.results,
      );
    });
  });

  /**
   * **"A backup is one moment, not a smear" has no test here, deliberately.**
   * The scoped rule was that a change landing while an account is read is
   * wholly in the backup or wholly absent. It holds by construction: a Durable
   * Object handles one request at a time, and the read is synchronous from the
   * first table to the last, so there is no point at which another change could
   * be applied. Which means nothing can produce the condition - a test would
   * pass whether or not the property held, and a test that cannot fail is not a
   * test.
   *
   * What keeps it true is the absence of an `await` inside
   * `readStoreAsItStands`, and paging across requests is what would end it.
   * That is written where somebody would break it (src/accounts/backup.ts)
   * rather than asserted here.
   */

  describe('backing up is refused to anyone without the operator’s secret', () => {
    it.each([
      { situation: 'the register', path: '/v1/admin/backup/register' },
      { situation: 'an account', path: `/v1/admin/backup/accounts/${ACCOUNT_NAME}` },
    ])('$situation is refused when nothing is offered', async ({ path }) => {
      const res = await asOperator(path, null);

      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'not allowed' });
    });

    it('is refused when the secret is wrong', async () => {
      expect((await asOperator('/v1/admin/backup/register', 'not-it')).status).toBe(401);
    });

    /**
     * The half a unit test cannot reach: that the gate is mounted in front of
     * these routes at all. Signing in is deliberately no help here - the
     * operator's routes are outside that gate - so this also pins that a
     * session is not an alternative way in.
     */
    it('is refused to somebody merely signed in', async () => {
      const res = await asUser('http://cockpit.test/v1/admin/backup/register', {}, USER_ID);

      expect(res.status).toBe(401);
    });
  });
});
