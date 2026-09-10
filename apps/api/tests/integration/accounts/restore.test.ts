import { beforeEach, describe, expect, inject, it } from 'vitest';
import { SELF, applyD1Migrations, env } from 'cloudflare:test';
import { accountChanges } from '../../../src/accounts/changes.js';
import {
  ACCOUNT_NAME,
  OTHER_ACCOUNT_NAME,
  OTHER_USER_ID,
  USER_ID,
  accountOf,
  asUser,
  inStoreAsItIs,
  seedRegister,
  startFromEmpty,
  taskTypeIn,
} from '../seed.js';

/**
 * Integration level throughout, for the reason the whole feature has: what a
 * restore does is put rows into a real store, and nothing below the HTTP entry
 * point can prove that what came back is what went in.
 *
 * The two things asked elsewhere are the two that are decisions rather than
 * writes: which register rows collide (`tests/unit/accounts/register-restore.test.ts`,
 * where four uniqueness rules branch and no register is needed to say so), and
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
  const res = await asOperator(`/v1/operator/backup/accounts/${accountName}`);
  expect(res.status).toBe(200);
  return (await res.json()) as AccountFile;
}

function restore(
  accountName: string,
  backup: unknown,
  { force = false } = {},
): Promise<Response> {
  return asOperator(
    `/v1/operator/restore/accounts/${accountName}${force ? '?force=true' : ''}`,
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
        // Every capture names what kind of thing it is ("Say what kind of thing
        // it is when capturing it", pull request 212), and a type of the
        // account being captured into.
        typeId: taskTypeIn(accountOf(userId)),
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
     * Found by running the command, not by a test. An account in the register
     * that nobody has opened backs up as nothing at all, and bringing it up to
     * date on the way back in would create its tables *and* seed a new
     * account's starting workspace and standard types - so restoring
     * nothing produced eight rows. Left alone, the first request creates it
     * exactly as it does for any untouched account, which is what it was.
     */
    it('puts back an account nobody had opened as one nobody has opened', async () => {
      const taken = await backUp(OTHER_ACCOUNT_NAME);
      expect(taken.tables).toEqual({});
      expect(taken.changesApplied).toEqual([]);

      expect((await restore(OTHER_ACCOUNT_NAME, taken)).status).toBe(200);

      const now = await backUp(OTHER_ACCOUNT_NAME);
      expect(now.tables).toEqual({});
      expect(now.changesApplied).toEqual([]);
    });

    it('opens such an account normally afterwards', async () => {
      const taken = await backUp(OTHER_ACCOUNT_NAME);
      await restore(OTHER_ACCOUNT_NAME, taken);

      // The first request creates it, exactly as it would have before.
      expect((await useAccount(OTHER_USER_ID)).length).toBeGreaterThan(0);
    });

    /**
     * A row of a dozen columns fits six to a statement, so an account with
     * ordinary use in it already crosses the boundary several times over. The
     * count is asserted rather than assumed because the failure is silent: a
     * write that stops at the batch size leaves a store that looks restored.
     */
    /**
     * The number goes into the command's output as a claim about what
     * happened, so it is counted by whatever did the writing rather than from
     * the file - a backup routinely names tables it has no rows for.
     */
    it('reports what it wrote, not what the file named', async () => {
      await captureInto(USER_ID, 'mine');
      const taken = await backUp(ACCOUNT_NAME);
      const withRows = Object.values(taken.tables).filter((rows) => rows.length > 0);
      expect(Object.keys(taken.tables).length).toBeGreaterThan(withRows.length);
      await emptyTheStore(ACCOUNT_NAME);

      const res = await restore(ACCOUNT_NAME, taken);
      expect(res.status).toBe(200);

      expect(await res.json()).toEqual({
        tablesWritten: withRows.length,
        rowsWritten: withRows.reduce((all, rows) => all + rows.length, 0),
      });
    });

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
    /**
     * The hole the rows' own `tenant_id` could not close, because it can only
     * disagree with rows that exist. A backup of an account nobody has opened
     * has none - so somebody else's empty backup went into a busy account,
     * dropped every table it held, and answered 200 having found no violation.
     * A file says whose it is, and that is now what is checked, before anything
     * is dropped.
     */
    it('refuses another account’s empty backup, and changes nothing', async () => {
      await captureInto(USER_ID, 'mine');
      const hers = await backUp(OTHER_ACCOUNT_NAME);
      expect(hers.tables).toEqual({});

      const res = await restore(ACCOUNT_NAME, hers, { force: true });

      expect(res.status).toBe(400);
      const { error } = (await res.json()) as { error: string };
      expect(error).toContain(OTHER_ACCOUNT_NAME);
      expect(error).toContain(ACCOUNT_NAME);
      expect(messagesIn(await backUp(ACCOUNT_NAME))).toContain('mine');
    });

    it('refuses a backup that does not say whose it is', async () => {
      await captureInto(USER_ID, 'mine');
      const { account: _, ...anonymous } = await backUp(ACCOUNT_NAME);

      const res = await restore(ACCOUNT_NAME, anonymous, { force: true });

      expect(res.status).toBe(400);
      expect(messagesIn(await backUp(ACCOUNT_NAME))).toContain('mine');
    });

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

  describe('restoring refuses anything that is not a backup, and says what is wrong with it', () => {
    /**
     * The routes validate like every other one, which the first draft of these
     * two did not: a cast rather than a schema meant every malformed body
     * answered `500 internal error`, saying nothing about a file somebody could
     * fix. Worse than the message - the only reason a malformed body was not
     * *destructive* was that the guards which throw on one happen to run before
     * the transaction opens, which is an accident of ordering rather than a
     * property.
     */
    it.each([
      { situation: 'nothing in it', body: '{}' },
      { situation: 'null', body: 'null' },
      { situation: 'a bare string', body: '"a string"' },
      { situation: 'not JSON at all', body: 'not json' },
      { situation: 'a change list that is not a list', body: '{"changesApplied":"one","tables":{}}' },
      { situation: 'tables that are not tables', body: '{"changesApplied":[],"tables":null}' },
      {
        situation: 'a table holding something other than rows',
        body: '{"changesApplied":[],"tables":{"items":[1,2]}}',
      },
    ])('refuses $situation, and does not answer as though it broke', async ({ body }) => {
      const res = await asOperator(`/v1/operator/restore/accounts/${ACCOUNT_NAME}?force=true`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      });

      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain('not a backup');
    });

    /**
     * A 400 rather than the 409 a disagreement gets: a row nothing could write
     * is a broken file, so saying "the register does not fit" of it would send
     * somebody to look at the register. One example here; which rows are
     * unusable is asked at tests/unit/accounts/register-restore.test.ts.
     */
    it('refuses a register row nothing could write, without blaming the register', async () => {
      const res = await asOperator('/v1/operator/restore/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tenants: [{}], users: [] }),
      });

      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain('carries no columns');
    });

    /**
     * The columns a row needs come from the register itself rather than a list
     * somebody has to keep, so a sparse-but-not-empty row is refused instead of
     * failing its INSERT on a NOT NULL constraint - which was a 500 at the one
     * moment a restore can no longer be undone, the accounts having already
     * been replaced by the time the register is written.
     */
    it.each([
      { situation: 'an account with only an id', body: { tenants: [{ id: 'tenant-x' }], users: [] } },
      {
        situation: 'a user with no name or role',
        body: { tenants: [], users: [{ id: 'u', account_id: ACCOUNT_NAME }] },
      },
    ])('refuses $situation rather than letting the insert fail', async ({ body }) => {
      const res = await asOperator('/v1/operator/restore/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toMatch(/has no /);
    });

    it('refuses a register that is not one', async () => {
      const res = await asOperator('/v1/operator/restore/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"tenants":null,"users":[]}',
      });

      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain('not a register');
    });

    /**
     * The register cannot be consulted here - an account is restored before its
     * register row exists - so the name's shape is what stands between a typo
     * and a store created under it that nothing will ever address again.
     */
    it.each([
      { situation: 'a separator', name: 'a%2Fb' },
      { situation: 'a space', name: 'a%20b' },
      // Refused before the schema sees it: the router collapses a walk upwards
      // out of the path, so it matches no route at all. Kept in the table
      // because what matters is that no store is made under it, not which of
      // the two refusals gets there first.
      { situation: 'a walk upwards', name: '..' },
    ])('makes no store for a name with $situation in it', async ({ name }) => {
      const res = await asOperator(`/v1/operator/restore/accounts/${name}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"changesApplied":[],"tables":{}}',
      });

      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
    });

    /**
     * The worst failure this command has: a restore that reports success and
     * silently did not restore something. Replaying the change list is what
     * creates the tables, so a backup whose rows outlive their schema - a
     * `changesApplied` trimmed by hand, a file merged from two others - has rows
     * with nowhere to go. Walking the schema and reading the file through it
     * dropped them without a word, and answered with a count taken from the
     * file that said they had been written.
     */
    it('refuses a backup holding rows for a table its changes do not create', async () => {
      await captureInto(USER_ID, 'mine');
      const taken = await backUp(ACCOUNT_NAME);
      const orphaned = {
        account: ACCOUNT_NAME,
        changesApplied: [],
        tables: { items: taken.tables.items! },
      };

      const res = await restore(ACCOUNT_NAME, orphaned, { force: true });

      expect(res.status).toBe(400);
      const { error } = (await res.json()) as { error: string };
      expect(error).toContain('nowhere to go');
      expect(error).toContain('items');
      expect(messagesIn(await backUp(ACCOUNT_NAME))).toContain('mine');
    });

    /**
     * A backup is a file on somebody's disk and may have been edited by hand -
     * that is what the format is for - so rows disagreeing about their columns
     * is a real state. Taking the first row's list and reading the rest through
     * it writes NULL for a column a later row lacks and drops one it gained,
     * both landing as a restore that reports success having lost data.
     *
     * One example here, not the branches. Which shapes of row disagree - a
     * column gained, one missing, none at all - is a decision about plain data
     * and is asked at tests/unit/accounts/restore.test.ts, where the ways they
     * can differ cost nothing to arrange. What is left for this tier is the
     * half that cannot be asked there: a throw inside the transaction becoming
     * a 400, with the account left as it was.
     */
    it('refuses a table whose rows do not all carry the same columns', async () => {
      await captureInto(USER_ID, 'mine');
      const taken = await backUp(ACCOUNT_NAME);
      const [first] = taken.tables.workspaces!;
      const ragged = {
        ...taken,
        tables: { ...taken.tables, workspaces: [first!, { ...first!, extra: 'unexpected' }] },
      };

      const res = await restore(ACCOUNT_NAME, ragged, { force: true });

      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain('same columns');
      expect(messagesIn(await backUp(ACCOUNT_NAME))).toContain('mine');
    });
  });

  /**
   * The columns the last two changes add, by table - none, unless one of them
   * altered a table the backup carries rows for.
   *
   * **Written out rather than derived, and it is the fixture's second half.** A
   * backup records the shape its rows were in, so the changes it names and the
   * columns on its rows have to agree: a backup naming changes that have not
   * added a column, whose rows carry that column anyway, is a state no backup
   * can be in - and the restore rightly refuses to insert it. Without this, the
   * case below went red on the day a change added a column, as a 400 that named
   * nothing, and read as a broken restore rather than a stale fixture.
   *
   * Keep it in step when a change is added to the end of `accountChanges`.
   */
  const COLUMNS_THE_LAST_TWO_CHANGES_ADD: Record<string, string[]> = {
    // 0023-item-proposed-panel. The other of the two, 0015-first-workspace,
    // inserts rows and adds no column.
    items: ['proposed_panel_id', 'proposed_panel_reason'],
  };

  /** That backup as it would really have been taken, both halves agreeing. */
  function takenBeforeTheLastTwoChanges(taken: AccountFile, everything: string[]): AccountFile {
    return {
      ...taken,
      changesApplied: everything.slice(0, -2),
      tables: Object.fromEntries(
        Object.entries(taken.tables).map(([table, rows]): [string, Record<string, unknown>[]] => {
          const added = COLUMNS_THE_LAST_TWO_CHANGES_ADD[table] ?? [];
          return [
            table,
            rows.map((row) => {
              const older: Record<string, unknown> = {};
              for (const [column, value] of Object.entries(row)) {
                if (!added.includes(column)) older[column] = value;
              }
              return older;
            }),
          ];
        }),
      ),
    };
  }

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
      const older = takenBeforeTheLastTwoChanges(taken, everything);
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

      const res = await asOperator('/v1/operator/restore/register', {
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

    /**
     * One collision, not all three. The route answers every disagreement the
     * same way - a 409 carrying the message the plan made - so a second case
     * here would re-prove `planRegisterRestore`, which
     * tests/unit/accounts/register-restore.test.ts already asks exhaustively.
     * What this proves is the wiring: a collision reaches a 409 and the
     * register is not written to on the way.
     */
    it('refuses a user already here owning a different account, and writes nothing', async () => {
      const user = {
        id: USER_ID,
        name: 'Michael',
        account_id: 'somewhere-else',
        role: 'admin',
        email: 'new@example.com',
        google_subject: null,
        created_at: AT,
      };
      const before = await env.DB.prepare('SELECT * FROM users ORDER BY id').all();

      const res = await asOperator('/v1/operator/restore/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tenants: [], users: [user] }),
      });

      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toContain('owning');
      expect((await env.DB.prepare('SELECT * FROM users ORDER BY id').all()).results).toEqual(
        before.results,
      );
    });
  });

  describe('restoring is refused to anyone without the operator’s secret', () => {
    it.each([
      { situation: 'an account', path: `/v1/operator/restore/accounts/${ACCOUNT_NAME}` },
      { situation: 'the register', path: '/v1/operator/restore/register' },
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
        `http://cockpit.test/v1/%6Fperator/restore/accounts/${ACCOUNT_NAME}`,
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
        USER_ID,
      );

      expect(res.status).toBe(401);
    });
  });
});
