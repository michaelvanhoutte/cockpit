import type { Env } from '../env.js';
import type { AttemptRecord, Recorder } from './attempts.js';
import { environmentOf } from './environment.js';
import { providerCallsIn } from './record.js';
import { USAGE_RECORDS_PATH } from './receive.js';

/**
 * How a record leaves an environment that is not production ("Record staging's
 * and local Claude calls in production, under a token per environment", issue
 * 1458): sent to production over HTTPS, which writes it beside its own, and
 * never kept here.
 */

/** How long a send is awaited, in milliseconds. */
export const SEND_TIMEOUT_MS = 2000;

/** Where records go and the token they go under. */
export interface Destination {
  /** The whole address of production's route. */
  url: string;
  token: string;
}

/** What a sender needs from outside itself, so its timeout and its one attempt are proved without a network or a clock. */
export interface Around {
  send: (url: string, init: RequestInit) => Promise<Response>;
  wait: (ms: number) => Promise<void>;
  /** This environment's own user id for an account, or `null` where it has none. */
  userOf: (accountName: string) => Promise<string | null>;
  /** The branch a local checkout is on; `null` anywhere else. */
  branch: string | null;
}

const TIMED_OUT = Symbol('timed out');

/**
 * Sends each settled attempt's record to production, awaiting it for
 * `SEND_TIMEOUT_MS` and **never repeating it**: a send that landed after its
 * timeout cannot then be written twice. **A failure never costs the call**: it
 * is logged, once, and the one record is lost. The log names the operation and
 * what went wrong and never the token.
 */
export function sendingTo(destination: Destination, around: Around): Recorder {
  return async (row: AttemptRecord) => {
    const lost = (why: string) =>
      console.error(
        JSON.stringify({ level: 'error', message: `a ${row.operation} record was not sent to production: ${why}` }),
      );
    const controller = new AbortController();
    try {
      const userId = await around.userOf(row.accountName).catch(() => null);
      const answered = around.send(destination.url, {
        method: 'POST',
        headers: { authorization: `Bearer ${destination.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ ...row, userId, branch: around.branch }),
        signal: controller.signal,
      });
      const gaveUp = around.wait(SEND_TIMEOUT_MS).then((): typeof TIMED_OUT => TIMED_OUT);
      const result = await Promise.race([answered, gaveUp]);
      if (result === TIMED_OUT) {
        controller.abort();
        answered.catch(() => {});
        return lost(`it did not answer in ${SEND_TIMEOUT_MS / 1000} seconds`);
      }
      if (!result.ok) return lost(`it answered ${result.status}`);
      await result.body?.cancel();
    } catch (error) {
      lost(error instanceof Error ? error.message : String(error));
    }
  };
}

/**
 * The recorder for the calls this Worker makes: production writes its own,
 * and every other environment sends to production under its recording token.
 * An environment missing the token or the address records nothing and says so
 * on each call, which `canRecord` (`environment.ts`) keeps a Claude call from
 * reaching.
 */
export function recorderFor(env: Env): Recorder {
  if (environmentOf(env) === 'production') return providerCallsIn(env);
  const { USAGE_RECORDING_TOKEN: token, USAGE_RECORDING_URL: address } = env;
  if (!token || !address) {
    return async () => {
      throw new Error(
        `this environment has no ${token ? 'USAGE_RECORDING_URL' : 'USAGE_RECORDING_TOKEN'} to send its records with`,
      );
    };
  }
  return sendingTo(
    { url: new URL(USAGE_RECORDS_PATH, address).href, token },
    {
      send: (url, init) => fetch(url, init),
      wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      userOf: async (accountName) =>
        (
          await env.DB.prepare('SELECT id FROM users WHERE account_id = ? ORDER BY created_at LIMIT 1')
            .bind(accountName)
            .first<{ id: string }>()
        )?.id ?? null,
      branch: environmentOf(env) === 'local' ? (env.CHECKOUT_BRANCH ?? null) : null,
    },
  );
}
