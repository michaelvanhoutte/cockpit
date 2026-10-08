//
// The I/O around scripts/lib/usage.mjs, for `pnpm usage:export`. Everything
// that decides anything is in the module, which node --test covers in the
// Scripts step; this fetches, prints and sets an exit code.
//
// Usage:
//   pnpm usage:export --env production --days 30 --out ./usage/2026-10.csv
//
// The operator secret and the address come from backup-tokens.json exactly as
// they do for the backup commands (docs/deployment.md, "Secrets and access").
//

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { addressOf, readRefusal } from './lib/backup.mjs';
import { readConfig, resolveSubdomain, resolveToken } from './lib/operator-config.mjs';
import { isLinkedWorktree, portsFor } from './lib/ports.mjs';
import { exportUsage, prepareExport, readArguments } from './lib/usage.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let args;
try {
  args = readArguments(process.argv.slice(2));
} catch (error) {
  console.error(`${error.message}

  pnpm usage:export --env <local|staging|production> --days <1-365> --out <file.csv>`);
  process.exit(2);
}

let secret;
let base;
try {
  const config = readConfig(root);
  secret = resolveToken(args.environment, { config, env: process.env });
  const local =
    args.environment === 'local'
      ? portsFor(root, { linked: isLinkedWorktree(root), env: process.env })
      : {};
  base = addressOf(args.environment, {
    subdomain: resolveSubdomain({ config, env: process.env }),
    apiPort: local.devApi,
  });
} catch (error) {
  console.error(error.message);
  process.exit(2);
}

/** One read from an operator route, or the reason it did not answer. */
async function ask(path) {
  let answer;
  try {
    const response = await fetch(`${base}${path}`, {
      headers: { authorization: `Bearer ${secret}` },
      redirect: 'manual',
    });
    answer = { status: response.status, body: await response.text() };
  } catch {
    answer = { status: 0, body: '' };
  }
  if (answer.status !== 200) throw new Error(readRefusal(answer));
  return JSON.parse(answer.body);
}

// Against the directory the command was run from, never the repository root: the
// records name users, and this is a public repository.
const out = resolve(args.out);
let place;
try {
  place = await prepareExport({ out });
} catch (error) {
  console.error(error.message);
  process.exit(2);
}

try {
  const { records } = await exportUsage({ ask, write: place.write, days: args.days });
  console.log(
    `Exported ${records} record${records === 1 ? '' : 's'} from the last ${args.days} day${args.days === 1 ? '' : 's'} of ${args.environment} to ${out}`,
  );
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
