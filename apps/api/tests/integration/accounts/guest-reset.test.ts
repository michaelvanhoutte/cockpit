import { beforeEach, describe, expect, inject, it } from 'vitest';
import { SELF, applyD1Migrations, env } from 'cloudflare:test';
import type { Workspace } from '@cockpit/shared';
import { GUEST_ACCOUNT_NAME, GUEST_USER_ID } from '../../../src/auth/register.js';
import { handleScheduled } from '../../../src/jobs/index.js';
import {
  ACCOUNT_NAME,
  OTHER_ACCOUNT_NAME,
  OTHER_USER_ID,
  USER_ID,
  WORKSPACE_ID,
  asUser,
  inStoreAsItIs,
  seedRegister,
  signInAs,
  startFromEmpty,
  storeNamed,
  taskTypeIn,
} from '../seed.js';

/**
 * Integration level throughout: what is claimed is what an account's store
 * holds after a reset - every row of one real store compared with every row of
 * another - and the two ways in are the operator's route and the scheduled
 * handler. What the demonstration itself contains is guest-demo.test.ts's
 * question and is not asked again; here it is only ever "whatever the guest
 * account held when it was first opened".
 *
 * **What an account holds is read through the operator's backup route**, which
 * reads a store as it stands, every table and every row, without bringing it
 * up to date - so the comparisons are of storage, not of what some read
 * happens to select.
 */

const SECRET = 'test-operator-secret';
const AT = '2026-09-11T10:00:00.000Z';

let seq = 0;
function nextId(): string {
  seq += 1;
  return `018f0000-0000-7000-8000-${String(seq).padStart(12, '0')}`;
}

interface Held {
  changesApplied: string[];
  tables: Record<string, unknown[]>;
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

/** Everything an account's store holds, read the way a backup reads it. */
async function held(accountName: string): Promise<Held> {
  const res = await asOperator(`/v1/operator/backup/accounts/${accountName}`);
  const said = await res.text();
  expect(res.status, said).toBe(200);
  const { changesApplied, tables } = JSON.parse(said) as Held;
  return { changesApplied, tables };
}

/** Who can sign in, and to which accounts. */
async function register(): Promise<unknown> {
  const res = await asOperator('/v1/operator/backup/register');
  expect(res.status).toBe(200);
  return res.json();
}

/** What `pnpm guest:reset` asks. */
function resetByOperator(): Promise<Response> {
  return asOperator('/v1/operator/guest/reset', { method: 'POST' });
}

/**
 * What Cron Triggers run. The controller is not read - there is one schedule
 * and nothing to dispatch on - so an empty stand-in is the whole of it, as in
 * routing-summary-cron.test.ts.
 */
function resetNightly(): Promise<void> {
  return handleScheduled({} as never, env);
}

/**
 * The two ways in, which have to be one reset ("Reset the guest account to its
 * seeded state", issue 356: "both run the same logic").
 */
const WAYS = [
  {
    situation: 'an operator asks for it',
    reset: async () => {
      const res = await resetByOperator();
      expect(res.status, await res.clone().text()).toBe(200);
    },
  },
  { situation: 'the nightly run comes round', reset: resetNightly },
];

/** Pressing "Continue as guest", and the cookie it hands back. */
async function continueAsGuest(): Promise<string> {
  const back = await SELF.fetch('http://cockpit.test/v1/sign-in/guest', { redirect: 'manual' });
  const cookie = back.headers
    .getSetCookie()
    .map((one) => one.split(';')[0]!)
    .find((one) => one.startsWith('cockpit_session='));
  expect(cookie, 'continuing as a guest set no session cookie').toBeDefined();
  return cookie!;
}

async function workspacesOf(cookie: string): Promise<Workspace[]> {
  const res = await SELF.fetch('http://cockpit.test/v1/workspaces', { headers: { cookie } });
  expect(res.status).toBe(200);
  return ((await res.json()) as { workspaces: Workspace[] }).workspaces;
}

/** A change made the way the app makes one, as whoever holds this cookie. */
async function send(command: string, cookie: string, body: Record<string, unknown>): Promise<void> {
  const res = await SELF.fetch(`http://cockpit.test/v1/commands/${command}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ commandId: nextId(), issuedAt: AT, ...body }),
  });
  expect(res.status, await res.clone().text()).toBe(200);
}

/**
 * A guest opening the account - which is what creates it and brings it up to
 * date, and so what its seeded state *is*: whatever that first opening leaves.
 */
async function openAsGuest(): Promise<{ cookie: string; workspaces: Workspace[]; seeded: Held }> {
  const cookie = await continueAsGuest();
  const workspaces = await workspacesOf(cookie);
  return { cookie, workspaces, seeded: await held(GUEST_ACCOUNT_NAME) };
}

/** Guests adding, changing and deleting something, and proof that they did. */
async function guestsUseIt(cookie: string, workspaces: Workspace[], seeded: Held): Promise<void> {
  const [first, second] = workspaces;
  await send('capture_item', cookie, {
    workspaceId: first!.id,
    itemId: nextId(),
    message: 'A guest was here',
    typeId: taskTypeIn(GUEST_ACCOUNT_NAME),
  });
  await send('rename_workspace', cookie, { workspaceId: first!.id, name: 'Renamed by a guest' });
  await send('delete_workspace', cookie, { workspaceId: second!.id });
  expect(
    await held(GUEST_ACCOUNT_NAME),
    'the guests changed nothing, so a reset would have nothing to prove',
  ).not.toEqual(seeded);
}

beforeEach(async () => {
  await applyD1Migrations(env.DB, inject('migrations'));
  await startFromEmpty();
  await seedRegister();
});

describe('Accounts', () => {
  describe('the guest account goes back to exactly the demonstration it opened on, whichever way it is asked', () => {
    it.each(WAYS)('undoes whatever guests added, changed and deleted, when $situation', async ({ reset }) => {
      const { cookie, workspaces, seeded } = await openAsGuest();
      await guestsUseIt(cookie, workspaces, seeded);

      await reset();

      expect(await held(GUEST_ACCOUNT_NAME)).toEqual(seeded);
    });
  });

  describe('putting the guest account back touches nothing but the guest account', () => {
    it('leaves every other account, and who can sign in, exactly as they were', async () => {
      await send('capture_item', await signInAs(USER_ID), {
        workspaceId: WORKSPACE_ID,
        itemId: nextId(),
        message: 'Mine, and nothing resets it',
        typeId: taskTypeIn(ACCOUNT_NAME),
      });
      expect((await asUser('http://cockpit.test/v1/workspaces', {}, OTHER_USER_ID)).status).toBe(200);
      const { cookie, workspaces, seeded } = await openAsGuest();
      await guestsUseIt(cookie, workspaces, seeded);
      const before = {
        mine: await held(ACCOUNT_NAME),
        theirs: await held(OTHER_ACCOUNT_NAME),
        register: await register(),
      };

      for (const { reset } of WAYS) await reset();

      expect({
        mine: await held(ACCOUNT_NAME),
        theirs: await held(OTHER_ACCOUNT_NAME),
        register: await register(),
      }).toEqual(before);
      // And the guest account did go back, so the silence above is not a reset
      // that did nothing at all.
      expect(await held(GUEST_ACCOUNT_NAME)).toEqual(seeded);
    });

    /**
     * The one real account the guest's own id can reach. Adding somebody called
     * "Guest" handed out these same ids until add-user stopped offering them
     * (accounts/new-user.ts), and every row such a person writes carries
     * `tenant-guest`, so only the register can say whose it is. The register is
     * written directly: adding no longer produces this state, and a register
     * from before it can still hold it.
     */
    it('leaves a real person alone, even one added under the name "Guest"', async () => {
      await env.DB.batch([
        env.DB.prepare('INSERT INTO tenants (id, name, created_at) VALUES (?, ?, ?)').bind(
          GUEST_ACCOUNT_NAME,
          'Guest',
          AT,
        ),
        env.DB.prepare(
          'INSERT INTO users (id, name, account_id, role, email, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        ).bind(GUEST_USER_ID, 'Guest', GUEST_ACCOUNT_NAME, 'user', 'somebody.called.guest@example.com', AT),
      ]);
      // Their account, opened, with work of their own in it.
      expect((await storeNamed(GUEST_ACCOUNT_NAME).workspaces(GUEST_ACCOUNT_NAME)).status).toBe('ok');
      await inStoreAsItIs(GUEST_ACCOUNT_NAME, (sql) => {
        sql.exec(
          `INSERT INTO workspaces (id, tenant_id, name, folded_name, color, position, created_at)
           VALUES ('ws-theirs', ?, 'Their own', 'their own', '#3a72c8', 99, ?)`,
          GUEST_ACCOUNT_NAME,
          AT,
        );
      });
      const before = await held(GUEST_ACCOUNT_NAME);

      expect((await resetByOperator()).status).toBe(409);
      await resetNightly();

      expect(await held(GUEST_ACCOUNT_NAME)).toEqual(before);
    });

    /**
     * Reached past the route on purpose. The route addresses the guest's store
     * and no other, so nothing a request can say lands this on a real account -
     * which is exactly why the store refusing on its own is the thing to prove:
     * it is what holds the day the addressing is wrong.
     */
    it("refuses outright when what it is asked of is not the guest's account", async () => {
      expect((await asUser('http://cockpit.test/v1/workspaces', {}, USER_ID)).status).toBe(200);
      const before = await held(ACCOUNT_NAME);

      const answer = await storeNamed(ACCOUNT_NAME).resetGuest();

      expect(answer.status).toBe('conflict');
      expect(await held(ACCOUNT_NAME)).toEqual(before);
    });

    it('does nothing at all where this environment has no guest account', async () => {
      // Nobody has continued as a guest, which is staging for ever.
      expect((await resetByOperator()).status).toBe(404);
      await resetNightly();

      // Addressing a store by name makes one, so "nothing" includes no store
      // built for an account nobody can open.
      const tables = await inStoreAsItIs(GUEST_ACCOUNT_NAME, (sql) =>
        sql
          .exec(
            `SELECT name FROM sqlite_master
             WHERE type = 'table'
               AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
               AND name NOT LIKE '\\_%' ESCAPE '\\'`,
          )
          .toArray(),
      );
      expect(tables).toEqual([]);
    });
  });

  describe('putting the guest account back happens whole or not at all', () => {
    it('leaves the guest account as it was when it fails partway', async () => {
      const { cookie, workspaces, seeded } = await openAsGuest();
      await guestsUseIt(cookie, workspaces, seeded);
      const before = await held(GUEST_ACCOUNT_NAME);
      // Something the reset cannot drop past: a row outside the account's own
      // tables - the leading underscore keeps it out, as it keeps the runtime's
      // own out (backup.ts) - still pointing at one of its Workspaces. Dropping
      // `workspaces` then fails on that foreign key after every table below it
      // has already gone, so this fails partway rather than before it starts.
      await inStoreAsItIs(GUEST_ACCOUNT_NAME, (sql) => {
        sql.exec('CREATE TABLE _points_at_a_workspace (workspace_id text NOT NULL REFERENCES workspaces (id))');
        sql.exec('INSERT INTO _points_at_a_workspace (workspace_id) VALUES (?)', workspaces[0]!.id);
      });

      const res = await resetByOperator();

      expect(res.status).toBe(500);
      expect(await held(GUEST_ACCOUNT_NAME)).toEqual(before);
    });

    it('changes nothing further when it is done a second time', async () => {
      const { cookie, workspaces, seeded } = await openAsGuest();
      await guestsUseIt(cookie, workspaces, seeded);
      expect((await resetByOperator()).status).toBe(200);
      const once = await held(GUEST_ACCOUNT_NAME);

      expect((await resetByOperator()).status).toBe(200);

      expect(await held(GUEST_ACCOUNT_NAME)).toEqual(once);
      expect(once).toEqual(seeded);
    });

    it('ends on the demonstration when an operator and the nightly run ask at the same moment', async () => {
      const { cookie, workspaces, seeded } = await openAsGuest();
      await guestsUseIt(cookie, workspaces, seeded);

      const [answer] = await Promise.all([resetByOperator(), resetNightly()]);

      expect(answer.status, await answer.text()).toBe(200);
      expect(await held(GUEST_ACCOUNT_NAME)).toEqual(seeded);
    });
  });
});
