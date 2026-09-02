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
//      matters here — the SPA is served by Vite during development,
//      so a stale dist is fine and rebuilding it on every start is not worth
//      the wait. `pnpm build` when a real one is needed.
//   3. Runs the API and the web dev server together, output prefixed per
//      process, either one exiting or Ctrl+C bringing down both.
//
// **Which ports depends on the checkout** (scripts/lib/ports.mjs). Several git
// worktrees of this repository are usually open at once, one per piece of work,
// and every one of them wants to run this. Nothing else about them collides -
// each has its own database under apps/api/.wrangler - so only the ports had to
// move: the primary checkout keeps :5173 and :8787, the ones the readme names,
// and a linked worktree gets a pair derived from its own path, the same pair
// every time. The line below prints whichever this is.
//
// The two ports are checked *before* the migrations rather than left to the
// servers to discover, for two reasons. A port held by a server an interrupted
// run left behind is the common case, and finding out after a minute of
// migrating and building is a minute spent on an answer that was available
// immediately. And Vite, left to itself, moves to the next free port and says
// so quietly - which would leave the address printed below serving nothing and
// the API proxy pointing at another worktree's Wrangler.
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

import { halvesToRun, paint, run, start, supervise } from './lib/processes.mjs';
import { howToFreeThePort, isLinkedWorktree, portsFor } from './lib/ports.mjs';
import { assertPortFree } from './lib/stack.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Which halves to run, and on which ports. `pnpm dev:api` and `pnpm dev:web`
 * pass `--only` and get one half each; they skip the migrations, the seed and
 * the build below, as they always have, being for restarting one half of a
 * stack that is already set up.
 *
 * Both decisions live in scripts/lib, where they are asserted without starting
 * anything: this file is orchestration only.
 */
let running;
let ports;
try {
  running = halvesToRun(process.argv);
  ports = portsFor(root, { linked: isLinkedWorktree(root), env: process.env });
} catch (error) {
  console.error(paint('31', `\n${error.message}`));
  process.exit(1);
}
const { only } = running;

try {
  if (running.api) {
    await assertPortFree(ports.devApi, 'API', () => howToFreeThePort('devApi', ports.devApi));
  }
  if (running.web) {
    await assertPortFree(ports.devWeb, 'web server', () => howToFreeThePort('devWeb', ports.devWeb));
  }

  if (only === null) {
    await run(['--filter', '@cockpit/api', 'db:migrate:local'], 'applying migrations', root);
    await run(['--filter', '@cockpit/api', 'db:seed:local'], 'seeding', root);

    if (!existsSync(join(root, 'apps/web/dist/index.html'))) {
      console.log(paint('2', '  apps/web/dist is missing; Wrangler needs it to start'));
      await run(['build'], 'building', root);
    }
  }
} catch (error) {
  console.error(paint('31', `\n${error.message}`));
  process.exit(1);
}

const addresses = [
  running.api ? `${paint('36', 'api')} http://localhost:${ports.devApi}` : null,
  running.web ? `${paint('35', 'web')} http://localhost:${ports.devWeb}` : null,
].filter(Boolean);
console.log(`\n${addresses.join('   ')}   (Ctrl+C to stop)\n`);

const halves = [];
if (running.api) {
  halves.push(
    start(
      ['--filter', '@cockpit/api', 'exec', 'wrangler', 'dev', '--port', String(ports.devApi)],
      'api',
      '36',
      root,
    ),
  );
}
if (running.web) {
  // `--strictPort` so a busy port fails rather than quietly moving to another
  // one, which would leave the address printed above serving nothing. And
  // COCKPIT_API_ORIGIN so this Vite proxies to *this* worktree's Wrangler
  // rather than to whichever checkout happens to hold the default port - which
  // is the whole reason `pnpm dev:web` comes through this file rather than
  // running `vite` directly.
  halves.push(
    start(
      ['--filter', '@cockpit/web', 'exec', 'vite', '--port', String(ports.devWeb), '--strictPort'],
      'web',
      '35',
      root,
      { COCKPIT_API_ORIGIN: `http://127.0.0.1:${ports.devApi}` },
    ),
  );
}

supervise(halves);
