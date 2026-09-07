//
// The I/O around scripts/lib/restore.mjs, for `pnpm backup:restore`. Everything
// that decides anything is in the module, which node --test covers in the
// Scripts CI job; this reads files, asks, confirms, prints and sets an exit
// code.
//
// Usage:
//   pnpm backup:restore --env local --from ./backups/2026-09-06
//   pnpm backup:restore --env local --from ./backups/anna --user tenant-anna
//   pnpm backup:restore --env staging --from ./backups/2026-09-06 --force
//
// This is the half that destroys something. Restoring over staging or
// production has to be confirmed by typing the environment's name, because both
// hold the only copy of something real (docs/deployment.md, "The environments").
//

import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { addressOf } from './lib/backup.mjs';
import {
  needsSayingOutLoud,
  putBack,
  readArguments,
  readBackup,
  readRefusal,
} from './lib/restore.mjs';
import { readConfig, resolveSubdomain, resolveToken } from './lib/operator-config.mjs';
import { isLinkedWorktree, portsFor } from './lib/ports.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let args;
try {
  args = readArguments(process.argv.slice(2));
} catch (error) {
  console.error(`${error.message}

  pnpm backup:restore --env <local|staging|production> --from <directory> [--user <account>] [--force]`);
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

// Against the working directory, never the checkout - the same reason
// backup-export.mjs resolves its --out that way.
const from = resolve(args.from);
if (!existsSync(from)) {
  console.error(`${from} is not there.`);
  process.exit(2);
}

let backup;
try {
  backup = readBackup({
    manifest: await readJson(join(from, 'manifest.json')),
    register: await readJson(join(from, 'register.json')),
    accounts: await readAccounts(join(from, 'accounts')),
  });
} catch (error) {
  console.error(error.message);
  process.exit(2);
}

const wanted = args.user ? [args.user] : Object.keys(backup.accounts);
console.log(
  `About to restore ${wanted.length} account${wanted.length === 1 ? '' : 's'} ` +
    `(${wanted.join(', ')}) from ${backup.manifest.environment} taken ${backup.manifest.takenAt}\n` +
    `into ${args.environment} at ${base}.` +
    (args.force ? '\n\n--force: whatever those accounts hold now will be replaced.' : ''),
);

if (needsSayingOutLoud(args.environment) && !(await confirmed(args.environment))) {
  console.error('Nothing was restored.');
  process.exit(2);
}

try {
  const done = await putBack({
    ask,
    backup,
    only: args.user,
    force: args.force,
    say: (line) => console.log(line),
  });
  console.log(
    `Restored ${done.accounts.length} account${done.accounts.length === 1 ? '' : 's'} into ` +
      `${args.environment}; register gained ${done.accountsCreated} account(s) and ` +
      `${done.usersCreated} user(s).`,
  );
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

/** One write to an operator route, or the reason it did not happen. */
async function ask(path, body) {
  let answer;
  try {
    const response = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      redirect: 'manual',
    });
    answer = { status: response.status, body: await response.text() };
  } catch {
    answer = { status: 0, body: '' };
  }
  if (answer.status !== 200) throw new Error(readRefusal(answer, path));
  return JSON.parse(answer.body);
}

/**
 * Typing the environment's name, which is the point: a prompt answered with
 * "yes" is answered the same way by somebody who misread which environment this
 * was.
 */
async function confirmed(environment) {
  const asking = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const said = await asking.question(`\nType ${environment} to confirm: `);
    return said.trim() === environment;
  } finally {
    asking.close();
  }
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function readAccounts(directory) {
  const accounts = {};
  for (const entry of await readdir(directory)) {
    if (!entry.endsWith('.json')) continue;
    accounts[entry.slice(0, -'.json'.length)] = await readJson(join(directory, entry));
  }
  return accounts;
}
