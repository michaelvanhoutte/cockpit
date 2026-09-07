//
// Where the backup commands get an environment's secret and address from, so
// that running one is `pnpm backup:export --env production` and nothing else.
//
// The file is `backup-tokens.json` in the checkout, gitignored, in the shape
// `backup-tokens.example.json` shows. Why it is a file rather than an
// environment variable is in docs/deployment.md, "Secrets and access", rather
// than here.
//
// `COCKPIT_BACKUP_TOKEN` still wins where it is set, which is what CI wants -
// one environment, one token, nothing on disk.
//

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** What the commands need to reach an environment. */
export const CONFIG_FILE = 'backup-tokens.json';

/**
 * Reads the file, or nothing where there is none.
 *
 * Absent is not an error here: the variable may carry everything needed, and
 * saying so is `resolveToken`'s job once it knows what it has.
 */
export function readConfig(root, { read = readFileSync } = {}) {
  try {
    return JSON.parse(read(resolve(root, CONFIG_FILE), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    if (error instanceof SyntaxError) {
      throw new Error(`${CONFIG_FILE} is not readable as JSON: ${error.message}`);
    }
    throw error;
  }
}

/**
 * That environment's token: the variable if it is set, otherwise the file.
 *
 * The message when there is neither names both ways rather than the one this
 * repository prefers, because the two failures are different - somebody in CI
 * has no file to fix, and somebody at a keyboard has no variable they meant to
 * set.
 */
export function resolveToken(environment, { config, env = {} }) {
  const fromEnvironment = env.COCKPIT_BACKUP_TOKEN;
  if (fromEnvironment) return fromEnvironment;

  const fromFile = config?.tokens?.[environment];
  if (fromFile) return fromFile;

  if (!config) {
    throw new Error(
      `No token for ${environment}. Copy ${CONFIG_FILE.replace('.json', '.example.json')} to ` +
        `${CONFIG_FILE} and put this environment's own BACKUP_TOKEN in it, or set ` +
        'COCKPIT_BACKUP_TOKEN for a one-off.',
    );
  }
  throw new Error(
    `${CONFIG_FILE} has no token for ${environment}. It needs the same value as that ` +
      "environment's own BACKUP_TOKEN.",
  );
}

/**
 * The workers.dev subdomain a deployed environment's address is built from.
 *
 * Not a secret; why it lives in the same file as the tokens is in
 * `backup-tokens.example.json`'s `$comment`, rather than here.
 */
export function resolveSubdomain({ config, env = {} }) {
  return env.CLOUDFLARE_WORKERS_SUBDOMAIN || config?.subdomain;
}
