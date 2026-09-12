//
// The I/O around scripts/lib/backup.mjs, for `pnpm backup:export`. Everything
// that decides anything is in the module, which node --test covers in the
// Scripts step; this fetches, writes files, prints and sets an exit code, so
// there is nothing here for a test to hold.
//
// Usage:
//   pnpm backup:export --env production --out ./backups/2026-09-06
//   pnpm backup:export --env production --out ./backups/anna --user tenant-anna
//
// The operator secret is that environment's own BACKUP_TOKEN, read from
// backup-tokens.json so that naming the environment is the whole of what
// somebody does. Why it is a file rather than a variable is in
// docs/deployment.md, "Secrets and access", rather than here.
//

import { mkdir, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { addressOf, readArguments, readRefusal, takeBackup } from './lib/backup.mjs';
import { readConfig, resolveSubdomain, resolveToken } from './lib/operator-config.mjs';
import { isLinkedWorktree, portsFor } from './lib/ports.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let args;
try {
  args = readArguments(process.argv.slice(2));
} catch (error) {
  console.error(`${error.message}

  pnpm backup:export --env <local|staging|production> --out <directory> [--user <account>]`);
  process.exit(2);
}

let secret;
let base;
try {
  const config = readConfig(root);
  secret = resolveToken(args.environment, { config, env: process.env });
  // The local port is never written down: a linked worktree gets its own,
  // derived from its path, which is what lets several run at once.
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

/**
 * Nothing appears where the backup was asked for until all of it has been read.
 * The staging directory is beside it rather than in a temporary folder, so that
 * settling is a rename within one filesystem - which is the part that happens
 * all at once.
 */
const files = {
  async stage(out) {
    const staged = `${out}.partial`;
    // Refused rather than cleared away. What an interrupted run left there is
    // evidence about how far it got, and this command is otherwise the one
    // thing in the system that destroys nothing - a silent `rm -rf` of a path
    // derived from what somebody typed would be a poor exception to that.
    if (existsSync(staged)) {
      throw new Error(
        `${staged} is already there, left by a run that did not finish. Look at it or remove it, then try again.`,
      );
    }
    await mkdir(`${staged}/accounts`, { recursive: true });
    return staged;
  },
  async write(path, contents) {
    await writeFile(path, `${JSON.stringify(contents, null, 2)}\n`, 'utf8');
  },
  async settle(staged, out) {
    await rename(staged, out);
  },
};

// Against the directory the command was run from, never against the repository
// root. `resolve` only falls back to the working directory while the path it
// has built is still relative, so passing an absolute `root` first silently
// anchored every relative `--out` inside the checkout - and both documented
// invocations pass a relative one. A backup holds every user's address and
// Google identity and every account's rows, and this is a public repository, so
// that put real data one `git add -A` from being committed. `.gitignore` now
// names the two paths as well; this is the half that stops them being created
// there at all.
const out = resolve(args.out);
if (existsSync(out)) {
  console.error(`${out} is already there. Backups are not written over; name a new directory.`);
  process.exit(2);
}

try {
  const { accounts } = await takeBackup({
    ask,
    files,
    out,
    only: args.user,
    environment: args.environment,
  });
  const rows = accounts.reduce((total, account) => total + account.rows, 0);
  console.log(
    `Backed up ${accounts.length} account${accounts.length === 1 ? '' : 's'} ` +
      `(${rows} row${rows === 1 ? '' : 's'}) from ${args.environment} to ${out}`,
  );
  for (const account of accounts) {
    console.log(`  ${account.account}: ${account.rows} rows`);
  }
} catch (error) {
  console.error(error.message);
  // What was read is left in `<out>.partial` rather than deleted, because it is
  // evidence about how far it got - and it is not where anybody will mistake it
  // for a backup.
  process.exit(1);
}
