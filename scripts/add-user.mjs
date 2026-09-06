//
// The I/O around scripts/lib/add-user.mjs, for `pnpm user:add`. Everything that
// decides anything is in the module, which node --test covers in the Scripts CI
// job; this fetches, prints and sets an exit code, so there is nothing here for
// a test to hold.
//
// Usage:
//   pnpm user:add --name "Anna" --email anna@example.com
//   pnpm user:add --name "Anna" --email anna@example.com --env production
//
// Afterwards Anna signs in with that Google account and lands in an account of
// her own, which is empty. Nothing is deployed and nothing is edited: the
// register is the allowlist ("Sign in with Google, and retire the list of
// names", issue 196), so adding somebody to it is the whole operation.
//
// The operator secret comes from COCKPIT_BACKUP_TOKEN and is never a flag, so
// it does not end up in a shell history or in the output of `ps`. It is the
// same secret as the environment's own BACKUP_TOKEN (docs/deployment.md,
// "Secrets and access").
//

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { addUser, readArguments, readRefusal } from './lib/add-user.mjs';
import { addressOf } from './lib/backup.mjs';
import { isLinkedWorktree, portsFor } from './lib/ports.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let args;
try {
  args = readArguments(process.argv.slice(2));
} catch (error) {
  console.error(`${error.message}

  pnpm user:add --name <name> --email <address> [--env <local|staging|production>]`);
  process.exit(2);
}

const secret = process.env.COCKPIT_BACKUP_TOKEN;
if (!secret) {
  console.error(
    'COCKPIT_BACKUP_TOKEN is not set. It is the environment’s own BACKUP_TOKEN, the secret\n' +
      'the operator routes are behind - put one there with `wrangler secret put BACKUP_TOKEN`,\n' +
      'or locally in apps/api/.dev.vars (copy .dev.vars.example).',
  );
  process.exit(2);
}

let base;
try {
  // The local port is never written down: a linked worktree gets its own,
  // derived from its path, which is what lets several run at once.
  const local =
    args.environment === 'local'
      ? portsFor(root, { linked: isLinkedWorktree(root), env: process.env })
      : {};
  base = addressOf(args.environment, {
    subdomain: process.env.CLOUDFLARE_WORKERS_SUBDOMAIN,
    apiPort: local.devApi,
  });
} catch (error) {
  console.error(error.message);
  process.exit(2);
}

/** One call to an operator route, or the reason it did not answer. */
async function call(path, body) {
  let answer;
  try {
    const response = await fetch(`${base}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        authorization: `Bearer ${secret}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual',
    });
    answer = { status: response.status, body: await response.text() };
  } catch {
    answer = { status: 0, body: '' };
  }
  if (answer.status !== 200) throw new Error(readRefusal(answer));
  return JSON.parse(answer.body);
}

try {
  const added = await addUser({
    read: (path) => call(path),
    write: (path, body) => call(path, body),
    name: args.name,
    email: args.email,
  });
  console.log(
    `Added ${added.name} to ${args.environment} at ${base}\n` +
      `  user:    ${added.user}\n` +
      `  account: ${added.account}\n` +
      `  signs in as: ${added.address}\n\n` +
      'Their account is empty until they open it - the workspaces every account starts with are\n' +
      'made by the first request that opens the store, which is their first sign-in.',
  );
} catch (error) {
  // The message is printed whole rather than summarised, because it is the only
  // thing that says what was written. One request is atomic and the *operation*
  // is not: the route decides which of the two rows are missing before it writes
  // them, so a race that creates the account first lands the user row alone -
  // committed, and nobody can put it back. `whatHappenedInstead` in
  // scripts/lib/add-user.mjs is what names that, and this is where it is read.
  console.error(error.message);
  process.exit(1);
}
