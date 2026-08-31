import { abortAllDurableObjects, env, runInDurableObject } from 'cloudflare:test';
import type { SqlStorage } from '@cloudflare/workers-types';

/**
 * What a test has to arrange before a request can succeed, what to put back
 * between cases, and how to read what one wrote.
 *
 * Only the register is arranged. An account's workspaces are no longer seeded
 * from outside at all: the store creates them itself the first time it is
 * opened (src/accounts/changes.ts), so a test that fetches or writes anything
 * finds them there, exactly as `pnpm dev` and a deployed environment do.
 *
 * Kept in step with seed.sql by hand - it is one row, and importing a .sql file
 * into the workers pool costs more than it saves.
 */
export const ACCOUNT_NAME = 'tenant-default';

/** One of the workspaces every account starts with. */
export const WORKSPACE_ID = 'ws-work';

export async function seedRegister(): Promise<void> {
  await env.DB.prepare('INSERT OR IGNORE INTO tenants (id, name, created_at) VALUES (?, ?, ?)')
    .bind(ACCOUNT_NAME, 'Michael', '2026-08-12T00:00:00.000Z')
    .run();
}

function accountStore() {
  return env.ACCOUNT.get(env.ACCOUNT.idFromName(ACCOUNT_NAME));
}

/**
 * An empty register and an account that has never been opened - the state
 * every case starts from, since there is only ever one account name and every
 * case therefore addresses the same store.
 *
 * Both halves are needed. Emptying the storage is not enough on its own: the
 * object that read it stays in memory still believing it is up to date, and
 * would then serve the next case over tables that are no longer there.
 */
export async function startFromEmpty(): Promise<void> {
  await runInDurableObject(accountStore(), (_instance, state) => state.storage.deleteAll());
  await abortAllDurableObjects();
  await env.DB.prepare('DELETE FROM tenants').run();
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
  await stub.workspaces(ACCOUNT_NAME);
  return runInDurableObject(stub, (_instance, state) => work(state.storage.sql));
}

/**
 * The store *without* bringing it up to date - the one case that needs to
 * arrange storage before the first change has run.
 */
export async function inTheStoreAsItIs<T>(work: (sql: SqlStorage) => T): Promise<T> {
  return runInDurableObject(accountStore(), (_instance, state) => work(state.storage.sql));
}
