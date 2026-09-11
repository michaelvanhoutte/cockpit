//
// The I/O around scripts/lib/guest-reset.mjs, for `pnpm guest:reset`: reads the
// arguments, asks the environment, prints what it said and sets an exit code.
//
// Usage:
//   pnpm guest:reset --env local
//   pnpm guest:reset --env production
//
// The operator secret and the address come from backup-tokens.json exactly as
// they do for the backup commands (docs/deployment.md, "Secrets and access").
//

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { addressOf } from './lib/backup.mjs';
import { RESET_PATH, readArguments } from './lib/guest-reset.mjs';
import { readAnswer } from './lib/operator.mjs';
import { readConfig, resolveSubdomain, resolveToken } from './lib/operator-config.mjs';
import { isLinkedWorktree, portsFor } from './lib/ports.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let args;
try {
  args = readArguments(process.argv.slice(2));
} catch (error) {
  console.error(`${error.message}

  pnpm guest:reset --env <local|staging|production>`);
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

let answer;
try {
  const response = await fetch(`${base}${RESET_PATH}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${secret}` },
    redirect: 'manual',
  });
  answer = { status: response.status, body: await response.text() };
} catch {
  answer = { status: 0, body: '' };
}

if (answer.status !== 200) {
  console.error(readAnswer(answer));
  process.exit(1);
}
console.log(`The guest account on ${args.environment} is back to its demonstration.`);
