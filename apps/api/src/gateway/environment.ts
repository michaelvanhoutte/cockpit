import type { Env } from '../env.js';

/**
 * Which system this Worker is, and what that decides about recording a call
 * ("Record staging's and local Claude calls in production, under a token per
 * environment", issue 1458).
 */

/** The environments a Worker can be. A contract run is `ci` and is not a Worker. */
export type WorkerEnvironment = 'production' | 'staging' | 'local';

/**
 * What this deployment's own configuration says it is (`ENVIRONMENT`).
 * **Anything but `production` or `staging`, an absent value included, is
 * local**, so a Worker nobody configured never writes rows as production's.
 */
export function environmentOf(env: Pick<Env, 'ENVIRONMENT'>): WorkerEnvironment {
  if (env.ENVIRONMENT === 'production' || env.ENVIRONMENT === 'staging') return env.ENVIRONMENT;
  return 'local';
}

/**
 * Whether this Worker can record the calls it makes: production writes its own
 * rows, and every other environment needs the token it sends them to
 * production under and the address to send them to.
 */
export function canRecord(env: Pick<Env, 'ENVIRONMENT' | 'USAGE_RECORDING_TOKEN' | 'USAGE_RECORDING_URL'>): boolean {
  return environmentOf(env) === 'production' || Boolean(env.USAGE_RECORDING_TOKEN && env.USAGE_RECORDING_URL);
}

/**
 * What to say where a job found no key to use: which thing it is missing,
 * since the remedy for each is different.
 */
export function noClaudeKeyBecause(
  env: Pick<Env, 'ANTHROPIC_API_KEY' | 'USAGE_RECORDING_TOKEN'>,
): string {
  if (!env.ANTHROPIC_API_KEY) return 'this environment has no ANTHROPIC_API_KEY';
  return env.USAGE_RECORDING_TOKEN
    ? 'this environment has no USAGE_RECORDING_URL to send its Claude calls’ records to'
    : 'this environment has no USAGE_RECORDING_TOKEN to record its Claude calls under';
}

/**
 * Whether this environment has a Claude key it may spend: **outside production a
 * key with no recording token counts as no key**, so nothing is spent on it
 * without leaving a row. The one reading `aiFor`, the jobs and `/health` share.
 */
export function hasClaudeKey(
  env: Pick<Env, 'ENVIRONMENT' | 'USAGE_RECORDING_TOKEN' | 'USAGE_RECORDING_URL' | 'ANTHROPIC_API_KEY'>,
): boolean {
  return Boolean(env.ANTHROPIC_API_KEY) && canRecord(env);
}
