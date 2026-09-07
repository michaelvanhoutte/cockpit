import { abortAllDurableObjects, env, runInDurableObject, SELF } from 'cloudflare:test';
import type { SqlStorage } from '@cloudflare/workers-types';
import { PROBE_NAME } from '../../src/accounts/probe.js';
import { issuerIsReachable, issuerWillIdentify } from './issuer.js';

/**
 * What a test has to arrange before a request can succeed, what to put back
 * between cases, and how to read what one wrote.
 *
 * Only the register is arranged. An account's workspaces are no longer seeded
 * from outside at all: the store creates them itself the first time it is
 * opened (src/accounts/changes.ts), so a test that fetches or writes anything
 * finds them there, exactly as `pnpm dev` and a deployed environment do.
 *
 * Kept in step with seed.sql by hand - it is four rows, and importing a .sql
 * file into the workers pool costs more than it saves.
 */
export const ACCOUNT_NAME = 'tenant-default';
export const USER_ID = 'user-michael';

/**
 * The second person, and the second account. Seeded everywhere rather than only
 * in the cases about the boundary between accounts: a register with one user in
 * it cannot tell "every request resolves the signed-in account" apart from
 * "every request resolves the only account there is", so every case here runs
 * against a register where those two would give different answers.
 */
export const OTHER_ACCOUNT_NAME = 'tenant-ada';
export const OTHER_USER_ID = 'user-ada';

/**
 * The workspace every account starts with, and for most cases here the only
 * arrangement they need: something to hang a dashboard, a panel or an item off.
 * A case that is about there being *several* makes its own (`alsoWorkspaces`).
 */
export const WORKSPACE_ID = 'ws-1';

/** The dashboard that workspace arrives with (src/accounts/changes.ts). */
export const DASHBOARD_ID = `${WORKSPACE_ID}-dashboard-1`;

/**
 * *Task*, one of the two types every account starts with, by the id the store
 * derives from the account's own name (src/accounts/changes.ts). Every capture
 * names a type, so every test that captures needs one, and this is the one that
 * is there without arranging anything.
 *
 * Per account rather than one constant, because a capture into somebody else's
 * account may not name a type of this one.
 */
export const taskTypeIn = (accountName: string) => `${accountName}-type-action`;
export const TASK_TYPE_ID = taskTypeIn(ACCOUNT_NAME);

/**
 * Which account a seeded person belongs to. It throws on anybody else rather
 * than falling back, so a third user added here fails where the mapping is
 * missing instead of quietly capturing against somebody else's types.
 */
export function accountOf(userId: string): string {
  if (userId === USER_ID) return ACCOUNT_NAME;
  if (userId === OTHER_USER_ID) return OTHER_ACCOUNT_NAME;
  throw new Error(`seed.ts does not know which account ${userId} belongs to`);
}

export async function seedRegister(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare('INSERT OR IGNORE INTO tenants (id, name, created_at) VALUES (?, ?, ?)').bind(
      ACCOUNT_NAME,
      'Michael',
      '2026-08-12T00:00:00.000Z',
    ),
    env.DB.prepare('INSERT OR IGNORE INTO tenants (id, name, created_at) VALUES (?, ?, ?)').bind(
      OTHER_ACCOUNT_NAME,
      'Ada',
      '2026-09-01T00:00:00.000Z',
    ),
    env.DB.prepare(
      'INSERT OR IGNORE INTO users (id, name, account_id, role, email, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).bind(
      USER_ID,
      'Michael',
      ACCOUNT_NAME,
      'admin',
      'michael@example.com',
      '2026-08-12T00:00:00.000Z',
    ),
    env.DB.prepare(
      'INSERT OR IGNORE INTO users (id, name, account_id, role, email, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).bind(
      OTHER_USER_ID,
      'Ada',
      OTHER_ACCOUNT_NAME,
      'user',
      'ada@example.com',
      '2026-09-01T00:00:00.000Z',
    ),
  ]);
}

function accountStore() {
  return storeNamed(ACCOUNT_NAME);
}

/**
 * An empty register, no sign-ins, and accounts that have never been opened -
 * the state every case starts from.
 *
 * All three halves are needed. Emptying the storage is not enough on its own:
 * the object that read it stays in memory still believing it is up to date, and
 * would then serve the next case over tables that are no longer there. And the
 * cookies handed out below name rows that are about to be deleted, so they are
 * forgotten here rather than being offered to a register that no longer knows
 * them.
 */
/**
 * The accounts a case can bring into being by adding somebody, which the
 * register alone cannot clear (see `startFromEmpty`). Derived from the names
 * those cases type, so this list and
 * tests/integration/http/user-management.test.ts move together.
 */
const ADDABLE_ACCOUNTS = ['tenant-anna', 'tenant-anna-2', 'tenant-someone'];

export async function startFromEmpty(): Promise<void> {
  // Every account's store, and the one /health practises on: all of them
  // outlive a case, and there is a case that deliberately breaks each of them.
  //
  // **The stores a case *creates* are here too.** Emptying `tenants` takes the
  // register row and leaves the store, so an account added by a case goes on
  // holding its workspaces into the next one - and a case proving that adding
  // somebody prepares their account would then pass against a store the
  // previous case prepared. `ADDABLE_ACCOUNTS` is what the add-user cases can
  // derive; a case that adds a name not on this list has to add it here too.
  for (const name of [ACCOUNT_NAME, OTHER_ACCOUNT_NAME, PROBE_NAME, ...ADDABLE_ACCOUNTS]) {
    await runInDurableObject(storeNamed(name), (_instance, state) => state.storage.deleteAll());
  }
  await abortAllDurableObjects();
  // Children before parents: `sessions` points at `users`, which points at
  // `tenants`, and the foreign keys are real.
  await env.DB.prepare('DELETE FROM sessions').run();
  await env.DB.prepare('DELETE FROM users').run();
  await env.DB.prepare('DELETE FROM tenants').run();
  signedIn.clear();
}

/**
 * The cookie each user's sign-in produced, so a case signs in once and not per
 * request.
 *
 * The *promise* rather than the cookie, so that two requests made at once - as
 * the cases about two tabs doing something at the same time make them - wait on
 * one sign-in instead of starting two. Two at once genuinely broke: a sign-in
 * is a pair of requests with a secret carried between them, and interleaving
 * two of them left each answering the other's.
 */
const signedIn = new Map<string, Promise<string>>();

/**
 * The address each seeded person signs in with, as seed.sql gives it to them.
 * Signing in is by Google account now, so a user id is no longer something you
 * can sign in *as* - it is what the register calls whoever did.
 */
const ADDRESSES: Record<string, string> = {
  [USER_ID]: 'michael@example.com',
  [OTHER_USER_ID]: 'ada@example.com',
};

/**
 * Signs the user in the way the application does - the whole code flow, against
 * the issuer faked at the network boundary (issuer.ts) - so the cookie a case
 * carries is the one a browser would be holding rather than a row a test wrote
 * itself.
 *
 * That distinction has earned its keep: the cookie's name depends on the
 * address the request came in on, a session is a row with an expiry, and an
 * arrangement that wrote either by hand would keep passing after the
 * application stopped agreeing with it.
 */
export function signInAs(userId: string = USER_ID): Promise<string> {
  const held = signedIn.get(userId);
  if (held) return held;

  // Recorded before it has finished, which is the whole point: a second caller
  // arriving mid-flow waits on this one instead of starting a flow of its own.
  const signingIn = signIn(userId);
  signedIn.set(userId, signingIn);
  return signingIn;
}

async function signIn(userId: string): Promise<string> {
  const email = ADDRESSES[userId];
  if (!email) throw new Error(`no address is seeded for ${userId}`);

  await issuerIsReachable();
  const started = await SELF.fetch('http://cockpit.test/v1/sign-in/google', {
    redirect: 'manual',
  });
  const asked = new URL(started.headers.get('location')!);
  const attempt = started.headers.get('set-cookie')!.split(';')[0]!;

  issuerWillIdentify({ email, nonce: asked.searchParams.get('nonce')! });
  const back = await SELF.fetch(
    `http://cockpit.test/v1/sign-in/google/callback?code=a-code&state=${asked.searchParams.get('state')}`,
    { headers: { cookie: attempt }, redirect: 'manual' },
  );
  if (back.headers.get('location') !== '/') {
    throw new Error(`could not sign in as ${userId}: ${back.headers.get('location')}`);
  }

  // The session cookie, and just the name=value, which is all a browser sends
  // back. The attempt's own cookie is being deleted in the same answer.
  const sending = back.headers
    .getSetCookie()
    .map((cookie) => cookie.split(';')[0]!)
    .find((cookie) => cookie.startsWith('cockpit_session='));
  if (!sending) throw new Error(`signing in as ${userId} set no session cookie`);
  return sending;
}

/**
 * `SELF.fetch`, signed in - the way every request in the application arrives
 * now that there is a gate in front of it.
 *
 * Cases that are *about* the gate call `SELF.fetch` directly instead, because
 * arriving without a sign-in is exactly what they are asking about.
 */
export async function asUser(
  url: string,
  init: RequestInit = {},
  userId: string = USER_ID,
): Promise<Response> {
  const cookie = await signInAs(userId);
  return SELF.fetch(url, {
    ...init,
    headers: { ...((init.headers as Record<string, string>) ?? {}), cookie },
  });
}

/** Any store, by the name it is addressed under - the stores no account owns included. */
export function storeNamed(name: string) {
  return env.ACCOUNT.get(env.ACCOUNT.idFromName(name));
}

/** Reads or writes any store directly, without bringing it up to date first. */
export async function inStoreAsItIs<T>(name: string, work: (sql: SqlStorage) => T): Promise<T> {
  return runInDurableObject(storeNamed(name), (_instance, state) => work(state.storage.sql));
}

/**
 * Reads or writes the account's store directly, for the cases whose subject is
 * what actually ended up in storage.
 *
 * The account is brought up to date first, the same way the first real request
 * of the day brings it up to date, so the tables are there whether or not the
 * case under test ever reached the store.
 */
export async function inTheStore<T>(work: (sql: SqlStorage) => T): Promise<T> {
  const stub = accountStore();
  const opened = await stub.workspaces(ACCOUNT_NAME);
  // Said out loud rather than left to the caller's SQL, which would otherwise
  // fail with "no such table" and hide the reason the tables are not there.
  if (opened.status !== 'ok') throw new Error(JSON.stringify(opened));
  return runInDurableObject(stub, (_instance, state) => work(state.storage.sql));
}

/**
 * The store *without* bringing it up to date - the one case that needs to
 * arrange storage before the first change has run.
 */
export async function inTheStoreAsItIs<T>(work: (sql: SqlStorage) => T): Promise<T> {
  return inStoreAsItIs(ACCOUNT_NAME, work);
}

/**
 * Two more workspaces, for the cases that are about there being several: which
 * one an item is in, what order they come back in, and that one never sees
 * another's rows. An account starts with one (src/accounts/changes.ts,
 * `0015-first-workspace`), so a case that needs a second says so here.
 *
 * **Written into the store rather than made through `create_workspace`**, for
 * the one reason worth a helper: the cases name these by readable ids, and that
 * command takes a uuid. What it must not do is invent a *shape* - each arrives
 * with the dashboard and the panel a workspace really arrives with, so a case
 * that files something into one is filing into a workspace the app could have
 * made.
 *
 * Positions follow the one already there, so the order they come back in is the
 * order they were made in, which is what the ordering cases are about.
 */
export async function alsoWorkspaces(): Promise<void> {
  await inTheStore((sql) => {
    const made = [
      { id: 'ws-atlas', name: 'Atlas Copco', color: '#3a72c8', at: '2026-08-12T00:00:02.000Z' },
      { id: 'ws-personal', name: 'Personal', color: '#c06a45', at: '2026-08-12T00:00:03.000Z' },
    ];
    made.forEach((workspace, index) => {
      sql.exec(
        `INSERT INTO workspaces (id, tenant_id, name, folded_name, color, position, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        workspace.id,
        ACCOUNT_NAME,
        workspace.name,
        workspace.name.toLowerCase(),
        workspace.color,
        index + 1,
        workspace.at,
      );
      sql.exec(
        `INSERT INTO dashboards (id, tenant_id, workspace_id, name, folded_name, created_at)
         VALUES (?, ?, ?, 'Dashboard 1', 'dashboard 1', ?)`,
        `${workspace.id}-dashboard-1`,
        ACCOUNT_NAME,
        workspace.id,
        workspace.at,
      );
      sql.exec(
        `INSERT INTO panels (id, tenant_id, dashboard_id, name, folded_name, created_at)
         VALUES (?, ?, ?, 'Panel 1', 'panel 1', ?)`,
        `${workspace.id}-panel-1`,
        ACCOUNT_NAME,
        `${workspace.id}-dashboard-1`,
        workspace.at,
      );
    });
  });
}
