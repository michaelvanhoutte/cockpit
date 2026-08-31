#!/usr/bin/env node
//
// Start Cockpit locally with one command: `pnpm dev`.
//
// The testing strategy's definition of done requires that the application be
// started and the changed behaviour actually exercised before anything is
// claimed to work, and its enforcement section asks for the one-command way to
// do that to be written down. Four steps across two terminals is the kind of
// friction that turns "start the app" into "the unit tests passed", so this
// collapses them into one command that is safe to re-run.
//
// What it does, in order:
//   1. Applies D1 migrations locally, then the seed. Both are idempotent
//      (`migrations apply` skips what it has already run, seed.sql is
//      INSERT OR IGNORE), so this runs on every start rather than being a
//      one-time step someone has to remember or a state file that can lie.
//      Both are about the register - which accounts exist. An account's own
//      data lives in a Durable Object that no command line can reach, and
//      brings itself up to date on the first request that opens it.
//   2. Builds apps/web/dist if it is missing. Wrangler refuses to start when
//      the assets directory in wrangler.jsonc does not exist. Only existence
//      matters here — the SPA is served by Vite on :5173 during development,
//      so a stale dist is fine and rebuilding it on every start is not worth
//      the wait. `pnpm build` when a real one is needed.
//   3. Runs the API and the web dev server together, output prefixed per
//      process, either one exiting or Ctrl+C bringing down both.
//
// This database is yours: what you capture while clicking around stays until
// you delete apps/api/.wrangler. The browser tests deliberately do not touch
// it — they run their own stack on their own ports against a database rebuilt
// per run (scripts/e2e-stack.mjs) — so a test run can never disturb what you
// are looking at, and what you are looking at can never make a test pass or
// fail.
//
// Node rather than bash, unlike the other scripts here: those run in CI on
// Ubuntu, this one runs on whatever the developer is using, and on Windows a
// bash script invoked through a pnpm script depends on which shell pnpm picks.
// Node is already a hard requirement (>=22) and needs no dependency to do this.

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { paint, run, start, supervise } from './lib/processes.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

try {
  await run(['--filter', '@cockpit/api', 'db:migrate:local'], 'applying migrations', root);
  await run(['--filter', '@cockpit/api', 'db:seed:local'], 'seeding', root);

  if (!existsSync(join(root, 'apps/web/dist/index.html'))) {
    console.log(paint('2', '  apps/web/dist is missing; Wrangler needs it to start'));
    await run(['build'], 'building', root);
  }
} catch (error) {
  console.error(paint('31', `\n${error.message}`));
  process.exit(1);
}

console.log(
  `\n${paint('36', 'api')} http://localhost:8787   ${paint('35', 'web')} http://localhost:5173   (Ctrl+C to stop both)\n`,
);

supervise([
  start(['--filter', '@cockpit/api', 'dev'], 'api', '36', root),
  start(['--filter', '@cockpit/web', 'dev'], 'web', '35', root),
]);
