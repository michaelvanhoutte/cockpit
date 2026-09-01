import { abortAllDurableObjects, env, runInDurableObject, SELF } from 'cloudflare:test';
import type { SqlStorage } from '@cloudflare/workers-types';
import { PROBE_NAME } from '../../src/accounts/probe.js';

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

/** One of the workspaces every account starts with. */
export const WORKSPACE_ID = 'ws-work';

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
      'INSERT OR IGNORE INTO users (id, name, account_id, role, created_at) VALUES (?, ?, ?, ?, ?)',
    ).bind(USER_ID, 'Michael', ACCOUNT_NAME, 'admin', '2026-08-12T00:00:00.000Z'),
    env.DB.prepare(
      'INSERT OR IGNORE INTO users (id, name, account_id, role, created_at) VALUES (?, ?, ?, ?, ?)',
    ).bind(OTHER_USER_ID, 'Ada', OTHER_ACCOUNT_NAME, 'user', '2026-09-01T00:00:00.000Z'),
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
export async function startFromEmpty(): Promise<void> {
  // Every account's store, and the one /health practises on: all of them
  // outlive a case, and there is a case that deliberately breaks each of them.
  for (const name of [ACCOUNT_NAME, OTHER_ACCOUNT_NAME, PROBE_NAME]) {
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

/** The cookie each user's sign-in produced, so a case signs in once and not per request. */
const signedIn = new Map<string, string>();

/**
 * Signs the user in the way the application does - through the real endpoint,
 * so the cookie a case carries is the one a browser would be holding rather
 * than a row a test wrote itself.
 */
export async function signInAs(userId: string = USER_ID): Promise<string> {
  const held = signedIn.get(userId);
  if (held) return held;

  const res = await SELF.fetch('http://cockpit.test/v1/sign-in', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId }),
  });
  if (!res.ok) throw new Error(`could not sign in as ${userId}: ${res.status}`);
  const cookie = res.headers.get('set-cookie');
  if (!cookie) throw new Error(`signing in as ${userId} set no cookie`);

  // Just the name=value, which is all a browser sends back.
  const sending = cookie.split(';')[0]!;
  signedIn.set(userId, sending);
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
