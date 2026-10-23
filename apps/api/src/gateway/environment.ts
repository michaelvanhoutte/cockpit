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
 * production under.
 */
export function canRecord(env: Pick<Env, 'ENVIRONMENT' | 'USAGE_RECORDING_TOKEN'>): boolean {
  return environmentOf(env) === 'production' || Boolean(env.USAGE_RECORDING_TOKEN);
}

/**
 * What to say where a job found no key to use: which of the two it is missing,
 * since the remedy for each is a different secret.
 */
export function noClaudeKeyBecause(env: Pick<Env, 'ANTHROPIC_API_KEY'>): string {
  return env.ANTHROPIC_API_KEY
    ? 'this environment has no USAGE_RECORDING_TOKEN to record its Claude calls under'
    : 'this environment has no ANTHROPIC_API_KEY';
}

/**
 * Whether this environment has a Claude key it may spend: **outside production a
 * key with no recording token counts as no key**, so nothing is spent on it
 * without leaving a row. The one reading `aiFor`, the jobs and `/health` share.
 */
export function hasClaudeKey(env: Pick<Env, 'ENVIRONMENT' | 'USAGE_RECORDING_TOKEN' | 'ANTHROPIC_API_KEY'>): boolean {
  return Boolean(env.ANTHROPIC_API_KEY) && canRecord(env);
}
