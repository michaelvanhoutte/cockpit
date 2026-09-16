//
// The I/O around scripts/lib/duplicates-backfill.mjs, for
// `pnpm duplicates:backfill`. Everything that decides anything is in the
// module, which node --test covers in the Scripts step; this asks, confirms,
// prints and sets an exit code.
//
// Usage:
//   pnpm duplicates:backfill --env local
//   pnpm duplicates:backfill --env production --user tenant-anna
//   pnpm duplicates:backfill --env production --batch 50 --stop-after 500
//
// It reads the notes that were already in the Inbox when duplicate flagging
// shipped, and works out which of them say the same thing. It adds only: what a
// note means and which notes repeat each other. The notes themselves are never
// written, so a run that stops has done part of the work and destroyed none of
// it, and running it again finishes the rest at no cost for what was done.
//
// The operator secret and the address come from backup-tokens.json exactly as
// they do for the backup commands (docs/deployment.md, "Secrets and access").
//

import { createInterface } from 'node:readline/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { addressOf } from './lib/backup.mjs';
import { ACCOUNTS_PATH, backfill, readArguments, readRefusal } from './lib/duplicates-backfill.mjs';
import { needsSayingOutLoud } from './lib/operator.mjs';
import { readConfig, resolveSubdomain, resolveToken } from './lib/operator-config.mjs';
import { isLinkedWorktree, portsFor } from './lib/ports.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let args;
try {
  args = readArguments(process.argv.slice(2));
} catch (error) {
  console.error(`${error.message}

  pnpm duplicates:backfill --env <local|staging|production> [--user <account>] [--batch <items>] [--stop-after <items>]`);
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

console.log(
  `About to read ${args.user ? `${args.user}'s` : 'every account’s'} unread notes in ` +
    `${args.environment} at ${base}.\n` +
    'It writes what those notes mean and which of them repeat each other, and nothing else.' +
    (args.stopAfter === undefined ? '' : `\nStopping after ${args.stopAfter} notes.`),
);

// The same prompt a restore asks, and for the same reason: both deployed
// environments hold real data, and this one spends a model call per note there.
// It adds rather than replaces, so what a mistaken run costs is an allocation
// rather than somebody's data.
if (needsSayingOutLoud(args.environment) && !(await confirmed(args.environment))) {
  console.error('Nothing was read.');
  process.exit(2);
}

try {
  const done = await backfill({
    ask,
    only: args.user,
    batch: args.batch,
    stopAfter: args.stopAfter,
    say: (line) => console.log(line),
  });
  const left = done.accounts.filter((one) => !one.finished);
  console.log(
    `Read ${done.read} note${done.read === 1 ? '' : 's'} across ` +
      `${done.accounts.length} account${done.accounts.length === 1 ? '' : 's'} in ${args.environment}.`,
  );
  if (left.length > 0) {
    console.log(
      `Not finished: ${left.map((one) => one.account).join(', ')}. Run it again to carry on - ` +
        'a note that has been read is never read twice.',
    );
  }
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

/** One call to an operator route, or the reason it did not happen. */
async function ask(path) {
  let answer;
  try {
    const response = await fetch(`${base}${path}`, {
      // The listing reads and every other path here writes.
      method: path === ACCOUNTS_PATH ? 'GET' : 'POST',
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

/** The environment typed out, for the reason `pnpm backup:restore` asks for it. */
async function confirmed(environment) {
  const asking = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const said = await asking.question(`\nType ${environment} to confirm: `);
    return said.trim() === environment;
  } finally {
    asking.close();
  }
}
