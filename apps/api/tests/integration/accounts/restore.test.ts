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
 * Integration level throughout, for the reason the whole feature has: what a
 * restore does is put rows into a real store, and nothing below the HTTP entry
 * point can prove that what came back is what went in.
 *
 * The two things asked elsewhere are the two that are decisions rather than
 * writes: which register rows collide (`tests/unit/accounts/register-restore.test.ts`,
 * where three uniqueness rules branch and no register is needed to say so), and
 * what the command refuses before it starts (`scripts/lib/restore.test.mjs`).
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

function asOperator(path: string, init: RequestInit = {}): Promise<Response> {
  return SELF.fetch(`http://cockpit.test${path}`, {
    ...init,
    headers: {
      ...((init.headers as Record<string, string>) ?? {}),
      authorization: `Bearer ${SECRET}`,
    },
  });
}

async function backUp(accountName: string): Promise<AccountFile> {
  const res = await asOperator(`/v1/admin/backup/accounts/${accountName}`);
  expect(res.status).toBe(200);
  return (await res.json()) as AccountFile;
}

function restore(
  accountName: string,
  backup: unknown,
  { force = false } = {},
): Promise<Response> {
  return asOperator(
    `/v1/admin/restore/accounts/${accountName}${force ? '?force=true' : ''}`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(backup) },
  );
}

/** Opens an account the way a person does, which is what creates its store. */
async function useAccount(userId: string): Promise<{ id: string }[]> {
  const res = await asUser('http://cockpit.test/v1/workspaces', {}, userId);
  expect(res.status).toBe(200);
  return ((await res.json()) as { workspaces: { id: string }[] }).workspaces;
}

async function captureInto(userId: string, message: string): Promise<void> {
  const workspaces = await useAccount(userId);
  const res = await asUser(
    'http://cockpit.test/v1/commands/capture_item',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        commandId: nextId(),
        issuedAt: AT,
        itemId: nextId(),
        workspaceId: workspaces[0]!.id,
        message,
      }),
    },
    userId,
  );
  expect(res.status).toBe(200);
}

/** Puts a store back to never-having-been-opened. */
async function emptyTheStore(name: string): Promise<void> {
  await inStoreAsItIs(name, (sql) => {
    const tables = sql
      .exec<{ name: string }>(
        `SELECT name FROM sqlite_master WHERE type = 'table'
           AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_%' ESCAPE '\\'`,
      )
      .toArray()
      .map((row) => row.name);
    // Children before parents, the same order a restore drops in.
    for (const table of ['panel_placements', 'panel_items', 'associations', 'commands', 'items', 'layouts', 'panels', 'dashboards', 'item_types', 'workspaces', 'account_changes']) {
      if (tables.includes(table)) sql.exec(`DROP TABLE IF EXISTS "${table}"`);
    }
    for (const table of tables) sql.exec(`DROP TABLE IF EXISTS "${table}"`);
  });
}

function messagesIn(file: AccountFile): unknown[] {
  return (file.tables.items ?? []).map((row) => row.captured_message);
}

beforeEach(async () => {
  await applyD1Migrations(env.DB, inject('migrations'));
  await startFromEmpty();
  await seedRegister();
});

describe('Backup', () => {
  describe('restoring makes an account exactly what the backup holds', () => {
    it('puts back everything that was taken, into a store with nothing in it', async () => {
      await captureInto(USER_ID, 'worth keeping');
      const taken = await backUp(ACCOUNT_NAME);
      await emptyTheStore(ACCOUNT_NAME);

      const res = await restore(ACCOUNT_NAME, taken);
      expect(res.status).toBe(200);

      const now = await backUp(ACCOUNT_NAME);
      expect(now.tables).toEqual(taken.tables);
      expect(now.changesApplied.sort()).toEqual(taken.changesApplied.sort());
    });

    it('leaves nothing of what was there, when asked to replace it', async () => {
      await captureInto(USER_ID, 'the one in the backup');
      const taken = await backUp(ACCOUNT_NAME);
      await captureInto(USER_ID, 'captured after the backup');

      expect((await restore(ACCOUNT_NAME, taken, { force: true })).status).toBe(200);

      const now = await backUp(ACCOUNT_NAME);
      expect(messagesIn(now)).toContain('the one in the backup');
      expect(messagesIn(now)).not.toContain('captured after the backup');
    });

    it('puts back the change log with everything else', async () => {
      await captureInto(USER_ID, 'something');
      const taken = await backUp(ACCOUNT_NAME);
      await emptyTheStore(ACCOUNT_NAME);
      await restore(ACCOUNT_NAME, taken);

      const now = await backUp(ACCOUNT_NAME);
      expect(now.tables.commands!.length).toBe(taken.tables.commands!.length);
      expect(now.tables.commands!.length).toBeGreaterThan(0);
    });

    /**
     * A row of a dozen columns fits six to a statement, so an account with
     * ordinary use in it already crosses the boundary several times over. The
     * count is asserted rather than assumed because the failure is silent: a
     * write that stops at the batch size leaves a store that looks restored.
     */
    it('puts back more rows than one statement can carry', async () => {
      for (let n = 0; n < 12; n += 1) await captureInto(USER_ID, `item ${n}`);
      const taken = await backUp(ACCOUNT_NAME);
      expect(taken.tables.items!.length).toBeGreaterThan(10);
      await emptyTheStore(ACCOUNT_NAME);

      expect((await restore(ACCOUNT_NAME, taken)).status).toBe(200);
      expect((await backUp(ACCOUNT_NAME)).tables.items!.length).toBe(taken.tables.items!.length);
    });
  });

  describe('restoring is refused where it would mix two states', () => {
    it('refuses an account that already holds data, and changes nothing', async () => {
      await captureInto(USER_ID, 'already here');
      const taken = await backUp(ACCOUNT_NAME);

      const res = await restore(ACCOUNT_NAME, taken);

      expect(res.status).toBe(409);
      expect(messagesIn(await backUp(ACCOUNT_NAME))).toContain('already here');
    });

    it('refuses a backup naming a change this version does not have', async () => {
      await captureInto(USER_ID, 'already here');
      const taken = await backUp(ACCOUNT_NAME);
      const fromTheFuture = { ...taken, changesApplied: [...taken.changesApplied, '9999-not-yet'] };

      const res = await restore(ACCOUNT_NAME, fromTheFuture, { force: true });

      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain('9999-not-yet');
      expect(messagesIn(await backUp(ACCOUNT_NAME))).toContain('already here');
    });

    /**
     * The lock turned on the way in. A backup is a file, so what arrives here
     * has been on somebody's disk: without this, one account's file poured into
     * another's store writes rows carrying a name that store's own queries never
     * match, leaving an account that reads as empty while holding somebody
     * else's data.
     */
    it('refuses a backup belonging to another account, and changes nothing', async () => {
      await captureInto(USER_ID, 'mine');
      await captureInto(OTHER_USER_ID, 'hers');
      const hers = await backUp(OTHER_ACCOUNT_NAME);

      const res = await restore(ACCOUNT_NAME, hers, { force: true });

      expect(res.status).toBe(400);
      const { error } = (await res.json()) as { error: string };
      expect(error).toContain(OTHER_ACCOUNT_NAME);
      expect(messagesIn(await backUp(ACCOUNT_NAME))).toContain('mine');
    });
  });

  describe('an account behind the current version is brought up to date once it is restored', () => {
    /**
     * The half the whole design rests on. A backup records the shape its rows
     * were in, a restore replays exactly that shape, and the account then takes
     * the ordinary path every account takes after a deploy. The machinery is
     * the same one the deploy gate practises on
     * (tests/integration/accounts/aged-store.test.ts).
     */
    it('reaches the current shape with the backup’s rows still in it', async () => {
      await captureInto(USER_ID, 'written under an older shape');
      const taken = await backUp(ACCOUNT_NAME);
      const everything = accountChanges(ACCOUNT_NAME).map((change) => change.name);
      // A backup taken before the last two changes existed.
      const older = { ...taken, changesApplied: everything.slice(0, -2) };
      await emptyTheStore(ACCOUNT_NAME);

      expect((await restore(ACCOUNT_NAME, older)).status).toBe(200);

      const now = await backUp(ACCOUNT_NAME);
      expect(now.changesApplied.sort()).toEqual([...everything].sort());
      expect(messagesIn(now)).toContain('written under an older shape');
    });
  });

  describe('a restored user can sign in', () => {
    it('creates the register rows a restored account needs', async () => {
      await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(OTHER_USER_ID).run();
      await env.DB.prepare('DELETE FROM tenants WHERE id = ?').bind(OTHER_ACCOUNT_NAME).run();

      const res = await asOperator('/v1/admin/restore/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          tenants: [{ id: OTHER_ACCOUNT_NAME, name: 'Ada', created_at: AT }],
          users: [
            {
              id: OTHER_USER_ID,
              name: 'Ada',
              account_id: OTHER_ACCOUNT_NAME,
              role: 'user',
              email: 'ada@example.com',
              google_subject: null,
              created_at: AT,
            },
          ],
        }),
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ accountsCreated: 1, usersCreated: 1 });
      // The point of the whole thing: they can sign in and reach their account.
      expect((await useAccount(OTHER_USER_ID)).length).toBeGreaterThan(0);
    });

    it.each([
      {
        situation: 'a user already here owning a different account',
        user: { id: USER_ID, name: 'Michael', account_id: 'somewhere-else', role: 'admin', email: 'new@example.com', google_subject: null, created_at: AT },
        says: 'owning',
      },
      {
        situation: 'an address already here under another name',
        user: { id: 'user-someone-else', name: 'Someone', account_id: ACCOUNT_NAME, role: 'user', email: 'michael@example.com', google_subject: null, created_at: AT },
        says: 'address',
      },
    ])('refuses $situation, and writes nothing', async ({ user, says }) => {
      const before = await env.DB.prepare('SELECT * FROM users ORDER BY id').all();

      const res = await asOperator('/v1/admin/restore/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tenants: [], users: [user] }),
      });

      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toContain(says);
      expect((await env.DB.prepare('SELECT * FROM users ORDER BY id').all()).results).toEqual(
        before.results,
      );
    });
  });

  describe('restoring is refused to anyone without the operator’s secret', () => {
    it.each([
      { situation: 'an account', path: `/v1/admin/restore/accounts/${ACCOUNT_NAME}` },
      { situation: 'the register', path: '/v1/admin/restore/register' },
    ])('putting back $situation needs the secret', async ({ path }) => {
      const res = await SELF.fetch(`http://cockpit.test${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });

      expect(res.status).toBe(401);
    });

    // The same hole the backup routes were opened by once: the router decodes a
    // path before matching, so a gate reading the raw one sees a different
    // string. Asked again here because these routes *write*.
    it('is refused when the path arrives escaped', async () => {
      const res = await asUser(
        `http://cockpit.test/v1/%61dmin/restore/accounts/${ACCOUNT_NAME}`,
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
        USER_ID,
      );

      expect(res.status).toBe(401);
    });
  });
});
