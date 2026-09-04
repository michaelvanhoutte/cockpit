import type { D1Database } from '@cloudflare/workers-types';
import type { Env } from '../env.js';

/**
 * What `/health` is able to say about an account's data without opening
 * anybody's.
 *
 * Until account data moved into a store of its own, `/health` reading D1 was a
 * true statement about where the data was. It no longer is: the register is in
 * D1 and everything a person actually looks at is in their account's store, so
 * a store that cannot be brought up to date makes every request fail while
 * `SELECT 1` keeps answering. The post-deploy assertion in
 * .github/workflows/deploy-staging.yml and the uptime monitor (architecture,
 * "Observability") both read that answer, and both would have stayed green
 * through a completely broken deployment.
 *
 * **The check practises on a store that belongs to no account.** `/health` is
 * deliberately outside every gate (docs/deployment.md, "`/health` answers
 * without a sign-in"), so anyone at all can reach it, and opening a real
 * account's store from an unauthenticated endpoint would be applying schema
 * changes to somebody's data to decide whether they are safe. The name below
 * is never resolved through `openAccount`, which is the only thing that reads
 * the register - so this cannot reach an account by accident, and the one way
 * it could reach one on purpose is if somebody registered an account under
 * this exact name. That is checked on every probe rather than assumed, by the
 * same query that proves the register is reachable at all.
 */
export const PROBE_NAME = 'health-probe';

/**
 * What the deployment can say about itself. `failure` is for the logs only and
 * never for the response: `/health` answers anyone, and the reason a change
 * would not apply names tables and columns.
 */
export interface Health {
  /** The register answered, and it does not contain the name below. */
  register: boolean;
  /** A store opened, applied every outstanding change, and answered a query. */
  store: boolean;
  /** Why not, when something said no. */
  failure?: string;
}

export async function checkHealth(env: Env): Promise<Health> {
  const register = await checkRegister(env.DB);

  // Each field says only what was actually established, which is the point of
  // the whole change. `register` is false for both of its failures - the
  // register did not answer, or it answered with the name taken - because the
  // field means the whole of what it is documented to mean, and the second of
  // those is a misconfiguration that has to be loud rather than shaded. `store`
  // is false because nothing looked, not because a store said no. Which of the
  // three it was is in `failure`, and so in the logs.
  if (register.failure) return { register: false, store: false, failure: register.failure };

  return { register: true, ...(await checkStore(env)) };
}

/**
 * One query doing both halves of the register's job here: it proves D1 answers
 * at all, and it proves the name this check practises on is not an account
 * somebody uses. Asking for a specific row rather than `SELECT 1` costs the
 * same and turns the safety property from a comment into something that is
 * true on every probe.
 */
async function checkRegister(db: D1Database): Promise<{ failure?: string }> {
  let taken: unknown;
  try {
    taken = await db.prepare('SELECT id FROM tenants WHERE id = ?').bind(PROBE_NAME).first();
  } catch (error) {
    return { failure: `the register could not be read: ${message(error)}` };
  }
  if (taken) {
    // Refusing is the whole point. Carrying on would apply schema changes to a
    // real account's data on every unauthenticated request to /health.
    return { failure: `the health check's name ${PROBE_NAME} is a registered account` };
  }
  return {};
}

/**
 * Opens the store this check owns and asks it for something, which brings it up
 * to date on the way - the same first-request-of-the-day path every account
 * takes (see `store.ts`).
 *
 * What it proves and what it does not. It proves the Durable Object class is
 * deployed, its binding resolves in this environment, and the change list
 * applies in the real runtime rather than in miniflare - the three things a
 * check that runs before the deploy cannot reach, and the last of which is
 * named in docs/account-storage-options.md ("What would reverse it") as the
 * thing to watch. It does not prove a change applies to *a particular
 * account's* rows; nothing outside that account can. That is what the gate in
 * apps/api/tests/integration/accounts/aged-store.test.ts is for, and the two
 * are not substitutes.
 *
 * The store stays warm between probes and remembers it is up to date, so the
 * change list is only really applied on the first probe after a deploy. That is
 * the probe that matters, and it is one Durable Object request either way.
 */
async function checkStore(env: Env): Promise<{ store: boolean; failure?: string }> {
  try {
    const answer = await env.ACCOUNT.get(env.ACCOUNT.idFromName(PROBE_NAME)).workspaces(PROBE_NAME);
    if (answer.status === 'ok') return { store: true };
    // `not-up-to-date` already carries the change and the underlying cause, so
    // it is passed through rather than wrapped; anything else cannot happen to
    // a store with no data in it, and is worth seeing whole if it ever does.
    const why =
      answer.status === 'not-up-to-date' ? answer.failure : `unexpectedly ${JSON.stringify(answer)}`;
    return { store: false, failure: why };
  } catch (error) {
    return { store: false, failure: `the health check's store could not be opened: ${message(error)}` };
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
